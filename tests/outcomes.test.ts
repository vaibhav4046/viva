import { describe, expect, it } from "vitest";
import { FileEventStore } from "@/lib/store/file";
import { LearningEventSchema } from "@/lib/types";
import { compileTranscript } from "@/lib/compiler";
import type { RecordInput } from "@/lib/store/repo";

/**
 * Outcome persistence + retention instrumentation contract.
 * The compile route is integration-level (covered by the golden E2E); these
 * tests pin the store/schema behavior the replay UI depends on.
 */

function input(over: Partial<RecordInput> = {}): RecordInput {
  return {
    idempotencyKey: `k_${Math.random().toString(36).slice(2)}`,
    sessionId: "sess_out",
    courseId: "course_probability",
    sourceId: "src_probability_traps",
    transcript: "I think P(A|B) equals P(B|A).",
    cleanedTranscript: "I think P(A|B) equals P(B|A).",
    origin: "typed",
    transcriptionConfidence: null,
    transcriptionLatencyMs: null,
    transcriptionSessionId: null,
    intent: "claim",
    conceptIds: ["c_cond", "c_bayes"],
    primaryConceptId: "c_cond",
    importance: 0.65,
    confusion: 0.35,
    interpretationConfidence: 0.8,
    evidenceIds: ["ch_pr_cond_2"],
    requestedAction: "evaluate",
    status: "grounded",
    sourceLocator: { section: "VIVA oral exam" },
    ...over,
  };
}

function validEvent() {
  return {
    id: "evt_schema_1",
    userId: "u_schema",
    sessionId: "sess_schema",
    courseId: "course_probability",
    sourceId: "src_probability_traps",
    createdAt: "2026-09-11T10:00:00.000Z",
    transcript: "I think P(A|B) equals P(B|A).",
    cleanedTranscript: "I think P(A|B) equals P(B|A).",
    origin: "typed" as const,
    transcriptionConfidence: null,
    transcriptionLatencyMs: null,
    intent: "claim" as const,
    conceptIds: ["c_cond", "c_bayes"],
    primaryConceptId: "c_cond",
    importance: 0.65,
    confusion: 0.35,
    confidenceSelfReport: null,
    sourceLocator: { section: "VIVA oral exam" },
    interpretationConfidence: 0.8,
    evidenceIds: ["ch_pr_cond_2"],
    requestedAction: "evaluate" as const,
    status: "grounded" as const,
  };
}

describe("per-event outcome persistence (replay fix)", () => {
  it("file store persists assessment, delta, reason and hint on the stored event", async () => {
    const s = new FileEventStore();
    const u = `u_out_complete_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    try {
      const r = await s.recordLearning(
        u,
        input({
          intent: "claim",
          assessment: "incorrect",
          hint: "Start from P(A and B) divided by something, then say what conditioning keeps.",
        })
      );
      expect(r.delta).toBe(-0.12);
      expect(r.reason).toBe("unsupported claim — possible misconception");
      const stored = (await s.listEvents(u, 10)).find((e) => e.id === r.event.id);
      expect(stored).toBeDefined();
      expect(stored?.assessment).toBe("incorrect");
      expect(stored?.delta).toBe(-0.12);
      expect(stored?.reason).toBe("unsupported claim — possible misconception");
      expect(stored?.hint).toContain("P(A and B)");
    } finally {
      await s.deleteUserData(u);
    }
  });

  it("file store records reducer delta/reason with a null assessment when none applies", async () => {
    const s = new FileEventStore();
    const u = `u_out_plain_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    try {
      const r = await s.recordLearning(u, input({ intent: "claim" }));
      const stored = (await s.listEvents(u, 10)).find((e) => e.id === r.event.id);
      expect(stored?.assessment).toBeNull();
      expect(stored?.delta).toBe(-0.02);
      expect(stored?.reason).toBe("unverified claim stored");
      expect(stored?.hint).toBeNull();
    } finally {
      await s.deleteUserData(u);
    }
  });

  it("LearningEventSchema accepts the additive optional outcome fields", () => {
    expect(LearningEventSchema.safeParse(validEvent()).success).toBe(true);
    const withOutcome = LearningEventSchema.safeParse({
      ...validEvent(),
      assessment: "partial",
      delta: 0.02,
      reason: "partially correct — one piece missing",
      hint: "Name the prior, the likelihood and the posterior.",
    });
    expect(withOutcome.success).toBe(true);
    expect(LearningEventSchema.safeParse({ ...validEvent(), assessment: null, delta: null, hint: null }).success).toBe(true);
  });

  it("LearningEventSchema rejects wrong types for the outcome fields", () => {
    expect(LearningEventSchema.safeParse({ ...validEvent(), assessment: "maybe" }).success).toBe(false);
    expect(LearningEventSchema.safeParse({ ...validEvent(), delta: "up" }).success).toBe(false);
    expect(LearningEventSchema.safeParse({ ...validEvent(), reason: 7 }).success).toBe(false);
    expect(LearningEventSchema.safeParse({ ...validEvent(), hint: 5 }).success).toBe(false);
  });

  it("product events aggregate counts per name (last 7 days)", async () => {
    const s = new FileEventStore();
    const u = `u_out_events_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    try {
      await s.recordProductEvent(u, "path_opened");
      await s.recordProductEvent(u, "path_opened", { minutes: 3 });
      await s.recordProductEvent(u, "recall_answered");
      const counts = Object.fromEntries((await s.productEventSummary(u, 7)).map((r) => [r.name, r.count]));
      expect(counts["path_opened"]).toBe(2);
      expect(counts["recall_answered"]).toBe(1);
    } finally {
      await s.deleteUserData(u);
    }
  });

  it("the probability demo sentence maps to c_cond/c_bayes as a claim", () => {
    const d = compileTranscript("I think P(A|B) equals P(B|A)", { courseId: "course_probability" });
    expect(d.intent).toBe("claim");
    expect(d.primaryConceptId).toBe("c_cond");
    expect(d.conceptIds).toContain("c_bayes");
  });

  it.skip("compile route contract (integration-level): the route attaches assessment/delta/reason/hint to the recorded event", () => {
    // Exercised end-to-end by the golden path (scripts/e2e-golden.py) and by
    // the file-store contracts above; a route-level unit test would need the
    // full Next request pipeline, so it stays integration-level by design.
  });
});
