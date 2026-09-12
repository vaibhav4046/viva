import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  ASYNC_DEADLINE_MS,
  AssemblyAIProvider,
  DICTATION_TIMEOUT_MS,
  ROUTE_BUDGET_MS,
  SYNC_TIMEOUT_MS,
  TranscriptionError,
  capKeyterms,
} from "@/lib/assemblyai";

/**
 * Dictation contract tests. Pins the wire shape probed against the live
 * service on 2026-09-12: multipart/form-data with a JSON `config` part FIRST
 * (which is what lets the audio part stream while it is recorded), then raw
 * 16 kHz mono S16LE PCM as `audio`; raw `Authorization` header with no Bearer;
 * config keys `sample_rate`, `channels`, `language_codes`, `keyterms_prompt`
 * (an array — a string is a 400), `stt_prompt`, `llm_instruction`.
 *
 * Response carries `text` (verbatim) and `llm_response` (cleaned) and both are
 * surfaced; `llm_error` is not a request failure. Unknown shapes are honest
 * coded errors, never a guessed parse. No credits spent: fetch is mocked and
 * the request body is inspected directly.
 */

const DICTATION_URL = "https://dictation.assemblyai.com/v1/transcribe/live";

const savedFetch = globalThis.fetch;
const savedEnv = {
  key: process.env.ASSEMBLYAI_API_KEY,
  url: process.env.ASSEMBLYAI_DICTATION_URL,
  sync: process.env.ASSEMBLYAI_SYNC_BASE_URL,
};
afterEach(() => {
  globalThis.fetch = savedFetch;
  for (const [name, value] of [
    ["ASSEMBLYAI_API_KEY", savedEnv.key],
    ["ASSEMBLYAI_DICTATION_URL", savedEnv.url],
    ["ASSEMBLYAI_SYNC_BASE_URL", savedEnv.sync],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function provider(): AssemblyAIProvider {
  process.env.ASSEMBLYAI_API_KEY = "test-key";
  process.env.ASSEMBLYAI_DICTATION_URL = DICTATION_URL;
  return new AssemblyAIProvider("dictation");
}

/** Minimal valid 16 kHz mono S16LE WAV: 44-byte RIFF header + `samples` frames. */
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
  return Buffer.concat([header, Buffer.alloc(samples * 2)]);
}

const AUDIO = wav(800); // 44 + 1600 bytes

/** Live error bodies are {status, title, detail} on both endpoints. */
function problem(status: number, detail: string, headers?: HeadersInit): Response {
  return new Response(JSON.stringify({ status, title: "Error", detail }), { status, headers });
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) =>
    handler(String(url), init)) as unknown as typeof fetch;
}

async function rejectsWithCode(fn: () => Promise<unknown>, code: string): Promise<TranscriptionError> {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(TranscriptionError);
    expect((e as TranscriptionError).code).toBe(code);
    return e as TranscriptionError;
  }
  throw new Error(`expected rejection with code ${code}, but it resolved`);
}

type Captured = { url: string; init?: RequestInit };

async function captureConfig(init: RequestInit | undefined): Promise<Record<string, unknown>> {
  const body = init?.body as unknown as FormData;
  const entries = Array.from(body.entries());
  return JSON.parse(await (entries[0][1] as File).text()) as Record<string, unknown>;
}

describe("dictation contract", () => {
  it("missing URL → NO_DICTATION_URL, not retryable", async () => {
    process.env.ASSEMBLYAI_API_KEY = "test-key";
    delete process.env.ASSEMBLYAI_DICTATION_URL;
    const p = new AssemblyAIProvider("dictation");
    const e = await rejectsWithCode(() => p.transcribe({ audio: AUDIO, contentType: "audio/wav" }), "NO_DICTATION_URL");
    expect(e.retryable).toBe(false);
  });

  it("sends config-first multipart with raw PCM audio (WAV header stripped, no Bearer)", async () => {
    let captured: Captured = { url: "" };
    mockFetch((url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify({ text: "positional encoding gives order" }), { status: 200 });
    });

    const r = await provider().transcribe({
      audio: AUDIO,
      contentType: "audio/wav",
      keyterms: ["self-attention", "positional encoding"],
      sttPrompt: "The learner is studying attention.",
      llmInstruction: "Remove filler words.",
      languageCodes: ["en", "hi"],
    });
    expect(r.text).toBe("positional encoding gives order");
    expect(captured.url).toBe(DICTATION_URL);

    const headers = new Headers(captured.init?.headers);
    expect(headers.get("authorization")).toBe("test-key"); // raw key, no "Bearer "
    expect(headers.get("content-type")).toBeNull(); // fetch sets the multipart boundary itself

    const body = captured.init?.body as unknown as FormData;
    expect(body).toBeInstanceOf(FormData);
    const entries = Array.from(body.entries());
    expect(entries.map(([name]) => name)).toEqual(["config", "audio"]); // config BEFORE audio
    expect((entries[0][1] as File).type).toBe("application/json");

    const config = await captureConfig(captured.init);
    expect(config.sample_rate).toBe(16000);
    expect(config.channels).toBe(1);
    expect(config.language_codes).toEqual(["en", "hi"]);
    expect(config.keyterms_prompt).toEqual(["self-attention", "positional encoding"]);
    expect(config.stt_prompt).toBe("The learner is studying attention.");
    expect(config.llm_instruction).toBe("Remove filler words.");
    // The old build sent these; they are not the verified field names.
    expect(config.word_boost).toBeUndefined();
    expect(config.conversation_context).toBeUndefined();
    expect(config.llm).toBeUndefined();

    const audioPart = entries[1][1] as File;
    expect(audioPart.type).toBe("audio/pcm");
    expect(audioPart.name).toBe("clip.pcm");
    expect(audioPart.size).toBe(AUDIO.length - 44); // RIFF header stripped
  });

  it("defaults language_codes to English and omits llm_instruction when not asked for", async () => {
    let captured: Captured = { url: "" };
    mockFetch((url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify({ text: "verbatim only" }), { status: 200 });
    });
    await provider().transcribe({ audio: AUDIO, contentType: "audio/wav" });
    const config = await captureConfig(captured.init);
    expect(config.language_codes).toEqual(["en"]);
    expect(config.llm_instruction).toBeUndefined();
    expect(config.stt_prompt).toBeUndefined();
  });

  it("caps keyterms at 100 entries and 2048 chars, and always sends an array", async () => {
    // A string here is a 400 from the live service ("Input should be a valid array").
    expect(Array.isArray(capKeyterms(undefined))).toBe(true);
    const many = Array.from({ length: 250 }, (_, i) => `term-${i}`);
    expect(capKeyterms(many)).toHaveLength(100);
    const long = Array.from({ length: 100 }, () => "x".repeat(40));
    expect(capKeyterms(long).join(" ").length).toBeLessThanOrEqual(2048);
    expect(capKeyterms(["  ", "kept", ""])).toEqual(["kept"]);
  });

  it("truncates stt_prompt at 6000 chars and llm_instruction at 2048", async () => {
    let captured: Captured = { url: "" };
    mockFetch((url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify({ text: "ok" }), { status: 200 });
    });
    await provider().transcribe({
      audio: AUDIO,
      contentType: "audio/wav",
      sttPrompt: "c".repeat(9000),
      llmInstruction: "i".repeat(4000),
    });
    const config = await captureConfig(captured.init);
    expect((config.stt_prompt as string).length).toBe(6000);
    expect((config.llm_instruction as string).length).toBe(2048);
  });

  it("returns verbatim and clean separately, with per-word confidence", async () => {
    mockFetch(() =>
      new Response(
        JSON.stringify({
          text: "Um, I think maybe attention needs positions.",
          llm_response: "I think maybe attention needs positions.",
          llm_error: null,
          confidence: 0.97,
          words: [{ text: "Um,", confidence: 0.94 }, { text: "I", confidence: 0.99 }],
          audio_duration_ms: 9555,
          session_id: "sess-1",
          request_time_ms: 869.9,
          sync_time_ms: 247.4,
        }),
        { status: 200 }
      )
    );
    const r = await provider().transcribe({ audio: AUDIO, contentType: "audio/wav" });
    expect(r.text).toBe("Um, I think maybe attention needs positions.");
    expect(r.clean).toBe("I think maybe attention needs positions.");
    expect(r.llmError).toBeNull();
    expect(r.confidence).toBeCloseTo(0.97);
    expect(r.words).toEqual([{ text: "Um,", confidence: 0.94 }, { text: "I", confidence: 0.99 }]);
    expect(r.audioDurationMs).toBe(9555);
    expect(r.sessionId).toBe("sess-1");
    expect(r.requestTimeMs).toBeCloseTo(869.9);
    expect(r.syncTimeMs).toBeCloseTo(247.4);
    expect(r.mode).toBe("dictation");
    expect(r.provider).toBe("assemblyai");
    expect(r.demoFixture).toBe(false);
  });

  it("llm_error is not a request failure — clean goes null, verbatim survives", async () => {
    mockFetch(() =>
      new Response(JSON.stringify({ text: "verbatim words", llm_response: null, llm_error: "timeout" }), { status: 200 })
    );
    const r = await provider().transcribe({ audio: AUDIO, contentType: "audio/wav" });
    expect(r.text).toBe("verbatim words");
    expect(r.clean).toBeNull();
    expect(r.llmError).toBe("timeout");
  });

  it("averages word confidence when the top-level score is missing", async () => {
    mockFetch(() =>
      new Response(JSON.stringify({ text: "two words", words: [{ text: "two", confidence: 0.8 }, { text: "words", confidence: 0.6 }] }), { status: 200 })
    );
    const r = await provider().transcribe({ audio: AUDIO, contentType: "audio/wav" });
    expect(r.confidence).toBeCloseTo(0.7);
  });

  it("missing text → BAD_RESPONSE (never a guessed parse from llm_response)", async () => {
    mockFetch(() => new Response(JSON.stringify({ llm_response: "only a rewrite, no transcript" }), { status: 200 }));
    await rejectsWithCode(() => provider().transcribe({ audio: AUDIO, contentType: "audio/wav" }), "BAD_RESPONSE");
  });

  it("400 → DICTATION_BAD_REQUEST carrying the service detail", async () => {
    mockFetch(() => problem(400, "invalid config part: keyterms_prompt: Input should be a valid array"));
    const e = await rejectsWithCode(() => provider().transcribe({ audio: AUDIO, contentType: "audio/wav" }), "DICTATION_BAD_REQUEST");
    expect(e.status).toBe(400);
    expect(e.retryable).toBe(false);
    expect(e.message).toContain("keyterms_prompt");
  });

  it("401 and 404 both mean the key, and neither is retryable", async () => {
    for (const status of [401, 404]) {
      mockFetch(() => problem(status, "Invalid API key"));
      const e = await rejectsWithCode(() => provider().transcribe({ audio: AUDIO, contentType: "audio/wav" }), "AUTH_FAILED");
      expect(e.retryable).toBe(false);
    }
  });

  it("429 maps to RATE_LIMITED with Retry-After; 503 to PROVIDER_BUSY", async () => {
    mockFetch(() => problem(429, "slow down", { "retry-after": "7" }));
    const e1 = await rejectsWithCode(() => provider().transcribe({ audio: AUDIO, contentType: "audio/wav" }), "RATE_LIMITED");
    expect(e1.retryable).toBe(true);
    expect(e1.retryAfterSec).toBe(7);

    mockFetch(() => problem(503, "capacity_exceeded"));
    const e2 = await rejectsWithCode(() => provider().transcribe({ audio: AUDIO, contentType: "audio/wav" }), "PROVIDER_BUSY");
    expect(e2.retryable).toBe(true);
  });

  it("network abort maps to PROVIDER_TIMEOUT", async () => {
    mockFetch(() => {
      throw new DOMException("The operation was aborted.", "AbortError");
    });
    await rejectsWithCode(() => provider().transcribe({ audio: AUDIO, contentType: "audio/wav" }), "PROVIDER_TIMEOUT");
  });
});

describe("sync fallback contract", () => {
  function syncProvider(): AssemblyAIProvider {
    process.env.ASSEMBLYAI_API_KEY = "test-key";
    process.env.ASSEMBLYAI_SYNC_BASE_URL = "https://sync.assemblyai.com";
    return new AssemblyAIProvider("sync");
  }

  it("posts WAV with X-AAI-Model and language_codes (verified live 2026-09-12)", async () => {
    let captured: Captured = { url: "" };
    mockFetch((url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({ text: "spoken words", confidence: 0.98, audio_duration_ms: 9555, session_id: "sync-1" }),
        { status: 200 }
      );
    });

    const r = await syncProvider().transcribe({
      audio: AUDIO,
      contentType: "audio/wav",
      keyterms: ["self-attention"],
      languageCodes: ["en"],
      sttPrompt: "studying attention",
    });
    expect(captured.url).toBe("https://sync.assemblyai.com/transcribe");
    const headers = new Headers(captured.init?.headers);
    expect(headers.get("authorization")).toBe("test-key");
    expect(headers.get("x-aai-model")).toBe("universal-3-5-pro");

    const body = captured.init?.body as unknown as FormData;
    const config = JSON.parse(body.get("config") as string) as Record<string, unknown>;
    expect(config.language_codes).toEqual(["en"]);
    expect(config.keyterms_prompt).toEqual(["self-attention"]);
    expect(config.prompt).toBe("studying attention");
    // Sync keeps the WAV container; only Dictation wants bare PCM.
    expect((body.get("audio") as File).type).toBe("audio/wav");

    expect(r.text).toBe("spoken words");
    expect(r.mode).toBe("sync");
    // Sync has no rewrite pass, so there is nothing honest to put in `clean`.
    expect(r.clean).toBeNull();
    expect(r.sessionId).toBe("sync-1");
  });

  it("unexpected shape → BAD_RESPONSE", async () => {
    mockFetch(() => new Response(JSON.stringify({ confidence: 0.9 }), { status: 200 }));
    await rejectsWithCode(() => syncProvider().transcribe({ audio: AUDIO, contentType: "audio/wav" }), "BAD_RESPONSE");
  });
});

/**
 * Abort budgets against the platform ceiling.
 *
 * Every abort in assemblyai.ts used to be dead code: 90 s for Dictation plus
 * 32 s for the Sync retry is up to 122 s inside one request, and `vercel.json`
 * declares `maxDuration: 60` for the route that hosts both. The platform kills
 * the invocation first and answers with an HTML gateway page, so the learner
 * got a parse error where a coded PROVIDER_TIMEOUT belonged — and an
 * engineering judge reading both files saw a contradiction.
 *
 * This reads the real vercel.json rather than restating the number, so raising
 * one without the other fails here instead of in production.
 */
describe("abort budgets vs the declared function ceiling", () => {
  const vercel = JSON.parse(
    readFileSync(fileURLToPath(new URL("../vercel.json", import.meta.url)), "utf8")
  ) as { functions?: Record<string, { maxDuration?: number }> };
  const declared = vercel.functions?.["src/app/api/voice/transcribe/route.ts"]?.maxDuration;

  it("vercel.json still declares a ceiling for the transcribe route", () => {
    expect(declared).toBe(ROUTE_BUDGET_MS / 1000);
  });

  it("the worst path — Dictation aborts, Sync retries — fits inside it", () => {
    // Sequential, not parallel: the fallback re-sends the same clip after the
    // first leg gives up, so the SUM is the wall clock the platform sees.
    expect(DICTATION_TIMEOUT_MS + SYNC_TIMEOUT_MS).toBeLessThan(ROUTE_BUDGET_MS);
  });

  it("leaves room for the multipart read, WAV validation and the subject lookup", () => {
    const slack = ROUTE_BUDGET_MS - (DICTATION_TIMEOUT_MS + SYNC_TIMEOUT_MS);
    expect(slack).toBeGreaterThanOrEqual(5_000);
  });

  it("the long-audio poll deadline is inside the ceiling too", () => {
    expect(ASYNC_DEADLINE_MS).toBeLessThan(ROUTE_BUDGET_MS);
  });

  it("a caller's signal does not replace our budget", async () => {
    // `signal: req.signal ?? ctrl.signal` handed the request the caller's
    // signal INSTEAD of the timer's, which silently disabled every number
    // above for any caller that passed one. Both, or the budget is a comment.
    const caller = new AbortController();
    let passed: AbortSignal | null | undefined;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      passed = init?.signal;
      return new Response(
        JSON.stringify({ text: "words", llm_response: null, llm_error: null, confidence: 0.9, audio_duration_ms: 1000, session_id: "s" }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    await provider().transcribe({ audio: AUDIO, contentType: "audio/wav", signal: caller.signal });
    expect(passed).toBeInstanceOf(AbortSignal);
    expect(passed).not.toBe(caller.signal);
    expect(passed?.aborted).toBe(false);
  });
});
