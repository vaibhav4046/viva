import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/voice/transcribe/route";
import { BATCH_LANGUAGES, batchLanguageCodes } from "@/lib/assemblyai";
import { AUTO_LANGUAGE, STREAM_LANGUAGES } from "@/lib/audio/stream";
import { LANGUAGE_PRESETS } from "@/components/voice/MicButton";
import { assemblyAIBreaker } from "@/lib/circuit";

/**
 * The language picker sets one value and two different transcribers read it:
 * the socket that paints words while you talk, and the buffered POST whose
 * transcript becomes the note. They must not disagree about what the learner
 * chose, and neither may be handed a code its endpoint refuses.
 *
 * What the endpoints actually do, measured 2026-09-13 by §6 of
 * `scripts/api-probes/probe-dictation-contract.mjs` on a 4.69 s Hindi clip and
 * a 4.60 s Spanish one:
 *
 *   language_codes    dictation           what came back on the Hindi clip
 *   omitted           200                 correct Devanagari
 *   ["en"]            200                 correct Devanagari (it detects anyway)
 *   ["hi"]            200                 correct Devanagari
 *   ["multi"]         400 Bad Request     — and `multi` is the picker's default
 *   ["pl"] / ["uk"]   400 Bad Request     — and both are picker entries
 *
 * So omitting the key IS this endpoint's automatic detection, `multi` is a
 * refusal rather than a synonym for it, and the same 400 enumerates the 32
 * codes both batch endpoints take. Sync answers identically.
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

/** A real 16 kHz mono WAV carrying a tone — silence is refused before send. */
function wav(samples: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + samples * 2, 4);
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
  header.writeUInt32LE(samples * 2, 40);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 180 * i) / 16000) * 0x4000), i * 2);
  }
  return Buffer.concat([header, data]);
}

const AUDIO = wav(16000);

function request(fields: Record<string, string>): Request {
  const form = new FormData();
  form.append("audio", new Blob([new Uint8Array(AUDIO)], { type: "audio/wav" }), "clip.wav");
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const ip = `10.1.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  return new Request("http://localhost/api/voice/transcribe", {
    method: "POST",
    body: form,
    headers: { "x-forwarded-for": ip },
  });
}

const ok = { text: "Um, I think attention needs positions.", confidence: 0.96, audio_duration_ms: 1000 };

/** The `config` part the route actually put on the wire. */
async function sentConfig(fields: Record<string, string>): Promise<Record<string, unknown>> {
  let body: FormData | undefined;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    body ??= init?.body as unknown as FormData;
    return new Response(JSON.stringify(ok), { status: 200 });
  }) as unknown as typeof fetch;
  await POST(request(fields));
  const part = body?.get("config");
  const text = typeof part === "string" ? part : await (part as File).text();
  return JSON.parse(text) as Record<string, unknown>;
}

describe("the picker's Automatic reaches both transcribers as automatic", () => {
  it("omits language_codes rather than pinning English", async () => {
    // The regression: `multi` failed the route's two-letter test, fell through
    // to the subject default and left as ["en"]. The socket meanwhile ran the
    // multilingual model. Same clip, two languages of record.
    const config = await sentConfig({ subjectId: "course_transformers_w4", languageCodes: AUTO_LANGUAGE });
    expect(config.language_codes).toBeUndefined();
  });

  it("never sends `multi` itself, which both batch endpoints answer 400", async () => {
    // Including when it arrives beside a code the endpoint does take: one bad
    // entry in the list is a 400 for the whole clip.
    const config = await sentConfig({ subjectId: "course_transformers_w4", languageCodes: `${AUTO_LANGUAGE},en` });
    expect(config.language_codes).toEqual(["en"]);
  });

  it("still lets a named language pin the transcript", async () => {
    const config = await sentConfig({ subjectId: "course_transformers_w4", languageCodes: "hi" });
    expect(config.language_codes).toEqual(["hi"]);
  });

  it("keeps the subject's own codes when the field is absent altogether", async () => {
    const config = await sentConfig({ subjectId: "course_transformers_w4" });
    expect(config.language_codes).toEqual(["en"]);
  });
});

describe("no picker entry can reach an endpoint that refuses it", () => {
  it("every preset either names a code both endpoints take, or asks for detection", () => {
    for (const preset of LANGUAGE_PRESETS) {
      const codes = batchLanguageCodes(preset.value.split(","));
      for (const c of codes) expect(BATCH_LANGUAGES).toContain(c);
    }
  });

  it("drops a language the batch endpoints do not serve instead of 400ing the clip", async () => {
    // Polish and Ukrainian were picker entries that the socket quietly turned
    // into automatic while the recorded path posted them and got
    // 400 Bad Request — live words, then "That recording could not be read".
    for (const value of ["pl", "uk"]) {
      const config = await sentConfig({ subjectId: "course_transformers_w4", languageCodes: value });
      expect(config.language_codes).toBeUndefined();
    }
  });

  it("does not offer a language neither endpoint transcribes", () => {
    for (const preset of LANGUAGE_PRESETS) {
      for (const code of preset.value.split(",")) {
        expect([...BATCH_LANGUAGES, AUTO_LANGUAGE]).toContain(code);
      }
    }
  });
});

describe("batchLanguageCodes", () => {
  it("is the same 32 codes the socket takes, minus the one that means automatic", () => {
    // Both enumerations are read out of the endpoints' own validation errors.
    // They coincide today; `multi` is the whole of the difference.
    expect(new Set(BATCH_LANGUAGES)).toEqual(new Set(STREAM_LANGUAGES));
    expect(BATCH_LANGUAGES as readonly string[]).not.toContain(AUTO_LANGUAGE);
  });

  it("normalises case and spacing, dedupes, and keeps three-letter codes", () => {
    expect(batchLanguageCodes([" EN ", "en", "Hi"])).toEqual(["en", "hi"]);
    // `yue` is on the endpoint's list and was dropped by a two-letter test.
    expect(batchLanguageCodes(["yue"])).toEqual(["yue"]);
  });

  it("turns anything the endpoint would refuse into detection, never a guess", () => {
    for (const junk of [["multi"], ["pl"], ["uk"], ["klingon", "!!"], [""], []]) {
      expect(batchLanguageCodes(junk)).toEqual([]);
    }
    expect(batchLanguageCodes(undefined)).toEqual([]);
  });
});
