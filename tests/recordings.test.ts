import { describe, expect, it } from "vitest";
import { SessionSchema } from "@/lib/recordings";

const base = {
  id: "sample-1",
  recordedAt: "2026-09-29T14:00:00Z",
  course: "Transformers, Week 4 (VIVA course notes, sample)",
  learnerVoice: "synthetic",
  audio: "/recordings/sample-1/session.wav",
  durationMs: 90000,
  turns: [{ tMs: 0, speaker: "examiner", text: "Suppose we remove the positional encodings." }],
  events: [{ tMs: 4200, kind: "tool", name: "verify_claim", detail: "Checking page 12" }],
};

describe("recorded session format", () => {
  it("accepts a labelled synthetic recording", () => {
    expect(SessionSchema.safeParse(base).success).toBe(true);
  });

  it("refuses a recording that is not labelled synthetic", () => {
    expect(SessionSchema.safeParse({ ...base, learnerVoice: "human" }).success).toBe(false);
    const { learnerVoice: _omitted, ...unlabelled } = base;
    expect(SessionSchema.safeParse(unlabelled).success).toBe(false);
  });

  it("refuses audio outside /recordings and ids that could escape the folder", () => {
    expect(SessionSchema.safeParse({ ...base, audio: "https://example.com/a.wav" }).success).toBe(false);
    expect(SessionSchema.safeParse({ ...base, id: "../secrets" }).success).toBe(false);
  });
});
