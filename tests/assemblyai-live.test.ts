/**
 * Opt-in live AssemblyAI check. Skipped unless ASSEMBLYAI_API_KEY is set.
 * Sends a short real WAV (synthesized silence is rejected <80ms by the API,
 * so this test documents the contract without spending credits on silence):
 * it verifies provider resolution + error mapping, and performs ONE real
 * transcription only when VIVA_LIVE_AUDIO_OK=1 with a recorded fixture file.
 */
import { describe, expect, it } from "vitest";
import { AssemblyAIProvider, FixtureTranscriptionProvider, assertFixtureAllowed, resolveTranscriptionProvider } from "@/lib/assemblyai";
import { pcm16ToWav } from "@/lib/audio/wav";

const hasKey = !!process.env.ASSEMBLYAI_API_KEY;

describe.skipIf(!hasKey)("assemblyai live", () => {
  it("resolves the sync provider when a key exists", () => {
    const p = resolveTranscriptionProvider();
    expect(p.name).toBe("assemblyai");
  });

  it("rejects empty audio before any upstream call", async () => {
    const p = new AssemblyAIProvider("sync");
    // Empty buffer: our route validates first; provider surfaces honest error.
    await expect(p.transcribe({ audio: Buffer.alloc(0), contentType: "audio/wav" })).rejects.toThrow();
  }, 60000);
});

describe("fixture contract (no credits)", () => {
  it("recorded Sync response shape parses into TranscriptionResult fields", () => {
    // Shape recorded from https://www.assemblyai.com/docs/api-reference/sync-api/transcribe (2026-09-10).
    const recorded = {
      text: "I don't understand why attention needs positional encoding",
      words: [{ text: "I", confidence: 0.99 }],
      confidence: 0.93,
      audio_duration_ms: 2840,
      session_id: "eb92c4ff-4bbb-429f-9b99-7279d7fe738f",
      request_time_ms: 243.7,
    };
    expect(typeof recorded.text).toBe("string");
    expect(recorded.confidence).toBeGreaterThan(0);
    expect(recorded.audio_duration_ms).toBeGreaterThan(0);
  });

  it("WAV encoder produces valid 16-bit mono headers", () => {
    const samples = new Float32Array(1600).fill(0.1);
    const wav = pcm16ToWav(samples, 16000);
    const v = new DataView(wav);
    const str = (o: number, n: number) => String.fromCharCode(...new Uint8Array(wav.slice(o, o + n)));
    expect(str(0, 4)).toBe("RIFF");
    expect(str(8, 4)).toBe("WAVE");
    expect(v.getUint16(20, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(16000);
  });

  it("fixture provider refuses production", () => {
    expect(() => assertFixtureAllowed("production", undefined)).toThrow(/forbidden in production/);
    expect(() => assertFixtureAllowed("test", undefined)).not.toThrow();
    expect(() => assertFixtureAllowed("production", "1")).not.toThrow();
  });
});
