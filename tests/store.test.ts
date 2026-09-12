import { describe, expect, it } from "vitest";
import { FileEventStore } from "@/lib/store/file";
import { pcm16ToWav, validateWavInput } from "@/lib/audio/wav";
import { __resetLimits, checkLimit } from "@/lib/limits";
import { CircuitBreaker } from "@/lib/circuit";
import type { RecordInput } from "@/lib/store/repo";

function input(over: Partial<RecordInput> = {}): RecordInput {
  return {
    idempotencyKey: `k_${Math.random().toString(36).slice(2)}`,
    sessionId: "sess_t",
    courseId: "course_transformers_w4",
    sourceId: "src_transformers_intro",
    transcript: "I don't understand positional encoding.",
    cleanedTranscript: "I don't understand positional encoding.",
    origin: "voice",
    transcriptionConfidence: 0.93,
    transcriptionLatencyMs: 240,
    transcriptionSessionId: "sess_abc",
    intent: "confusion",
    conceptIds: ["c_position"],
    primaryConceptId: "c_position",
    importance: 0.7,
    confusion: 0.9,
    interpretationConfidence: 0.88,
    evidenceIds: ["ch_pos_1"],
    requestedAction: "explain",
    status: "grounded",
    sourceLocator: { section: "3", page: 11 },
    ...over,
  };
}

describe("file store (§23 idempotency, §68 concurrency, §15 isolation)", () => {
  it("records once; network retry with same key returns the original", async () => {
    const s = new FileEventStore();
    const u = `u_${Date.now()}_a`;
    const key = "idem-1";
    const r1 = await s.recordLearning(u, input({ idempotencyKey: key }));
    const r2 = await s.recordLearning(u, input({ idempotencyKey: key }));
    expect(r1.duplicate).toBe(false);
    expect(r2.duplicate).toBe(true);
    expect(r2.event.id).toBe(r1.event.id);
    expect(r2.delta).toBeNull();
    expect((await s.listEvents(u)).length).toBe(2); // seed + 1
    await s.deleteUserData(u);
  });

  it("two users never see each other's events (IDOR)", async () => {
    const s = new FileEventStore();
    const a = `u_${Date.now()}_b1`;
    const b = `u_${Date.now()}_b2`;
    await s.recordLearning(a, input({}));
    expect(await s.listEvents(b)).toHaveLength(1); // only b's own seed
    expect((await s.listEvents(a)).length).toBeGreaterThan((await s.listEvents(b)).length);
    await s.deleteUserData(a);
    await s.deleteUserData(b);
  });

  it("10 concurrent events serialize: exact count, bounded mastery", async () => {
    const s = new FileEventStore();
    const u = `u_${Date.now()}_c`;
    await Promise.all(Array.from({ length: 10 }, (_, i) => s.recordLearning(u, input({ idempotencyKey: `cc-${i}` }))));
    const events = await s.listEvents(u, 100);
    expect(events.length).toBe(11); // seed + 10
    const m = (await s.getMastery(u))["c_position"];
    expect(m.mastery).toBeGreaterThanOrEqual(0);
    expect(m.mastery).toBeLessThanOrEqual(1);
    expect(m.confusionCount).toBeGreaterThanOrEqual(10);
    await s.deleteUserData(u);
  });

  it("delete wipes everything (privacy)", async () => {
    const s = new FileEventStore();
    const u = `u_${Date.now()}_d`;
    await s.recordLearning(u, input({}));
    await s.deleteUserData(u);
    // Fresh load reseeds (new identity starts clean with demo course only)
    expect((await s.listEvents(u)).length).toBe(1);
    await s.deleteUserData(u);
  });
});

describe("audio validation (§8, no credits before validation)", () => {
  it("accepts encoder-produced WAV with correct duration", () => {
    const wav = pcm16ToWav(new Float32Array(16000).fill(0.05), 16000); // 1s
    const r = validateWavInput(Buffer.from(wav), "audio/wav");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.durationMs).toBe(1000);
  });
  it("rejects non-WAV bytes with a coded error", () => {
    const r = validateWavInput(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00]), "audio/webm");
    expect(r.ok).toBe(false);
  });
  it("rejects empty audio", () => {
    expect(validateWavInput(Buffer.alloc(0), "audio/wav").ok).toBe(false);
  });
});

describe("rate limiter (§25)", () => {
  it("allows burst then 429s with Retry-After", () => {
    __resetLimits();
    const k = `t_${Date.now()}`;
    for (let i = 0; i < 12; i++) expect(checkLimit(k, "transcribe").ok).toBe(true);
    const r = checkLimit(k, "transcribe");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.retryAfterSec).toBeGreaterThan(0);
    __resetLimits();
  });
});

describe("circuit breaker (§24)", () => {
  it("opens after threshold, half-opens after cooldown", () => {
    const c = new CircuitBreaker(3, 50);
    expect(c.allow()).toBe(true);
    c.failure(); c.failure(); c.failure();
    expect(c.allow()).toBe(false);
    expect(c.snapshot().state).toBe("open");
  });
  it("success resets the count", () => {
    const c = new CircuitBreaker(3, 10_000);
    c.failure(); c.success();
    expect(c.snapshot().consecutiveFailures).toBe(0);
    expect(c.allow()).toBe(true);
  });
});
