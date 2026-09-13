import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { resetStoreDegradation, storeDegradation, withFallback } from "@/lib/store";
import type { EventStore } from "@/lib/store/repo";

/** Armed only by the route case below; every other test here gets the real store. */
const refuseDelete = vi.hoisted(() => ({ on: false }));

vi.mock("@/lib/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/store")>();
  return {
    ...actual,
    getStore: () =>
      refuseDelete.on
        ? ({
            async deleteUserData() {
              throw new Error("ECONNREFUSED 10.0.0.1:5432");
            },
          } as unknown as EventStore)
        : actual.getStore(),
  };
});

const { GET: learnerGet } = await import("@/app/api/learner/route");

/**
 * "Delete my data" has to be true or it has to be an error.
 *
 * The degradation latch sends every call to the ephemeral file store once the
 * durable backend has failed once. For reads and writes that is the whole
 * point — the demo keeps working. For a deletion it is the one thing the store
 * must never do: unlink a /tmp file, return 200, and leave every Postgres row
 * where it was, while the student is told they were forgotten.
 */

const DOWN = () => new Error("ECONNREFUSED 10.0.0.1:5432");

/** A durable store that fails on demand and records what reached it. */
function flaky(opts: { readsFailFrom?: number; deleteFails?: boolean } = {}) {
  const calls: string[] = [];
  let reads = 0;
  const stub = {
    backend: "postgres" as const,
    async listSubjects(userId: string) {
      calls.push(`listSubjects:${userId}`);
      reads += 1;
      if (opts.readsFailFrom !== undefined && reads >= opts.readsFailFrom) throw DOWN();
      return [];
    },
    async deleteUserData(userId: string) {
      calls.push(`deleteUserData:${userId}`);
      if (opts.deleteFails) throw DOWN();
    },
  };
  return { calls, store: withFallback(stub as unknown as EventStore, "postgres") };
}

// The fallback is a real FileEventStore, so keep its writes out of the repo.
let tmp: string;
beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "viva-delete-"));
  process.env.DATA_DIR = tmp;
});
afterAll(async () => {
  delete process.env.DATA_DIR;
  await fs.rm(tmp, { recursive: true, force: true });
});
afterEach(() => resetStoreDegradation());

describe("deleting a learner's data once the store has degraded", () => {
  it("still reaches the durable backend instead of only the ephemeral copy", async () => {
    const { store, calls } = flaky({ readsFailFrom: 2 });
    await store.listSubjects("u_gone"); // succeeds
    await store.listSubjects("u_gone"); // fails, latches
    expect(storeDegradation().degraded).toBe(true);

    await store.deleteUserData("u_gone");
    expect(calls).toContain("deleteUserData:u_gone");
  });

  it("reports a failed deletion as a failure rather than as success", async () => {
    const { store } = flaky({ readsFailFrom: 1, deleteFails: true });
    await store.listSubjects("u_stuck"); // fails, latches
    expect(storeDegradation().degraded).toBe(true);

    await expect(store.deleteUserData("u_stuck")).rejects.toThrow(/ECONNREFUSED/);
  });

  it("does not latch or swallow when the durable backend refuses a healthy delete", async () => {
    const { store } = flaky({ deleteFails: true });
    await expect(store.deleteUserData("u_first")).rejects.toThrow(/ECONNREFUSED/);
    // A refused deletion is not evidence that the whole instance should go
    // ephemeral — it is evidence that this deletion did not happen.
    expect(storeDegradation().degraded).toBe(false);
  });
});

/**
 * The same promise one level up: the student is told, in words they can read.
 *
 * The store now rejects a delete it could not do instead of pretending, and
 * the route let that rejection out as a bare 500 with no body. Loud was right;
 * unreadable was not. Every other route in this app answers a failure with
 * {error:{code,message,retryable}} and one plain sentence, so this one does
 * too — and the sentence says what actually happened, without naming a
 * backend the student has never heard of.
 */
describe("GET /api/learner?reset=1 when the deletion does not happen", () => {
  const reset = () =>
    learnerGet(new NextRequest("http://localhost/api/learner?reset=1"));

  afterEach(() => {
    refuseDelete.on = false;
  });

  it("answers with a code and a sentence, not a bare 500", async () => {
    refuseDelete.on = true;
    const res = await reset();
    expect(res.status).toBe(503);

    const body = await res.json();
    expect(body.error.code).toBe("RESET_FAILED");
    expect(body.error.retryable).toBe(true);
    // The student asked to be forgotten and was not. Say so, and say what to
    // do next; a student who is told nothing assumes it worked.
    expect(body.error.message).toMatch(/could not erase/i);
    expect(body.error.message).toMatch(/try again/i);
  });

  it("names no backend, no driver text and no status code", async () => {
    refuseDelete.on = true;
    const message: string = (await (await reset()).json()).error.message;
    for (const leak of ["ECONNREFUSED", "postgres", "Postgres", "database", "10.0.0.1", "5432", "500", "503"]) {
      expect(message, `the sentence names ${leak}`).not.toContain(leak);
    }
  });

  it("still answers 200 when the deletion does happen", async () => {
    // Without this the route could refuse every reset and both cases above
    // would still pass.
    expect((await reset()).status).toBe(200);
  });
});
