import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/voice/transcribe/route";
import { TARGET_RATE, toPcm16kMono, validateWavInput } from "@/lib/audio/wav";
import { assemblyAIBreaker } from "@/lib/circuit";

/**
 * The declaration must match the bytes.
 *
 * Dictation's `config` says `sample_rate: 16000, channels: 1`, and AssemblyAI
 * reads the raw PCM stream at exactly that rate. The build used to hardcode the
 * declaration while forwarding whatever the caller sent, so a 48 kHz stereo
 * clip — what a desktop mic actually records — was consumed at one sixth speed:
 * a 3 s clip billed and reported as 18 s, transcript empty, HTTP 200, no
 * warning anywhere. These tests fail if that ever comes back.
 */

const DICTATION_URL = "https://dictation.assemblyai.com/v1/transcribe/live";
const savedFetch = globalThis.fetch;
const savedEnv = { ...process.env };

beforeEach(() => {
  process.env.ASSEMBLYAI_API_KEY = "test-key";
  process.env.ASSEMBLYAI_DICTATION_URL = DICTATION_URL;
  process.env.ASSEMBLYAI_TRANSCRIPTION_MODE = "dictation";
  assemblyAIBreaker.success();
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  process.env = { ...savedEnv };
  assemblyAIBreaker.success();
});

/**
 * A real WAV at any rate/channel count. `fmtLen` 18 reproduces the cbSize
 * extension the repo's own `.viva/audio/*.wav` fixtures carry, which puts the
 * sample data at byte 46 rather than 44.
 */
function wav(opts: { sampleRate: number; channels: number; ms: number; hz?: number; fmtLen?: 16 | 18 }): Buffer {
  const { sampleRate, channels, ms, hz = 180, fmtLen = 16 } = opts;
  const frames = Math.round((sampleRate * ms) / 1000);
  const data = Buffer.alloc(frames * channels * 2);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(0.6 * Math.sin((2 * Math.PI * hz * i) / sampleRate) * 0x7000);
    for (let c = 0; c < channels; c++) data.writeInt16LE(v, (i * channels + c) * 2);
  }
  const header = Buffer.alloc(20 + fmtLen + 8);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(header.length - 8 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(fmtLen, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 20 + fmtLen, "ascii");
  header.writeUInt32LE(data.length, 24 + fmtLen);
  return Buffer.concat([header, data]);
}

/** Milliseconds the bytes represent when read as 16 kHz mono S16LE. */
const asDeclaredMs = (bytes: number) => Math.round((bytes / 2 / TARGET_RATE) * 1000);

describe("toPcm16kMono", () => {
  it("downmixes and resamples 48 kHz stereo so the bytes mean what the config says", () => {
    const out = toPcm16kMono(wav({ sampleRate: 48000, channels: 2, ms: 3000 }), "audio/wav");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.sourceRate).toBe(48000);
    expect(out.sourceChannels).toBe(2);
    // 3 s of 48 kHz stereo is 576,000 bytes. Sent raw and declared as 16 kHz
    // mono it reads as 18,000 ms — the exact 6x inflation the judge measured.
    expect(asDeclaredMs(out.pcm.length)).toBe(3000);
  });

  it("reads the data chunk at its parsed offset, not a hardcoded byte 44", () => {
    // An 18-byte `fmt ` chunk puts sample data at 46. Stripping 44 blindly
    // prepends two header bytes as a phantom sample — and any chunk layout
    // with an odd byte count would misalign every sample after it.
    const ms = 500;
    const bytes = wav({ sampleRate: TARGET_RATE, channels: 1, ms, fmtLen: 18 });
    const out = toPcm16kMono(bytes, "audio/wav");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.pcm.length).toBe(TARGET_RATE * (ms / 1000) * 2);
    expect(out.pcm[0]).toBe(bytes[46]);
  });

  it("passes 16 kHz mono through untouched — the worklet path pays nothing", () => {
    const bytes = wav({ sampleRate: TARGET_RATE, channels: 1, ms: 1000 });
    const out = toPcm16kMono(bytes, "audio/wav");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.pcm.equals(bytes.subarray(44))).toBe(true);
  });

  it("folds two channels to their mean rather than dropping one", () => {
    // L at +8000, R at -8000: a channel-dropping downmix leaves a loud tone,
    // a correct average leaves silence.
    const frames = TARGET_RATE / 2;
    const data = Buffer.alloc(frames * 4);
    for (let i = 0; i < frames; i++) {
      data.writeInt16LE(8000, i * 4);
      data.writeInt16LE(-8000, i * 4 + 2);
    }
    const base = wav({ sampleRate: TARGET_RATE, channels: 2, ms: 500 });
    data.copy(base, 44);
    const out = toPcm16kMono(base, "audio/wav");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const peak = Math.max(...Array.from({ length: out.pcm.length / 2 }, (_, i) => Math.abs(out.pcm.readInt16LE(i * 2))));
    expect(peak).toBe(0);
  });

  it("upsamples 8 kHz to 16 kHz instead of halving the clip", () => {
    const out = toPcm16kMono(wav({ sampleRate: 8000, channels: 1, ms: 1000 }), "audio/wav");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(asDeclaredMs(out.pcm.length)).toBe(1000);
  });

  it("every rate the validator accepts converts to the declared duration", () => {
    for (const sampleRate of [8000, 16000, 22050, 24000, 32000, 44100, 48000]) {
      for (const channels of [1, 2]) {
        const bytes = wav({ sampleRate, channels, ms: 1000 });
        expect(validateWavInput(bytes, "audio/wav").ok).toBe(true);
        const out = toPcm16kMono(bytes, "audio/wav");
        expect(out.ok, `${sampleRate}/${channels}`).toBe(true);
        if (!out.ok) continue;
        expect(asDeclaredMs(out.pcm.length), `${sampleRate}/${channels}`).toBeCloseTo(1000, -1);
      }
    }
  });

  it("bytes that are not a WAV are a coded refusal, never a guess", () => {
    const out = toPcm16kMono(Buffer.from("GIF89a".padEnd(200, "x")), "audio/wav");
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("BAD_AUDIO");
  });
});

describe("POST /api/voice/transcribe with a 48 kHz stereo clip", () => {
  function post(audio: Buffer): Request {
    const form = new FormData();
    form.append("audio", new Blob([new Uint8Array(audio)], { type: "audio/wav" }), "clip.wav");
    form.append("subjectId", "course_transformers_w4");
    form.append("mode", "study");
    const ip = `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    return new Request("http://localhost/api/voice/transcribe", { method: "POST", body: form, headers: { "x-forwarded-for": ip } });
  }

  it("ships audio whose real duration matches the sample_rate it declares", async () => {
    let sent: { config: Record<string, unknown>; audioBytes: number } | null = null;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const body = init?.body as unknown as FormData;
      sent = {
        config: JSON.parse(await (body.get("config") as File).text()) as Record<string, unknown>,
        audioBytes: (body.get("audio") as File).size,
      };
      return new Response(
        JSON.stringify({ text: "declared and actual agree", llm_response: null, llm_error: null, confidence: 0.9, audio_duration_ms: 3000, session_id: "s" }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const res = await POST(post(wav({ sampleRate: 48000, channels: 2, ms: 3000 })));
    expect(res.status).toBe(200);
    const sentCall = sent as unknown as { config: Record<string, unknown>; audioBytes: number };
    expect(sentCall).not.toBeNull();
    expect(sentCall.config.sample_rate).toBe(16000);
    expect(sentCall.config.channels).toBe(1);
    // The regression: 576,000 raw bytes under a 16 kHz mono declaration is
    // 18,000 ms of audio for a 3,000 ms clip. Never a mislabelled request.
    expect(sentCall.audioBytes).not.toBe(576_000);
    expect(asDeclaredMs(sentCall.audioBytes)).toBe(3000);
  });

  it("a real user on a 48 kHz stereo mic gets a transcript, not a rejection", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ text: "attention needs positions", llm_response: "Attention needs positions.", llm_error: null, confidence: 0.98, audio_duration_ms: 3000, session_id: "s", request_time_ms: 400 }),
        { status: 200 }
      )) as unknown as typeof fetch;

    const res = await POST(post(wav({ sampleRate: 48000, channels: 2, ms: 3000 })));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verbatim).toBe("attention needs positions");
    expect(body.audioMs).toBe(3000);
  });
});
