import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIN_TRANSCRIPT_CONFIDENCE, POST } from "@/app/api/voice/transcribe/route";
import { validateWavInput } from "@/lib/audio/wav";
import { assemblyAIBreaker } from "@/lib/circuit";
import { VOICE_MESSAGES } from "@/lib/audio/messages";

/**
 * A silent hold must not become a cited note.
 *
 * Panel-D S-D-02: three holds with no speech produced three invented Hindi
 * sentences, each filed under a concept with a page number and the label
 * "Exactly what you said", at 62%, 73% and 85% confidence. The route already
 * refused an EMPTY transcript; it accepted a confabulated one, because nothing
 * looked at the number sitting right next to it.
 *
 * Two guards, and they catch different things:
 *
 *  1. A clip with no variation in it at all — a muted headset, a dead virtual
 *     input, an automated browser feeding digital silence — never reaches
 *     AssemblyAI. Deterministic, and it does not depend on what the provider
 *     feels like returning for silence that day.
 *  2. Anything the provider is not sure about is not "exactly what you said".
 *
 * The floor is measured, not guessed. Posted through this route at the live
 * Dictation endpoint on 2026-09-13 (`.viva/fixtures/spoken-sentence.wav` plus
 * the two `.viva/audio/*.wav` clips, clean, with white noise at 25% of clip
 * peak, and at 100%):
 *
 *   clip                       confidence   transcript
 *   spoken       clean            0.9894    correct
 *   spoken       noise 25%        0.9473    correct
 *   spoken       noise 100%       0.5551    INVENTED ("The title is called q
 *                                           into vector of concentrations…")
 *   confusion    clean            0.9873    correct
 *   confusion    noise 25%        0.9688    correct
 *   confusion    noise 100%          —      empty -> NO_SPEECH already
 *   claim        clean            0.9977    correct
 *   claim        noise 25%        0.9914    correct
 *   claim        noise 100%          —      empty -> NO_SPEECH already
 *   spoken       attenuated x1000 0.9809    correct
 *
 * …and seven more held through the real capture path (Chromium fake device ->
 * getUserMedia -> AudioWorklet -> browser-built WAV), which scores lower
 * because a hold that starts a syllable late scores that syllable badly:
 * 0.9061, 0.9546, 0.9892, 0.9506, 0.9895, 0.9896, 0.9466 — all correct.
 *
 * Correct transcripts bottom out at 0.9061, across sixteen readings, including
 * speech buried in equal-amplitude white noise and speech attenuated to a peak
 * of 17/32768. Invented ones: 0.5551 here, and 0.62 / 0.73 / 0.85 in the
 * panel-D report. Nothing landed between 0.85 and 0.9061, and the floor sits
 * inside that gap.
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

/** A real 16 kHz mono WAV. `amplitude` 0 is digital silence; `dc` is a dead
 *  input that parks at one non-zero value instead of at zero. */
function wav(ms: number, amplitude = 0x4000, dc = 0): Buffer {
  const frames = Math.round((16000 * ms) / 1000);
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    const v = amplitude === 0 ? dc : Math.round(Math.sin((2 * Math.PI * 180 * i) / 16000) * amplitude);
    data.writeInt16LE(v, i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const SPEECH = wav(3000);
const SILENCE = wav(3000, 0);

function request(audio: Buffer): Request {
  const form = new FormData();
  form.append("audio", new Blob([new Uint8Array(audio)], { type: "audio/wav" }), "clip.wav");
  form.append("subjectId", "course_transformers_w4");
  form.append("mode", "study");
  const ip = `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  return new Request("http://localhost/api/voice/transcribe", {
    method: "POST",
    body: form,
    headers: { "x-forwarded-for": ip },
  });
}

/** Stubs Dictation with one body and records every call it receives. */
function mockDictation(body: Record<string, unknown>): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return urls;
}

describe("a clip with no signal in it", () => {
  it("is refused before AssemblyAI is called at all", async () => {
    const urls = mockDictation({ text: "should never be asked for", confidence: 0.99 });
    const res = await POST(request(SILENCE));
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(res.status).toBe(415);
    expect(body.error.code).toBe("NO_AUDIO");
    expect(body.error.message).toBe(VOICE_MESSAGES.NO_AUDIO);
    // The whole point: a dead microphone costs nothing and cannot be
    // hallucinated over, because the provider never sees it.
    expect(urls).toEqual([]);
  });

  it("is refused by the validator, whether it sits at zero or at a DC offset", () => {
    expect(validateWavInput(SILENCE, "audio/wav")).toMatchObject({ ok: false, code: "NO_AUDIO" });
    // A dead input that parks at a constant non-zero value is just as dead.
    expect(validateWavInput(wav(3000, 0, -1200), "audio/wav")).toMatchObject({ ok: false, code: "NO_AUDIO" });
  });

  it("does not refuse very quiet audio — a whisper is still speech", () => {
    // `.viva/fixtures/spoken-sentence.wav` attenuated 1000x has a peak of 17
    // and still came back correct at 0.9809, so amplitude is not the test:
    // having any variation at all is.
    expect(validateWavInput(wav(3000, 17), "audio/wav").ok).toBe(true);
    expect(validateWavInput(wav(3000, 1), "audio/wav").ok).toBe(true);
  });
});

describe("the confidence floor", () => {
  it("refuses the exact transcript panel-D was shown for a silent hold", async () => {
    // S-D-02, verbatim from the report: filed as a note under Self-attention
    // with "p.5" and "Exactly what you said" beside it.
    mockDictation({
      text: "में भी साड़ी पहनी हुई है।.",
      confidence: 0.73,
      audio_duration_ms: 2500,
      request_time_ms: 398,
      session_id: "sess-silence",
    });
    const res = await POST(request(SPEECH));
    const body = (await res.json()) as { error?: { code: string }; verbatim?: string };
    expect(res.status).toBe(422);
    expect(body.error?.code).toBe("NO_SPEECH");
    expect(body.verbatim).toBeUndefined();
  });

  it("refuses the confabulation measured live at 0.5551", async () => {
    mockDictation({
      text: "The title is called q into vector of concentrations at which the reaction is taking place after 1 second.",
      confidence: 0.5551,
      audio_duration_ms: 6548,
    });
    const res = await POST(request(SPEECH));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("NO_SPEECH");
  });

  it("passes the lowest confidence a correct transcript actually scored", async () => {
    // 0.9061 is the worst reading from a correct transcript in sixteen: a real
    // 6.5 s hold through the capture path whose first word was clipped off.
    // That is the binding case — rejecting it would cost a learner a right
    // answer for pressing the button a syllable late, which everyone does.
    mockDictation({
      text: "Michaelis constant is the substrate concentration at which the reaction rate reaches half of vmax.",
      confidence: 0.9061,
      words: [
        { text: "Michaelis", confidence: 0.373 },
        { text: "constant", confidence: 0.9987 },
      ],
      audio_duration_ms: 6548,
      request_time_ms: 605,
    });
    const res = await POST(request(SPEECH));
    const body = (await res.json()) as { verbatim: string; confidence: number };
    expect(res.status).toBe(200);
    expect(body.verbatim).toContain("Michaelis constant");
    expect(body.confidence).toBe(0.9061);
  });

  it("sits between every invented transcript and every correct one seen so far", () => {
    // The bound is the measurement, not a preference — if someone retunes it
    // past either edge of the measured gap, this fails. 0.85 is the highest
    // confidence panel-D was shown for an invented sentence; 0.9061 is the
    // lowest a correct transcript has scored across sixteen readings.
    expect(MIN_TRANSCRIPT_CONFIDENCE).toBeGreaterThan(0.85);
    expect(MIN_TRANSCRIPT_CONFIDENCE).toBeLessThan(0.9061);
  });

  it("does not reject a path that reports no confidence at all", async () => {
    // The Sync fallback can answer without one. A number we never got is not
    // evidence of a bad transcript, and refusing on it would make every
    // fallback turn disappear.
    mockDictation({ text: "Positional encoding tells the model word order.", audio_duration_ms: 4780 });
    const res = await POST(request(SPEECH));
    const body = (await res.json()) as { verbatim: string; confidence: number | null };
    expect(res.status).toBe(200);
    expect(body.confidence).toBeNull();
    expect(body.verbatim).toContain("Positional encoding");
  });
});
