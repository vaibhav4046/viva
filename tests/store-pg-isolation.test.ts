import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_COURSE_ID } from "@/lib/courses";
import type { Subject } from "@/lib/courses/types";
import { PgEventStore } from "@/lib/store/pg";
import type { RecordInput } from "@/lib/store/repo";

/**
 * `PgEventStore` had no tests at all, and it is the store production runs:
 * `getStore()` picks Postgres whenever DATABASE_URL is set. Isolation in the
 * file store is structural — one JSON document per user — so `idor.test.ts`
 * says almost nothing about what actually serves students. Isolation in
 * Postgres is roughly thirty hand-written `user_id` predicates, and dropping
 * any one of them is the IDOR this project cares most about.
 *
 * Why a fake `pg` and not the live Neon database in `.env.local`:
 *
 *  - A live test has to be gated, the way `assemblyai-live.test.ts` gates its
 *    live block, or the suite stops running without a network. Gated means the
 *    default gate never runs it — so a dropped predicate would still ship
 *    green, which is exactly the hole being closed here.
 *  - Against a live database, "B saw nothing of A's" is also satisfied when B
 *    simply has no rows. Telling that apart from real scoping needs both users
 *    seeded, migrated schema and cleanup on a shared database, and it still
 *    only covers the paths the scenario happens to walk.
 *  - The fake runs the real `dbQuery`, the real `getPool`, and every SQL
 *    string this class emits, on every commit, with no network.
 *
 * Its ceiling: it reads SQL, so it cannot catch a predicate that is present
 * but means the wrong thing at the database (a bad index, an RLS policy, a
 * column that is not the owner). It catches the mutation that matters — a
 * missing `WHERE user_id=$1` — and nothing here should be read as a claim
 * about Postgres semantics.
 */

type Statement = { sql: string; params: unknown[] };

const rec = vi.hoisted(() => ({ log: [] as { sql: string; params: unknown[] }[] }));

vi.mock("pg", () => {
  /**
   * `RETURNING *` on the events insert has to hand back a row or
   * `recordLearning` takes the duplicate branch and dereferences undefined.
   * Everything else answers empty, which is a cold user — the case where a
   * missing predicate would leak somebody else's rows in production.
   */
  const rowsFor = (sql: string, params: unknown[]): Record<string, unknown>[] =>
    /INSERT INTO learning_events/i.test(sql)
      ? [{
          id: "evt_fake", user_id: params[1], session_id: "sess_pg", course_id: null, source_id: null,
          created_at: new Date("2026-09-13T00:00:00.000Z"), transcript: "t", cleaned_transcript: "t",
          origin: "voice", intent: "confusion", concept_ids: [], primary_concept_id: null,
          importance: 0.5, confusion: 0.5, interpretation_confidence: 0.5, evidence_ids: [],
          requested_action: "explain", status: "grounded",
        }]
      : [];

  const query = async (sql: string, params: unknown[] = []) => {
    rec.log.push({ sql, params });
    return { rows: rowsFor(sql, params) };
  };

  class Pool {
    query = query;
    on() { return this; }
    async connect() { return { query, release() {} }; }
  }
  return { Pool };
});

/** Tables whose rows belong to one student. `users` is keyed BY the student. */
const OWNED = /\b(?:courses|sources|source_chunks|concepts|concept_edges|subjects|learning_events|mastery_state|review_queue|tutor_messages|product_events)\b/;

/** True when this statement was actually checked, so a case cannot pass empty. */
function expectScopedToOwner({ sql, params }: Statement, userId: string): boolean {
  const s = sql.replace(/\s+/g, " ").trim();
  if (!OWNED.test(s)) return false; // BEGIN/COMMIT, and the users row itself.
  expect(params, `owner not bound: ${s}`).toContain(userId);
  if (/^INSERT/i.test(s)) {
    const columns = s.slice(s.indexOf("(") + 1, s.indexOf(")"));
    expect(columns, `insert does not record an owner: ${s}`).toMatch(/\buser_id\b/);
    return true;
  }
  const where = s.search(/\bWHERE\b/i);
  expect(where, `unfiltered read or write: ${s}`).toBeGreaterThan(-1);
  expect(s.slice(where), `not scoped to the caller: ${s}`).toMatch(/\buser_id\s*=\s*\$\d/);
  return true;
}

const USER_A = `demo_${"a".repeat(32)}`;
const USER_B = `demo_${"b".repeat(32)}`;

function subjectFor(ownerId: string): Subject {
  return {
    id: "subj_pg_probe", code: "PG1", title: "Probe subject", subject: "Testing", demo: false,
    sources: [{
      id: "src_probe", title: "Probe notes", type: "notes",
      chunks: [{ id: "ch_probe", sourceId: "src_probe", ordinal: 1, text: "A passage.", locator: { section: "1" } }],
    }],
    concepts: [{ id: "c_probe", name: "Probe", aliases: [], description: "", related: ["c_other"] }],
    examQuestions: [], teachback: { keywords: {}, hints: {} }, explainers: {}, traps: [],
    ownerId, createdAt: "2026-09-13T00:00:00.000Z", origin: "paste", builtBy: "reading",
    keyterms: [], languageCodes: ["en"],
  };
}

const RECORD: RecordInput = {
  idempotencyKey: "k_pg_probe", sessionId: "sess_pg", courseId: DEFAULT_COURSE_ID, sourceId: null,
  transcript: "probe", cleanedTranscript: "probe", origin: "voice", transcriptionConfidence: 0.9,
  transcriptionLatencyMs: 100, transcriptionSessionId: null, intent: "confusion",
  conceptIds: ["c_position"], primaryConceptId: "c_position", importance: 0.5, confusion: 0.9,
  interpretationConfidence: 0.8, evidenceIds: ["ch_pos_1"], requestedAction: "explain",
  status: "grounded", sourceLocator: { section: "3" },
};

/**
 * Every EventStore method that reads or writes an owned table, with what it is
 * called with. `ensureUser` is deliberately absent: it only touches `users`,
 * whose primary key IS the owner, so a scoping assertion over it would check
 * nothing. It gets its own case below.
 */
const CALLS: { name: string; run: (s: PgEventStore, u: string) => Promise<unknown> }[] = [
  { name: "seedCourse", run: (s, u) => s.seedCourse(u, DEFAULT_COURSE_ID) },
  { name: "seedDemoCourse", run: (s, u) => s.seedDemoCourse(u) },
  { name: "saveSubject", run: (s, u) => s.saveSubject(u, subjectFor(u)) },
  { name: "getSubject", run: (s, u) => s.getSubject(u, "subj_pg_probe") },
  { name: "listSubjects", run: (s, u) => s.listSubjects(u) },
  { name: "recordLearning", run: (s, u) => s.recordLearning(u, RECORD) },
  { name: "listEvents", run: (s, u) => s.listEvents(u) },
  { name: "getMastery", run: (s, u) => s.getMastery(u) },
  { name: "getCourseChunks", run: (s, u) => s.getCourseChunks(u) },
  { name: "getConcepts", run: (s, u) => s.getConcepts(u) },
  { name: "retrieveEvidence", run: (s, u) => s.retrieveEvidence(u, "positional order") },
  { name: "enqueueReview", run: (s, u) => s.enqueueReview(u, "c_position", 0.8, "confused") },
  { name: "saveTutorMessage", run: (s, u) => s.saveTutorMessage(u, "sess_pg", "user", "hello", []) },
  { name: "getReviewQueue", run: (s, u) => s.getReviewQueue(u) },
  { name: "addSource", run: (s, u) => s.addSource(u, { title: "Upload", type: "notes", chunks: [{ text: "A chunk.", section: "1" }] }) },
  { name: "recordProductEvent", run: (s, u) => s.recordProductEvent(u, "study_turn") },
  { name: "productEventSummary", run: (s, u) => s.productEventSummary(u) },
  { name: "deleteUserData", run: (s, u) => s.deleteUserData(u) },
];

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
beforeEach(() => { rec.log.length = 0; });

async function capture(fn: () => Promise<unknown>): Promise<Statement[]> {
  rec.log.length = 0;
  await fn();
  return rec.log.slice();
}

describe("PgEventStore scopes every statement to one owner", () => {
  for (const call of CALLS) {
    it(`${call.name} carries a user_id predicate on every owned table`, async () => {
      const log = await capture(() => call.run(store, USER_A));
      let checked = 0;
      for (const statement of log) if (expectScopedToOwner(statement, USER_A)) checked += 1;
      // Without this the case passes when the method issues nothing, or only
      // statements the helper skips — the vacuum this whole file exists to
      // close, reappearing one level up.
      expect(checked, "no owned table was touched, so nothing was checked").toBeGreaterThan(0);
    });
  }

  it("the users row itself is keyed by the caller", async () => {
    const log = await capture(() => store.ensureUser(USER_A, "Demo learner"));
    expect(log).toHaveLength(1);
    expect(log[0].sql).toMatch(/^INSERT INTO users\(id,/);
    expect(log[0].params[0]).toBe(USER_A);
  });

  it("the owner is a bound parameter, never part of the statement", async () => {
    for (const call of CALLS) {
      const a = await capture(() => call.run(store, USER_A));
      const b = await capture(() => call.run(store, USER_B));
      // Identical SQL for two students: nothing about the caller is spliced
      // into the text, so no owner can be smuggled through a value.
      expect(b.map((q) => q.sql), call.name).toEqual(a.map((q) => q.sql));
      expect(JSON.stringify(a), `${call.name} bound the wrong owner`).not.toContain(USER_B);
      expect(JSON.stringify(b), `${call.name} bound the wrong owner`).not.toContain(USER_A);
    }
  });

  it("nothing reads or writes an owned table without naming an owner", async () => {
    for (const call of CALLS) {
      for (const { sql } of await capture(() => call.run(store, USER_A))) {
        const s = sql.replace(/\s+/g, " ").trim();
        if (!OWNED.test(s) || /^INSERT/i.test(s)) continue;
        expect(s, `${call.name} would touch every student's rows`).toMatch(/\buser_id\s*=\s*\$\d/);
      }
    }
  });

  it("deleting a student clears their rows by owner, and no one else's", async () => {
    const log = await capture(() => store.deleteUserData(USER_A));
    expect(log.some((q) => /DELETE FROM product_events/i.test(q.sql))).toBe(true);
    for (const { sql, params } of log) {
      expect(/DELETE/i.test(sql) ? params : [USER_A], sql).toContain(USER_A);
    }
  });
});
