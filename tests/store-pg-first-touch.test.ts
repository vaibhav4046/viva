import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_COURSE_ID } from "@/lib/courses";
import { PgEventStore } from "@/lib/store/pg";
import type { RecordInput } from "@/lib/store/repo";

/**
 * Two events arriving at once on a concept the learner has never touched.
 *
 * `recordLearning` reads `mastery_state` with `SELECT ... FOR UPDATE` and writes
 * it back with `INSERT ... ON CONFLICT DO UPDATE ... EXCLUDED.*`. A row lock
 * protects that read-modify-write only when there is a row to lock: on the very
 * first event for a concept the SELECT matches nothing, locks nothing, and both
 * transactions start from a blank state. The second write then replaces the
 * first with values computed from that same blank state, so one graded event
 * disappears — its counts and its delta with it.
 *
 * No database here, and none needed: the defect is in the order of the
 * statements, not in Postgres. The fake models exactly the two rules that decide
 * the outcome, and nothing else:
 *
 *   1. `SELECT ... FOR UPDATE` on a key with no row takes no lock, so it cannot
 *      make a second transaction wait.
 *   2. An INSERT whose key collides with another transaction's uncommitted row
 *      waits for that transaction to finish before deciding what to do — true of
 *      `ON CONFLICT DO NOTHING` and of `DO UPDATE` alike.
 *
 * Its ceiling: it shows the statement order serialises under those two rules. It
 * is not a claim about Postgres itself — snapshots, real lock queues and
 * deadlock detection are all out of scope, and only a live database proves
 * those. What it does catch is the lost update, which is the whole of what this
 * file is for.
 *
 * The interleaving is forced by a two-party barrier, not by timers, so the case
 * cannot go green because one transaction happened to finish first.
 */

type Row = Record<string, unknown>;

const world = vi.hoisted(() => {
  const committed = new Map<string, Record<string, unknown>>();
  const log: { sql: string; params: unknown[] }[] = [];
  let parties = 0;
  let waiters: (() => void)[] = [];
  return {
    committed,
    log,
    /** Hold the next `n` transactions at their first mastery_state statement. */
    arm(n: number) { parties = n; },
    barrier(): Promise<void> {
      if (parties < 2) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waiters.push(resolve);
        if (waiters.length >= parties) {
          const held = waiters;
          waiters = [];
          for (const r of held) r();
        }
      });
    },
    reset() {
      committed.clear();
      log.length = 0;
      parties = 0;
      waiters = [];
    },
  };
});

vi.mock("pg", () => {
  const key = (userId: unknown, conceptId: unknown) => `${userId} ${conceptId}`;

  /** Open transactions holding an uncommitted mastery_state row, by key. */
  const holders = new Map<string, Promise<void>>();

  const eventRow = (p: unknown[]): Row => ({
    id: "evt_fake", user_id: p[1], session_id: p[2], course_id: null, source_id: null,
    created_at: new Date(String(p[28] ?? "2026-09-13T00:00:00.000Z")),
    transcript: "t", cleaned_transcript: "t", origin: "voice", intent: p[12],
    concept_ids: [], primary_concept_id: p[14], importance: 0.5, confusion: 0.9,
    interpretation_confidence: 0.5, evidence_ids: [], requested_action: "explain", status: "grounded",
  });

  /** `$1..$13` of both mastery_state inserts, in the column order they declare. */
  const stateRow = (p: unknown[], version: number): Row => ({
    user_id: p[0], concept_id: p[1], exposure_count: p[2], successful_recall_count: p[3],
    failed_recall_count: p[4], confusion_count: p[5], misconception_count: p[6],
    teachback_score_avg: p[7], last_seen_at: new Date(String(p[8])),
    last_successful_recall_at: p[9] ? new Date(String(p[9])) : null,
    mastery: p[10], confidence: p[11], review_priority: p[12], version,
  });

  class Client {
    private pending = new Map<string, Row>();
    private finished!: () => void;
    private done = new Promise<void>((r) => { this.finished = r; });
    private barriered = false;

    private visible(k: string): Row | undefined {
      return this.pending.get(k) ?? world.committed.get(k);
    }

    query = async (sql: string, params: unknown[] = []) => {
      world.log.push({ sql, params });
      const s = sql.replace(/\s+/g, " ").trim();

      if (/^COMMIT/i.test(s)) {
        for (const [k, row] of this.pending) { world.committed.set(k, row); holders.delete(k); }
        this.pending.clear();
        this.finished();
        return { rows: [] as Row[] };
      }
      if (/^ROLLBACK/i.test(s)) {
        for (const k of this.pending.keys()) holders.delete(k);
        this.pending.clear();
        this.finished();
        return { rows: [] as Row[] };
      }
      if (/^BEGIN/i.test(s)) return { rows: [] as Row[] };
      if (/INSERT INTO learning_events/i.test(s)) return { rows: [eventRow(params)] };
      if (/INSERT INTO users/i.test(s) || /^UPDATE learning_events/i.test(s)) return { rows: [] as Row[] };

      if (/mastery_state/i.test(s) && !this.barriered) {
        this.barriered = true;
        await world.barrier();
      }

      if (/INSERT INTO mastery_state/i.test(s)) {
        const k = key(params[0], params[1]);
        const blank = /DO NOTHING/i.test(s);
        // Rule 2: a colliding uncommitted row makes this insert wait.
        while (!this.pending.has(k) && holders.has(k)) await holders.get(k);
        const existing = this.visible(k);
        if (existing && blank) return { rows: [] as Row[] };
        this.pending.set(k, stateRow(params, existing ? Number(existing.version ?? 0) + 1 : blank ? 0 : 1));
        if (!holders.has(k)) holders.set(k, this.done);
        return { rows: [] as Row[] };
      }

      if (/SELECT \* FROM mastery_state WHERE user_id=\$1 AND concept_id=\$2 FOR UPDATE/i.test(s)) {
        // Rule 1: no row, no lock — this statement cannot make anybody wait.
        const row = this.visible(key(params[0], params[1]));
        return { rows: row ? [row] : [] };
      }
      if (/SELECT \* FROM mastery_state WHERE user_id=\$1$/i.test(s)) {
        const seen = new Map<string, Row>();
        for (const [k, row] of world.committed) if (k.startsWith(`${params[0]} `)) seen.set(k, row);
        for (const [k, row] of this.pending) seen.set(k, row);
        return { rows: [...seen.values()] };
      }
      return { rows: [] as Row[] };
    };

    release() {
      for (const k of this.pending.keys()) holders.delete(k);
      this.pending.clear();
      this.finished();
    }
  }

  class Pool {
    query = async () => ({ rows: [] as Row[] });
    on() { return this; }
    async connect() { return new Client(); }
  }
  return { Pool };
});

const USER = `demo_${"f".repeat(32)}`;
const CONCEPT = "c_position";

function eventFor(k: string): RecordInput {
  return {
    idempotencyKey: k, sessionId: "sess_first_touch", courseId: DEFAULT_COURSE_ID, sourceId: null,
    transcript: "probe", cleanedTranscript: "probe", origin: "voice", transcriptionConfidence: 0.9,
    transcriptionLatencyMs: 100, transcriptionSessionId: null, intent: "confusion",
    conceptIds: [CONCEPT], primaryConceptId: CONCEPT, importance: 0.5, confusion: 0.9,
    interpretationConfidence: 0.8, evidenceIds: [], requestedAction: "explain",
    status: "grounded", sourceLocator: { section: "3" }, createdAt: "2026-09-13T00:00:00.000Z",
  };
}

let store: PgEventStore;
let previousUrl: string | undefined;

beforeAll(() => {
  previousUrl = process.env.DATABASE_URL;
  // getPool() refuses to build without one; the driver behind it is the fake.
  process.env.DATABASE_URL = "postgres://viva:viva@127.0.0.1:5432/never-dialled";
  store = new PgEventStore();
});
afterAll(() => {
  if (previousUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousUrl;
});
beforeEach(() => world.reset());

function storedState(): Record<string, unknown> | undefined {
  for (const [k, row] of world.committed) if (k.startsWith(`${USER} `)) return row;
  return undefined;
}

describe("two first events on one concept both survive", () => {
  it("keeps both events when neither has a row to lock yet", async () => {
    world.arm(2);
    await Promise.all([
      store.recordLearning(USER, eventFor("k_first_a")),
      store.recordLearning(USER, eventFor("k_first_b")),
    ]);
    const row = storedState();
    expect(row, "no mastery row was written at all").toBeDefined();
    expect(Number(row?.exposure_count), "one of the two events was overwritten").toBe(2);
    expect(Number(row?.confusion_count), "one event's counts were lost").toBe(2);
  });

  it("materialises the row before it reads it, so the lock has something to hold", async () => {
    await store.recordLearning(USER, eventFor("k_order"));
    const state = world.log
      .map((q) => q.sql.replace(/\s+/g, " ").trim())
      .filter((s) => /mastery_state/i.test(s));
    const materialise = state.findIndex((s) => /^INSERT INTO mastery_state/i.test(s) && /DO NOTHING/i.test(s));
    const locked = state.findIndex((s) => /FOR UPDATE/i.test(s));
    expect(locked, "nothing reads the row under a lock").toBeGreaterThan(-1);
    expect(materialise, "nothing materialises the row, so FOR UPDATE locks nothing").toBeGreaterThan(-1);
    expect(materialise, "the row is locked before it exists").toBeLessThan(locked);
  });

  it("a second event on an existing row still counts onto the stored numbers", async () => {
    await store.recordLearning(USER, eventFor("k_seq_a"));
    await store.recordLearning(USER, eventFor("k_seq_b"));
    expect(Number(storedState()?.exposure_count)).toBe(2);
  });
});
