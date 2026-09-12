import { afterEach, describe, expect, it } from "vitest";
import { resetStoreDegradation, storeDegradation, withFallback } from "@/lib/store";
import type { EventStore } from "@/lib/store/repo";

/**
 * The durable-to-ephemeral latch, which had zero tests — so the bug it shipped
 * with survived two rounds: after the latch flipped, every call went to the
 * file store while `store.backend` kept answering "postgres", and /api/learner
 * put that value in front of the student.
 */

/** A durable store that fails on demand and counts what reached it. */
function flaky(failAfter: number) {
  const calls: string[] = [];
  let n = 0;
  const stub = {
    backend: "postgres" as const,
    async listSubjects(userId: string) {
      calls.push(`listSubjects:${userId}`);
      n += 1;
      if (n > failAfter) throw new Error("ECONNREFUSED 10.0.0.1:5432");
      return [];
    },
    async ensureUser(userId: string) {
      calls.push(`ensureUser:${userId}`);
      n += 1;
      if (n > failAfter) throw new Error("ECONNREFUSED 10.0.0.1:5432");
    },
  };
  return { calls, store: withFallback(stub as unknown as EventStore, "postgres") };
}

afterEach(() => resetStoreDegradation());

describe("store degradation latch", () => {
  it("reports the durable backend until something fails", async () => {
    const { store } = flaky(5);
    expect(store.backend).toBe("postgres");
    expect(await store.listSubjects("u_ok")).toEqual([]);
    expect(storeDegradation().degraded).toBe(false);
    expect(store.backend).toBe("postgres");
  });

  it("moves reads to the fallback and stops claiming postgres", async () => {
    const { store, calls } = flaky(0);
    // The first call fails inside the durable store and is retried on the
    // fallback rather than surfacing a 500.
    expect(await store.listSubjects("u_latch")).toEqual([]);
    const state = storeDegradation();
    expect(state.degraded).toBe(true);
    expect(state.from).toBe("postgres");
    expect(state.reason).toMatch(/ECONNREFUSED/);
    // The whole point: the value clients are shown follows the data.
    expect(store.backend).toBe("file");
    // And nothing else is dispatched to the failed backend.
    const before = calls.length;
    await store.ensureUser("u_latch");
    await store.listSubjects("u_latch");
    expect(calls.length).toBe(before);
  });

  it("resetStoreDegradation clears the latch and the reported backend", async () => {
    const { store } = flaky(0);
    await store.listSubjects("u_reset");
    expect(store.backend).toBe("file");
    resetStoreDegradation();
    expect(storeDegradation().degraded).toBe(false);
    expect(store.backend).toBe("postgres");
  });
});
