import { describe, expect, it } from "vitest";
import { compoundMemory } from "@/lib/memory";
import { FileEventStore } from "@/lib/store/file";
import type { LearningEvent } from "@/lib/types";

let n = 0;

type Extra = {
  assessment?: "correct" | "partial" | "incorrect";
  teachbackScore?: number;
};

function evt(over: Partial<LearningEvent> & Extra = {}): LearningEvent {
  const { assessment, teachbackScore, ...rest } = over;
  const base: LearningEvent = {
    id: `evt_mem_${Date.now().toString(36)}_${n++}`,
    userId: "u_mem",
    sessionId: "sess_mem",
    courseId: "course_transformers_w4",
    sourceId: "src_transformers_intro",
    createdAt: new Date(Date.now() + n * 1000).toISOString(),
    transcript: "memory probe",
    cleanedTranscript: "Memory probe.",
    origin: "voice",
    transcriptionConfidence: null,
    transcriptionLatencyMs: null,
    intent: "note",
    conceptIds: [],
    primaryConceptId: null,
    importance: 0.5,
    confusion: 0.1,
    confidenceSelfReport: null,
    sourceLocator: null,
    interpretationConfidence: 0.8,
    evidenceIds: [],
    requestedAction: "none",
    status: "grounded",
    ...rest,
  };
  if (assessment === undefined && teachbackScore === undefined) return base;
  return { ...base, assessment, teachbackScore } as LearningEvent;
}

describe("compoundMemory", () => {
  it("seed-only history → []", async () => {
    const s = new FileEventStore();
    const u = `u_mem_seed_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    try {
      const events = await s.listEvents(u); // auto-seeds exactly one seed event
      expect(events.length).toBe(1);
      expect(await compoundMemory(events)).toEqual([]);
    } finally {
      await s.deleteUserData(u);
    }
  });

  it("two confusions on one concept → statement names the concept + count", async () => {
    const history = [
      evt({ intent: "remember", conceptIds: ["c_multihead"], primaryConceptId: "c_multihead" }),
      evt({ intent: "confusion", conceptIds: ["c_position"], primaryConceptId: "c_position", confusion: 0.9 }),
      evt({ intent: "confusion", conceptIds: ["c_position"], primaryConceptId: "c_position", confusion: 0.85 }),
    ];
    const out = await compoundMemory(history);
    expect(out.length).toBeGreaterThan(0);
    const joined = out.join("\n");
    expect(joined).toMatch(/position/i);
    expect(joined).toMatch(/2|two|twice|again|repeated/i);
  });

  it("fail-then-success → improvement statement", async () => {
    const history = [
      evt({
        intent: "confusion", conceptIds: ["c_qkv"], primaryConceptId: "c_qkv",
        confusion: 0.9, status: "failed",
      }),
      evt({
        intent: "teachback", conceptIds: ["c_qkv"], primaryConceptId: "c_qkv",
        status: "responded", assessment: "correct", teachbackScore: 0.9,
      }),
    ];
    const out = await compoundMemory(history);
    expect(out.length).toBeGreaterThan(0);
    expect(out.join("\n")).toMatch(/improv|recover|progress|resolv|better|correct|mastered/i);
  });

  it("caps at 3 statements", async () => {
    const history = [
      evt({ intent: "confusion", conceptIds: ["c_position"], primaryConceptId: "c_position", confusion: 0.9 }),
      evt({ intent: "confusion", conceptIds: ["c_position"], primaryConceptId: "c_position", confusion: 0.9 }),
      evt({ intent: "confusion", conceptIds: ["c_qkv"], primaryConceptId: "c_qkv", confusion: 0.9 }),
      evt({ intent: "confusion", conceptIds: ["c_qkv"], primaryConceptId: "c_qkv", confusion: 0.8 }),
      evt({ intent: "confusion", conceptIds: ["c_multihead"], primaryConceptId: "c_multihead", confusion: 0.9 }),
      evt({
        intent: "claim", conceptIds: ["c_backprop"], primaryConceptId: "c_backprop",
        status: "failed", assessment: "incorrect",
      }),
      evt({
        intent: "teachback", conceptIds: ["c_backprop"], primaryConceptId: "c_backprop",
        status: "responded", assessment: "correct", teachbackScore: 0.85,
      }),
    ];
    const out = await compoundMemory(history);
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(3);
  });
});
