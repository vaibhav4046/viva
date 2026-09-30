import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * /api/health/ready published two renderings of one fact from two different
 * database samples.
 *
 * Observed in production on 2026-09-28:
 *
 *   {"ready":true,"durable":true,"degraded":false,
 *    "database":{"ok":false,"durable":false,"backend":"postgres","detail":"unreachable"},
 *    "store":{"mode":"ephemeral"}}
 *
 * `database.durable` false, `store.mode` ephemeral, and a top-level
 * `durable: true` / `degraded: false`, all in one response. The route called
 * `dbStatus()` and then `storeDurability()`, which called `dbStatus()` again;
 * against a flapping pool the second sample disagreed with the first.
 *
 * This is the worst possible place for the bug: the endpoint exists to publish
 * honest dependency disclosure, and the README quotes its `durable` field as
 * proof that a learner map survives a redeploy.
 */

const REASON = "storeDurability() must not re-probe a database the caller already probed";

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

/** A readiness response built the way the route builds it. */
type ReadyBody = {
  durable: boolean;
  degraded: boolean;
  database: { ok: boolean; durable: boolean; detail: string };
  store: { mode: string };
};

/** Loads the real route with `dbStatus` stubbed to a fixed answer. */
async function readinessWith(
  dbAnswers: Array<{ ok: boolean; durable: boolean; backend: string; detail: string }>,
) {
  let call = 0;
  const seen: number[] = [];

  vi.doMock("@/lib/db/db", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return {
      ...actual,
      dbStatus: vi.fn(async () => {
        seen.push(call);
        const answer = dbAnswers[Math.min(call, dbAnswers.length - 1)];
        call += 1;
        return answer;
      }),
    };
  });

  const route = (await import("@/app/api/health/ready/route")) as {
    GET: () => Promise<Response>;
  };
  const response = await route.GET();
  return { body: (await response.json()) as ReadyBody, probeCount: call, seen };
}

const UP = { ok: true, durable: true, backend: "postgres", detail: "reachable, schema present" };
const DOWN = { ok: false, durable: false, backend: "postgres", detail: "unreachable" };

describe("readiness publishes one coherent answer", () => {
  it("probes the database exactly once per request", async () => {
    const { probeCount } = await readinessWith([UP]);
    expect(probeCount, REASON).toBe(1);
  });

  it("keeps the top-level durable flag equal to the database answer when the db is up", async () => {
    const { body } = await readinessWith([UP]);
    expect(body.database.ok).toBe(true);
    expect(body.durable).toBe(true);
    expect(body.degraded).toBe(false);
    expect(body.store.mode).toBe("durable");
  });

  it("keeps the top-level durable flag equal to the database answer when the db is down", async () => {
    const { body } = await readinessWith([DOWN]);
    expect(body.database.ok).toBe(false);
    // The regression: this used to read `true` from a second, luckier probe.
    expect(body.durable, "durable contradicted the database block it was published beside").toBe(false);
    expect(body.degraded, "an unreachable database is degraded").toBe(true);
    expect(body.store.mode).toBe("ephemeral");
  });

  it("cannot contradict itself when the database flaps between samples", async () => {
    // If the route still probed twice, the first answer (down) would be
    // published in `database` while the second (up) produced `durable: true`.
    const { body } = await readinessWith([DOWN, UP]);
    expect(body.database.ok).toBe(false);
    expect(body.durable, "a flapping pool must not produce a confident durable:true").toBe(false);
    expect(body.degraded).toBe(true);
  });

  it("cannot contradict itself when the database flaps the other way", async () => {
    const { body } = await readinessWith([UP, DOWN]);
    expect(body.database.ok).toBe(true);
    expect(body.durable, "one good sample must not out-vote the published one").toBe(true);
    expect(body.degraded).toBe(false);
  });
});

describe("storeDurability reuses a caller's probe", () => {
  type Known = { ok: boolean; durable: boolean; backend: string; detail: string };

  it("does not re-probe when handed a known answer", async () => {
    const known: Known = { ok: true, durable: true, backend: "postgres", detail: "reachable, schema present" };
    const dbStatus = vi.fn(async () => known);
    vi.doMock("@/lib/db/db", async (importOriginal) => ({
      ...((await importOriginal()) as Record<string, unknown>),
      dbStatus,
    }));

    const { storeDurability } = (await import("@/lib/store")) as {
      storeDurability: (known?: Known) => Promise<{ durable: boolean }>;
    };
    const result = await storeDurability(known);

    expect(dbStatus, REASON).not.toHaveBeenCalled();
    expect(result.durable).toBe(true);
  });

  it("still probes on its own when given nothing", async () => {
    const known: Known = { ok: true, durable: true, backend: "postgres", detail: "reachable, schema present" };
    const dbStatus = vi.fn(async () => known);
    vi.doMock("@/lib/db/db", async (importOriginal) => ({
      ...((await importOriginal()) as Record<string, unknown>),
      dbStatus,
    }));

    const { storeDurability } = (await import("@/lib/store")) as {
      storeDurability: (known?: Known) => Promise<{ durable: boolean }>;
    };
    const result = await storeDurability();

    expect(dbStatus).toHaveBeenCalledTimes(1);
    expect(result.durable).toBe(true);
  });
});
