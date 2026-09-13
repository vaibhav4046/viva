import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FileEventStore } from "@/lib/store/file";
import { PATH_MINUTES, selectDailyPath, unresolvedMisconception, type PlannerInput } from "@/lib/planner";
import { blankMastery } from "@/lib/mastery";
import type { LearningEvent } from "@/lib/types";

/**
 * The 10-minute Daily Path.
 *
 * A student judge used the live site, answered one question correctly, and got
 * "4 of 10 min planned": two steps, one of which was "Write it down". The four
 * composition rules take one concept each, so a thin history produced a thin
 * plan and the screen that exists to be worth ten minutes was worth three.
 *
 * These cases pin both halves of the contract: a learner with history gets a
 * plan that fills the time with real questions, and a learner with NO history
 * still gets nothing at all — an empty plan beats a fabricated session.
 */

let tmp: string;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "viva-path-"));
  process.env.DATA_DIR = tmp;
  delete process.env.BLOB_READ_WRITE_TOKEN;
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  await fs.rm(tmp, { recursive: true, force: true });
});

async function answered(
  user: string,
  conceptId: string,
  assessment: "correct" | "partial" | "incorrect"
): Promise<void> {
  await new FileEventStore().recordLearning(user, {
    idempotencyKey: `${conceptId}-${assessment}`,
    sessionId: "sess_path",
    courseId: "course_transformers_w4",
    sourceId: null,
    transcript: `about ${conceptId}`,
    cleanedTranscript: `about ${conceptId}`,
    origin: "typed",
    transcriptionConfidence: null,
    transcriptionLatencyMs: null,
    transcriptionSessionId: null,
    intent: "claim",
    conceptIds: [conceptId],
    primaryConceptId: conceptId,
    importance: 0.6,
    confusion: 0.2,
    interpretationConfidence: 0.8,
    evidenceIds: [],
    requestedAction: "evaluate",
    status: "responded",
    sourceLocator: null,
    assessment,
  });
}

async function inputFor(user: string): Promise<PlannerInput> {
  const s = new FileEventStore();
  // Sequential on purpose: the file store creates a missing user doc inside
  // load(), and three concurrent first reads race on one temp filename.
  const mastery = await s.getMastery(user);
  const events = await s.listEvents(user, 50);
  const concepts = await s.getConcepts(user);
  // queue: [] is what /today folds with — see src/components/today/snapshot.ts.
  return { mastery, events, queue: [], concepts };
}

const minutesOf = (path: { minutes: number }[]) => path.reduce((n, s) => n + s.minutes, 0);

describe("selectDailyPath", () => {
  it("gives a learner with no history nothing at all", async () => {
    const cold = await inputFor(`demo_path_cold_${Date.now().toString(36)}`);
    expect(cold.events).toHaveLength(0);
    expect(selectDailyPath(cold)).toEqual([]);
  });

  it("fills the ten minutes for a learner whose history is one correct answer", async () => {
    const user = `demo_path_one_${Date.now().toString(36)}`;
    await answered(user, "c_qkv", "correct");
    const plan = selectDailyPath(await inputFor(user));

    // Before: [weak_concept 3, summary 1] — "4 of 10 min planned".
    expect(plan.length).toBeGreaterThanOrEqual(4);
    expect(minutesOf(plan)).toBeGreaterThanOrEqual(8);
    expect(minutesOf(plan)).toBeLessThanOrEqual(PATH_MINUTES);

    // Most of that time is questions the learner answers without leaving the
    // page, not links out and a note to self.
    const asks = plan.filter((s) => s.action === "inline_recall");
    expect(asks.length).toBeGreaterThanOrEqual(3);
    expect(minutesOf(asks)).toBeGreaterThan(minutesOf(plan) / 2);

    // Every step names a concept the app can actually put a question to, and
    // no two steps ask about the same one.
    const ids = asks.map((s) => s.conceptId);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("never lets 'write it down' be the plan", async () => {
    const user = `demo_path_summary_${Date.now().toString(36)}`;
    await answered(user, "c_qkv", "correct");
    const plan = selectDailyPath(await inputFor(user));

    const summaries = plan.filter((s) => s.kind === "summary");
    expect(summaries).toHaveLength(1);
    // Last, and never more than a tenth of the session.
    expect(plan[plan.length - 1].kind).toBe("summary");
    expect(summaries[0].minutes).toBe(1);
    expect(plan.filter((s) => s.kind !== "summary").length).toBeGreaterThanOrEqual(2);
    // It says what to write about rather than standing in for a real step.
    expect(summaries[0].why).toContain(plan[0].conceptName as string);
  });

  it("does not call a concept the learner just got right their weakest", async () => {
    const user = `demo_path_weak_${Date.now().toString(36)}`;
    await answered(user, "c_qkv", "correct");
    const plan = selectDailyPath(await inputFor(user));

    const qkv = plan.find((s) => s.conceptId === "c_qkv");
    expect(qkv?.kind).toBe("recall");
    expect(qkv?.why).toContain("correctly");
  });

  it("shows a concept name, never a raw id, when mastery spans more subjects than the concept list", () => {
    // What /today does in "All subjects" mode: mastery and events cover every
    // subject, `concepts` covers only the active one.
    const at = "2026-09-11T09:00:00.000Z";
    const m = { ...blankMastery("bio_cell", at), exposureCount: 1, successfulRecallCount: 1, mastery: 0.6 };
    const event: LearningEvent = {
      id: "e1",
      userId: "u",
      sessionId: "s",
      courseId: "course_os_bio",
      sourceId: null,
      createdAt: at,
      transcript: "a cell",
      cleanedTranscript: "a cell",
      origin: "typed",
      transcriptionConfidence: null,
      transcriptionLatencyMs: null,
      intent: "claim",
      conceptIds: ["bio_cell"],
      primaryConceptId: "bio_cell",
      importance: 0.5,
      confusion: 0,
      confidenceSelfReport: null,
      sourceLocator: null,
      interpretationConfidence: 0.8,
      evidenceIds: [],
      requestedAction: "evaluate",
      status: "responded",
    };
    const plan = selectDailyPath({
      mastery: { bio_cell: m },
      events: [event],
      queue: [],
      concepts: [{ id: "c_qkv", name: "Queries, Keys, Values" }],
    });

    const step = plan.find((s) => s.conceptId === "bio_cell");
    expect(step?.conceptName).toBe("cell");
    expect(step?.courseId).toBe("course_os_bio");
  });

  it("is identical for identical input", async () => {
    const user = `demo_path_det_${Date.now().toString(36)}`;
    await answered(user, "c_position", "incorrect");
    await answered(user, "c_qkv", "correct");
    const input = await inputFor(user);
    expect(selectDailyPath(input)).toEqual(selectDailyPath(input));
  });
});

describe("unresolvedMisconception", () => {
  it("clears once the learner gets it right after the wrong answer", () => {
    const wrongAt = "2026-09-10T09:00:00.000Z";
    const rightAt = "2026-09-11T09:00:00.000Z";
    const wrong = {
      ...({} as LearningEvent),
      id: "e_wrong",
      primaryConceptId: "c_x",
      intent: "claim" as const,
      confusion: 0.2,
      createdAt: wrongAt,
      assessment: "incorrect" as const,
    };
    const base = { ...blankMastery("c_x", wrongAt), misconceptionCount: 1, failedRecallCount: 1 };

    expect(unresolvedMisconception(base, [wrong])).toBe(true);
    expect(unresolvedMisconception({ ...base, lastSuccessfulRecallAt: rightAt }, [wrong])).toBe(false);
    // Right BEFORE the wrong answer does not clear it.
    expect(unresolvedMisconception({ ...base, lastSuccessfulRecallAt: "2026-09-09T09:00:00.000Z" }, [wrong])).toBe(true);
  });
});
