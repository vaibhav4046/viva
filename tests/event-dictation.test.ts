import { afterEach, describe, expect, it } from "vitest";
import { AssemblyAIProvider, TranscriptionError } from "@/lib/assemblyai";

/**
 * Event-dictation (hackathon beta endpoint) contract tests — §76 J1 fix.
 * Pins the REAL beta contract (AssemblyAI/blurt source, verified against the
 * live service 2026-09-08/09): multipart/form-data with a JSON `config` part
 * FIRST, then raw 16 kHz mono S16LE PCM as `audio`; response {text,
 * llm_response, llm_error}. Unknown shapes are honest coded errors (never a
 * guessed parse); errors are mapped deterministically. No credits spent:
 * global fetch is mocked and the request body is inspected directly.
 */

const savedFetch = globalThis.fetch;
const savedEnv = {
  key: process.env.ASSEMBLYAI_API_KEY,
  url: process.env.ASSEMBLYAI_DICTATION_URL,
};
afterEach(() => {
  globalThis.fetch = savedFetch;
  if (savedEnv.key === undefined) delete process.env.ASSEMBLYAI_API_KEY; else process.env.ASSEMBLYAI_API_KEY = savedEnv.key;
  if (savedEnv.url === undefined) delete process.env.ASSEMBLYAI_DICTATION_URL; else process.env.ASSEMBLYAI_DICTATION_URL = savedEnv.url;
});

function provider(): AssemblyAIProvider {
  process.env.ASSEMBLYAI_API_KEY = "test-key";
  process.env.ASSEMBLYAI_DICTATION_URL = "https://dictation.assemblyai.com/v1/transcribe/live";
  return new AssemblyAIProvider("event-dictation");
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

describe("event-dictation contract (§76 J1)", () => {
  it("missing URL → NO_DICTATION_URL, not retryable", async () => {
    process.env.ASSEMBLYAI_API_KEY = "test-key";
    delete process.env.ASSEMBLYAI_DICTATION_URL;
    const p = new AssemblyAIProvider("event-dictation");
    const e = await rejectsWithCode(() => p.transcribe({ audio: AUDIO, contentType: "audio/wav" }), "NO_DICTATION_URL");
    expect(e.retryable).toBe(false);
  });

  it("sends config-first multipart with raw PCM audio (WAV header stripped, no Bearer)", async () => {
    let captured: { url: string; init?: RequestInit } = { url: "" };
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init };
      return new Response(JSON.stringify({ text: "positional encoding gives order" }), { status: 200 });
    }) as unknown as typeof fetch;

    const r = await provider().transcribe({ audio: AUDIO, contentType: "audio/wav" });
    expect(r.text).toBe("positional encoding gives order");
    expect(captured.url).toBe("https://dictation.assemblyai.com/v1/transcribe/live");

    const headers = new Headers(captured.init?.headers);
    expect(headers.get("authorization")).toBe("test-key"); // raw key, no "Bearer "
    expect(headers.get("content-type")).toBeNull(); // fetch sets the multipart boundary itself

    const body = captured.init?.body as unknown as FormData;
    expect(body).toBeInstanceOf(FormData);
    const entries = Array.from(body.entries());
    expect(entries.map(([name]) => name)).toEqual(["config", "audio"]);
    expect((entries[0][1] as File).type).toBe("application/json");

    const config = JSON.parse(await (entries[0][1] as File).text()) as {
      sample_rate: number;
      channels: number;
      word_boost: string[];
      llm: { instruction: string };
    };
    expect(config.sample_rate).toBe(16000);
    expect(config.channels).toBe(1);
    expect(Array.isArray(config.word_boost)).toBe(true);
    expect(config.word_boost.reduce((n, t) => n + t.length, 0)).toBeLessThanOrEqual(2048);
    expect(typeof config.llm.instruction).toBe("string");
    expect(config.llm.instruction.length).toBeLessThanOrEqual(2048);

    const audioPart = entries[1][1] as File;
    expect(audioPart.type).toBe("audio/pcm");
    expect(audioPart.name).toBe("clip.pcm");
    expect(audioPart.size).toBe(AUDIO.length - 44); // RIFF header stripped
  });

  it("accepted {text} shape maps with honest provenance", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ text: "positional encoding gives order" }), { status: 200 })) as unknown as typeof fetch;
    const r = await provider().transcribe({ audio: AUDIO, contentType: "audio/wav" });
    expect(r.text).toBe("positional encoding gives order");
    expect(r.confidence).toBeNull();
    expect(r.mode).toBe("event-dictation");
    expect(r.provider).toBe("assemblyai");
    expect(r.demoFixture).toBe(false);
  });

  it("tolerates {text, llm_response, llm_error} — verbatim text wins", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ text: "verbatim words", llm_response: "cleaned words", llm_error: null }), { status: 200 })) as unknown as typeof fetch;
    const r = await provider().transcribe({ audio: AUDIO, contentType: "audio/wav" });
    expect(r.text).toBe("verbatim words");
  });

  it("missing text → BAD_RESPONSE (never a guessed parse)", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ llm_response: "only a rewrite, no transcript" }), { status: 200 })) as unknown as typeof fetch;
    await rejectsWithCode(() => provider().transcribe({ audio: AUDIO, contentType: "audio/wav" }), "BAD_RESPONSE");
  });

  it("400 multipart shape error → DICTATION_BAD_REQUEST with the service message", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: "request must be multipart/form-data with a `config` part followed by an `audio` part",
          error_code: "bad_request",
        }),
        { status: 400 }
      )) as unknown as typeof fetch;
    const e = await rejectsWithCode(() => provider().transcribe({ audio: AUDIO, contentType: "audio/wav" }), "DICTATION_BAD_REQUEST");
    expect(e.status).toBe(400);
    expect(e.retryable).toBe(false);
    expect(e.message).toContain("multipart/form-data");
  });

  it("401 maps to AUTH_FAILED (not retryable); 429 maps to RATE_LIMITED with Retry-After", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ detail: "bad key" }), { status: 401 })) as unknown as typeof fetch;
    const e1 = await rejectsWithCode(() => provider().transcribe({ audio: AUDIO, contentType: "audio/wav" }), "AUTH_FAILED");
    expect(e1.retryable).toBe(false);

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ detail: "slow down" }), { status: 429, headers: { "retry-after": "7" } })) as unknown as typeof fetch;
    const e2 = await rejectsWithCode(() => provider().transcribe({ audio: AUDIO, contentType: "audio/wav" }), "RATE_LIMITED");
    expect(e2.retryable).toBe(true);
    expect(e2.retryAfterSec).toBe(7);
  });

  it("network abort maps to PROVIDER_TIMEOUT", async () => {
    globalThis.fetch = (async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    }) as unknown as typeof fetch;
    await rejectsWithCode(() => provider().transcribe({ audio: AUDIO, contentType: "audio/wav" }), "PROVIDER_TIMEOUT");
  });
});
