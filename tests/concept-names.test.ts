/*
 * A student's plan must never show them a database key.
 *
 * Postgres files every row under `base::user::course`, and `toMastery` handed
 * that scoped id back on the `conceptId` field while filing the record under
 * the stripped one. Nothing noticed, because the id only reaches the screen for
 * concepts the learner has actually worked on — the exact cards a returning
 * student reads first. A judge got card titles and a sentence reading
 * "c_position::demo_1e1d05052db01852e9d2082b0ecc5a57::course_transformers_w4
 * has 2 incorrect answers", and at 390 px the unbreakable string pushed the
 * page 806 px wide.
 *
 * Two rules, tested here rather than in the store, because the store needs a
 * database and this is what the student actually sees:
 *   1. a scoped id resolves to its concept's real name
 *   2. an id nobody can name is never printed as an id
 */
import { describe, expect, it } from "vitest";
import { blankMastery } from "@/lib/mastery";
import { conceptNamer } from "@/lib/planner";
import { deriveToday } from "@/components/today/snapshot";
import type { LearningEvent } from "@/lib/types";

const CONCEPTS = [
  { id: "c_position", name: "Positional information" },
  { id: "c_attention", name: "Self-attention" },
];
const SCOPED = "c_position::demo_1e1d05052db01852e9d2082b0ecc5a57::course_transformers_w4";

describe("concept names never leak row ids", () => {
  it("resolves a scoped row id to the concept's own name", () => {
    expect(conceptNamer(CONCEPTS)(SCOPED)).toBe("Positional information");
  });

  it("resolves a plain id exactly as before", () => {
    expect(conceptNamer(CONCEPTS)("c_attention")).toBe("Self-attention");
  });

  it("never returns an id for a concept nobody can name", () => {
    const name = conceptNamer(CONCEPTS)("c_ghost::u::course_x");
    expect(name).not.toContain("::");
    expect(name).not.toContain("c_ghost");
  });

  it("keeps scoped ids out of every string on /today", () => {
    const now = new Date("2026-09-13T09:00:00.000Z");
    const iso = now.toISOString();
    const wrong = {
      ...blankMastery(SCOPED, iso),
      exposureCount: 3,
      failedRecallCount: 2,
      misconceptionCount: 2,
      mastery: 0.25,
      reviewPriority: 0.9,
    };
    const events: LearningEvent[] = [
      {
        id: "evt_1",
        userId: "demo",
        sessionId: "s1",
        courseId: "course_transformers_w4",
        sourceId: null,
        idempotencyKey: "k1",
        transcript: "positional encoding is the batch size",
        cleanedTranscript: "positional encoding is the batch size",
        origin: "typed",
        transcriptionConfidence: null,
        transcriptionLatencyMs: null,
        transcriptionSessionId: null,
        intent: "answer",
        conceptIds: [SCOPED],
        primaryConceptId: SCOPED,
        importance: 0.5,
        confusion: 0.8,
        interpretationConfidence: 0.6,
        evidenceIds: [],
        requestedAction: null,
        status: "complete",
        sourceLocator: null,
        assessment: "incorrect",
        hint: null,
        masterySignal: "misconception",
        delta: -0.1,
        reason: "wrong answer",
        transcriptionMode: null,
        transcriptionFellBackFrom: null,
        transcriptVerbatim: null,
        teachbackScore: null,
        createdAt: iso,
      } as unknown as LearningEvent,
    ];

    const view = deriveToday({ mastery: { c_position: wrong }, events, concepts: CONCEPTS }, now);
    const printed = [
      ...view.path.map((s) => `${s.conceptName ?? ""} ${s.why}`),
      ...view.due.map((d) => `${d.conceptName} ${d.reason}`),
      view.recurring ?? "",
      view.mixedUp ? view.nameOf(view.mixedUp.conceptId) : "",
      view.improved ? view.nameOf(view.improved.conceptId) : "",
    ].join(" | ");

    expect(printed).not.toContain("::");
    expect(printed).not.toContain("demo_1e1d05052db01852e9d2082b0ecc5a57");
  });
});
