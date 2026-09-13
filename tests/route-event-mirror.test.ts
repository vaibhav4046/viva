import { promises as fs } from "fs";
import { readFileSync } from "node:fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { getCourse } from "@/lib/courses";
import { POST as examStart } from "@/app/api/exam/start/route";
import { POST as examAnswer } from "@/app/api/exam/answer/route";
import { POST as teachStart } from "@/app/api/teachback/start/route";
import { POST as teachAnswer } from "@/app/api/teachback/answer/route";
import { POST as learnerSync } from "@/app/api/learner/sync/route";

/**
 * A recall answered anywhere must survive the instance that graded it.
 *
 * Every write goes to one lambda's own /tmp, so the browser keeps its own copy
 * of each turn beside the id it posted and hands the log back to
 * `POST /api/learner/sync` on load — that replay is what makes a forgotten
 * recall come back. /study did it. /exam (both the quiz and teach-it-back) and
 * Today's inline recall each minted a `clientEventId`, posted it, and then
 * dropped the answer on the floor: nothing in the browser's record, nothing to
 * replay, nothing to defend the concept with when the server copy shrank. A
 * student judge answered questions, watched them register, and watched five of
 * six concepts go back to "Not yet".
 *
 * Two halves, because it took two things to break it: the routes never handed
 * the event back, and the three callers never asked for it.
 */

let currentUser = "u_mirror_default";
vi.mock("@/lib/auth/identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/identity")>();
  return { ...actual, resolveIdentity: async () => ({ identity: { userId: currentUser, kind: "demo" as const } }) };
});

const COURSE = getCourse("course_transformers_w4");

let tmp: string;
beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "viva-mirror-"));
  process.env.DATA_DIR = tmp;
  delete process.env.BLOB_READ_WRITE_TOKEN;
});
afterAll(async () => {
  delete process.env.DATA_DIR;
  await fs.rm(tmp, { recursive: true, force: true });
});

function post(url: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** What the store keeps for this user — deleting it is one forgetful lambda. */
async function forgetServerRecord(): Promise<void> {
  await fs.rm(path.join(tmp, `${currentUser.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`), { force: true });
}

type Recorded = { event?: { id?: string; intent?: string; transcript?: string; primaryConceptId?: string | null } };

describe("every mutating route hands the turn back", () => {
  it("POST /api/exam/answer returns the event it recorded", async () => {
    currentUser = "u_mirror_exam";
    const q = (await (await examStart(post("/api/exam/start", { courseId: COURSE.id }))).json()) as {
      id: string;
      conceptId: string;
    };
    const body = (await (
      await examAnswer(
        post("/api/exam/answer", {
          questionId: q.id,
          answer: "Attention is permutation-invariant, so an injected order signal is required.",
          clientEventId: "c_exam_1",
          courseId: COURSE.id,
        })
      )
    ).json()) as Recorded;
    // The shape src/lib/sync.ts replays: an id to merge on, an intent and the
    // words. Without these three the browser has nothing it can post back.
    expect(body.event?.id).toBeTruthy();
    expect(body.event?.intent).toBeTruthy();
    expect(body.event?.transcript).toBeTruthy();
    expect(body.event?.primaryConceptId).toBe(q.conceptId);
  });

  it("POST /api/teachback/answer returns the event it recorded", async () => {
    currentUser = "u_mirror_teach";
    const t = (await (await teachStart(post("/api/teachback/start", { courseId: COURSE.id }))).json()) as {
      conceptId: string;
    };
    const body = (await (
      await teachAnswer(
        post("/api/teachback/answer", {
          conceptId: t.conceptId,
          transcript: "Let me explain it back: attention compares every token with every other token.",
          clientEventId: "c_teach_1",
          courseId: COURSE.id,
        })
      )
    ).json()) as Recorded;
    expect(body.event?.id).toBeTruthy();
    expect(body.event?.intent).toBe("teachback");
    expect(body.event?.primaryConceptId).toBe(t.conceptId);
  });
});

describe("a quiz answer survives the server forgetting it", () => {
  it("replays back onto an empty store from the browser's copy", async () => {
    currentUser = "u_mirror_replay";
    const q = (await (await examStart(post("/api/exam/start", { courseId: COURSE.id }))).json()) as {
      id: string;
      conceptId: string;
    };
    const clientEventId = "c_replay_1";
    const answered = (await (
      await examAnswer(
        post("/api/exam/answer", {
          questionId: q.id,
          answer: "Attention is permutation-invariant, so an injected order signal is required.",
          clientEventId,
          courseId: COURSE.id,
        })
      )
    ).json()) as { event: Record<string, unknown>; mastery: Record<string, { exposureCount: number }> };

    expect(answered.mastery[q.conceptId]?.exposureCount).toBeGreaterThan(0);

    // What the browser writes down: the event, plus the id it posted.
    const mirrored = { ...answered.event, clientEventId };

    await forgetServerRecord();

    // Cold read of the wiped store: the recall is gone.
    const cold = (await (await learnerSync(post("/api/learner/sync", {}))).json()) as {
      mastery: Record<string, unknown>;
    };
    expect(cold.mastery[q.conceptId]).toBeUndefined();

    // The browser hands its copy back, which is what a page load does.
    const replayed = (await (await learnerSync(post("/api/learner/sync", { events: [mirrored] }))).json()) as {
      mastery: Record<string, { exposureCount: number }>;
      sync?: { events: { applied: number; duplicate: number } };
    };
    expect(replayed.sync?.events.applied).toBe(1);
    expect(replayed.mastery[q.conceptId]?.exposureCount).toBeGreaterThan(0);
  });
});

/**
 * The ratchet, so the next screen that posts a turn cannot forget this again.
 * Source-level because there is no DOM in this suite — the same trick
 * design-tokens.test.ts and typed-input.test.ts use.
 */
describe("every client path that posts a turn also writes it down", () => {
  const CLIENT_PATHS = [
    "../src/app/(app)/study/page.tsx",
    "../src/app/(app)/exam/page.tsx",
    "../src/components/today/InlineRecall.tsx",
  ];

  for (const rel of CLIENT_PATHS) {
    it(`${rel.replace("../src/", "")} mirrors what it posts`, () => {
      const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
      expect(src, "posts a clientEventId — this list is only for files that do").toContain("clientEventId");
      expect(src, "posted a turn without keeping the browser's copy").toContain("rememberEvent(");
      expect(src, "posted a turn without folding the map it came back with").toContain("rememberMastery(");
      // The id has to be the one that was posted, not a fresh one, or the
      // replay dedupes against nothing and the turn is counted twice.
      expect(src).not.toContain("clientEventId: crypto.randomUUID()");
    });
  }
});
