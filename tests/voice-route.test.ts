import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST, condenseContext, subjectVoiceConfig } from "@/app/api/voice/transcribe/route";
import { GET as WARM } from "@/app/api/voice/warm/route";
import { assemblyAIBreaker } from "@/lib/circuit";
import { VOICE_MESSAGES } from "@/lib/audio/messages";

/**
 * /api/voice/transcribe. The route's job is the part the provider cannot do:
 * build config from the subject, fall back from Dictation to Sync when the
 * service (not the audio) fails, and turn every failure into one plain
 * sentence with no status code, vendor name or stack trace in it.
 */

const DICTATION_URL = "https://dictation.assemblyai.com/v1/transcribe/live";
const SYNC_URL = "https://sync.assemblyai.com/transcribe";

const savedFetch = globalThis.fetch;
const savedEnv = { ...process.env };

beforeEach(() => {
  process.env.ASSEMBLYAI_API_KEY = "test-key";
  process.env.ASSEMBLYAI_DICTATION_URL = DICTATION_URL;
  process.env.ASSEMBLYAI_TRANSCRIPTION_MODE = "dictation";
  assemblyAIBreaker.success(); // a previous test's failures must not leak
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  process.env = { ...savedEnv };
  assemblyAIBreaker.success();
});

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

/** 1 s of 16 kHz audio: comfortably over the 80 ms floor. */
const AUDIO = wav(16000);

function request(fields: Record<string, string> = {}, audio: Buffer = AUDIO): Request {
  const form = new FormData();
  form.append("audio", new Blob([new Uint8Array(audio)], { type: "audio/wav" }), "clip.wav");
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  // A fresh IP per request keeps the shared rate limiter out of these tests.
  const ip = `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  return new Request("http://localhost/api/voice/transcribe", {
    method: "POST",
    body: form,
    headers: { "x-forwarded-for": ip },
  });
}

const okDictation = {
  text: "Um, I think attention needs positions.",
  llm_response: "I think attention needs positions.",
  llm_error: null,
  confidence: 0.96,
  words: [{ text: "Um,", confidence: 0.94 }],
  audio_duration_ms: 9555,
  session_id: "sess-1",
  request_time_ms: 870,
  sync_time_ms: 247,
};

type Call = { url: string; init?: RequestInit };

function mockCalls(handler: (url: string, init?: RequestInit) => Response): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as unknown as typeof fetch;
  return calls;
}

function problem(status: number, detail = "nope"): Response {
  return new Response(JSON.stringify({ status, title: "Error", detail }), { status });
}

async function configOf(call: Call): Promise<Record<string, unknown>> {
  const body = call.init?.body as unknown as FormData;
  const part = body.get("config");
  const text = typeof part === "string" ? part : await (part as File).text();
  return JSON.parse(text) as Record<string, unknown>;
}

describe("subject keyterms", () => {
  const U = "u_keyterms_probe";

  it("come from the subject, not a hardcoded Transformers list", async () => {
    const transformers = (await subjectVoiceConfig(U, "course_transformers_w4")).keyterms.map((t) => t.toLowerCase());
    const probability = (await subjectVoiceConfig(U, "course_probability")).keyterms.map((t) => t.toLowerCase());
    expect(transformers).toContain("self-attention");
    expect(probability.some((t) => t.includes("bayes"))).toBe(true);
    // The old build biased every subject towards attention; this is the guard.
    expect(probability).not.toContain("self-attention");
  });

  it("dedupes and never exceeds the 100-term ceiling", async () => {
    const terms = (await subjectVoiceConfig(U, "course_transformers_w4")).keyterms;
    expect(terms.length).toBeLessThanOrEqual(100);
    expect(new Set(terms.map((t) => t.toLowerCase())).size).toBe(terms.length);
  });

  it("an unknown subject falls back to the default rather than sending nothing", async () => {
    expect((await subjectVoiceConfig(U, "course_does_not_exist")).keyterms.length).toBeGreaterThan(0);
  });
});

describe("context condensing", () => {
  it("strips speaker labels — a labelled prompt leaks into the transcript", () => {
    // Probed live 2026-09-12: stt_prompt "Student: ..." produced a transcript
    // that began "Student:", words the learner never said.
    expect(condenseContext(["Student: I read about attention.", "VIVA: What stuck?"]))
      .toBe("I read about attention. What stuck?");
  });

  it("keeps at most the last six turns, newest first out of the budget", () => {
    const turns = Array.from({ length: 10 }, (_, i) => `turn ${i}`);
    const out = condenseContext(turns);
    expect(out).toBe("turn 4 turn 5 turn 6 turn 7 turn 8 turn 9");
  });

  it("never exceeds the 6000-char cap", () => {
    const out = condenseContext([("x".repeat(2000) + " ").repeat(1).trim(), "y".repeat(5000)], 6000);
    expect(out.length).toBeLessThanOrEqual(6000);
  });

  it("empty context produces an empty prompt, not a stray space", () => {
    expect(condenseContext([])).toBe("");
    expect(condenseContext(["   "])).toBe("");
  });
});

describe("POST /api/voice/transcribe", () => {
  it("returns the documented field set with verbatim and clean split", async () => {
    mockCalls(() => new Response(JSON.stringify(okDictation), { status: 200 }));
    const res = await POST(request({ subjectId: "course_transformers_w4", mode: "study" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body)).toEqual(
      expect.arrayContaining([
        "verbatim", "clean", "confidence", "words", "requestTimeMs",
        "syncTimeMs", "audioMs", "sessionId", "mode", "llmError",
      ])
    );
    expect(body.verbatim).toBe("Um, I think attention needs positions.");
    expect(body.clean).toBe("I think attention needs positions.");
    expect(body.mode).toBe("dictation");
    expect(body.requestTimeMs).toBe(870);
    expect(body.fellBackFrom).toBeNull();
  });

  it("verbatim mode omits llm_instruction and reports clean as the spoken text", async () => {
    const calls = mockCalls(() => new Response(JSON.stringify(okDictation), { status: 200 }));
    const res = await POST(request({ subjectId: "course_transformers_w4", mode: "verbatim" }));
    const config = await configOf(calls[0]);
    expect(config.llm_instruction).toBeUndefined();
    const body = await res.json();
    expect(body.clean).toBe(body.verbatim);
  });

  it("study mode sends the hedge-preserving instruction and the subject's keyterms", async () => {
    const calls = mockCalls(() => new Response(JSON.stringify(okDictation), { status: 200 }));
    await POST(request({ subjectId: "course_transformers_w4", context: "Student: we did attention\nVIVA: and?" }));
    const config = await configOf(calls[0]);
    expect(String(config.llm_instruction)).toContain("I think");
    expect(String(config.llm_instruction)).toContain("Keep negations");
    expect((config.keyterms_prompt as string[]).length).toBeGreaterThan(0);
    expect(config.stt_prompt).toBe("we did attention and?");
  });

  it("parses languageCodes from a comma list and from JSON, dropping junk", async () => {
    for (const [input, expected] of [
      ["en,hi", ["en", "hi"]],
      ['["en","hi"]', ["en", "hi"]],
      ["EN , Hi", ["en", "hi"]],
      ["klingon,!!", ["en"]],
      ["", ["en"]],
    ] as const) {
      const calls = mockCalls(() => new Response(JSON.stringify(okDictation), { status: 200 }));
      await POST(request({ subjectId: "course_transformers_w4", languageCodes: input }));
      expect(await configOf(calls[0]).then((c) => c.language_codes)).toEqual(expected);
    }
  });

  it("a failed rewrite falls back to verbatim rather than showing nothing", async () => {
    mockCalls(() =>
      new Response(JSON.stringify({ ...okDictation, llm_response: null, llm_error: "timeout" }), { status: 200 })
    );
    const body = await (await POST(request({ subjectId: "course_transformers_w4" }))).json();
    expect(body.llmError).toBe("timeout");
    expect(body.clean).toBe(body.verbatim);
  });
});

describe("Dictation → Sync fallback", () => {
  const serviceFaults: [number, string][] = [
    [401, "AUTH_FAILED"],
    [404, "AUTH_FAILED"],
    [429, "RATE_LIMITED"],
    [500, "TRANSCRIPTION_FAILED"],
    [503, "PROVIDER_BUSY"],
  ];

  for (const [status, code] of serviceFaults) {
    it(`${status} on Dictation retries on Sync and tags the fallback`, async () => {
      const calls = mockCalls((url) =>
        url === DICTATION_URL
          ? problem(status)
          : new Response(JSON.stringify({ text: "sync words", confidence: 0.9, audio_duration_ms: 9555, session_id: "s" }), { status: 200 })
      );
      const res = await POST(request({ subjectId: "course_transformers_w4" }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(calls.map((c) => c.url)).toEqual([DICTATION_URL, SYNC_URL]);
      expect(body.mode).toBe("sync");
      expect(body.fellBackFrom).toBe(code);
      expect(body.verbatim).toBe("sync words");
    });
  }

  it("a timeout on Dictation also falls back", async () => {
    let first = true;
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (first) {
        first = false;
        throw new DOMException("aborted", "AbortError");
      }
      expect(String(url)).toBe(SYNC_URL);
      return new Response(JSON.stringify({ text: "sync words", confidence: 0.9, audio_duration_ms: 9555, session_id: "s" }), { status: 200 });
    }) as unknown as typeof fetch;
    const body = await (await POST(request({ subjectId: "course_transformers_w4" }))).json();
    expect(body.fellBackFrom).toBe("PROVIDER_TIMEOUT");
    expect(body.mode).toBe("sync");
  });

  it("bad audio does NOT fall back — a second call would fail the same way", async () => {
    const calls = mockCalls(() => problem(400, "invalid config part"));
    const res = await POST(request({ subjectId: "course_transformers_w4" }));
    expect(calls).toHaveLength(1);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("DICTATION_BAD_REQUEST");
  });

  it("when Sync fails too, the learner gets Sync's coded error, not a 500", async () => {
    mockCalls((url) => problem(url === DICTATION_URL ? 503 : 429));
    const res = await POST(request({ subjectId: "course_transformers_w4" }));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(body.error.retryable).toBe(true);
  });
});

describe("error mapping", () => {
  it("every coded error is one plain sentence with no vendor detail or stack", async () => {
    const cases: [number, string, number][] = [
      [401, "AUTH_FAILED", 502],
      [413, "AUDIO_TOO_LONG", 413],
      [415, "UNSUPPORTED_FORMAT", 415],
      [429, "RATE_LIMITED", 429],
    ];
    for (const [upstream, code, expectedStatus] of cases) {
      // Both endpoints fail, so the mapping under test is the final one.
      mockCalls(() => problem(upstream, "raw vendor detail: Traceback (most recent call last)"));
      const res = await POST(request({ subjectId: "course_transformers_w4" }));
      const body = await res.json();
      expect(res.status).toBe(expectedStatus);
      expect(body.error.code).toBe(code);
      expect(body.error.message).toBe(VOICE_MESSAGES[code]);
      expect(body.error.message).not.toContain("Traceback");
      expect(body.error.message).not.toMatch(/\b(4|5)\d\d\b/);
      expect(body.error.message.split(". ").length).toBeLessThanOrEqual(2);
      expect(body).not.toHaveProperty("stack");
    }
  });

  it("a clip under 80 ms is rejected before a single credit is spent", async () => {
    const calls = mockCalls(() => new Response("{}", { status: 200 }));
    const res = await POST(request({ subjectId: "course_transformers_w4" }, wav(100)));
    expect(calls).toHaveLength(0);
    expect(res.status).toBe(415);
    expect((await res.json()).error.code).toBe("AUDIO_TOO_SHORT");
  });

  it("a request with no audio part is a coded error, not a crash", async () => {
    const form = new FormData();
    form.append("subjectId", "course_transformers_w4");
    const res = await POST(new Request("http://localhost/api/voice/transcribe", { method: "POST", body: form }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("EMPTY_AUDIO");
  });

  it("a missing key is honest — never a fabricated transcript", async () => {
    delete process.env.ASSEMBLYAI_API_KEY;
    mockCalls(() => new Response(JSON.stringify(okDictation), { status: 200 }));
    const res = await POST(request({ subjectId: "course_transformers_w4" }));
    const body = await res.json();
    expect(body.error.code).toBe("NO_API_KEY");
    expect(body).not.toHaveProperty("verbatim");
  });
});

describe("GET /api/voice/warm", () => {
  it("is 204 even when the upstream warm call fails", async () => {
    mockCalls(() => {
      throw new Error("upstream down");
    });
    const res = await WARM();
    expect(res.status).toBe(204);
  });

  it("hits the warm endpoint without sending the API key", async () => {
    const calls = mockCalls(() => new Response(null, { status: 200 }));
    await WARM();
    expect(calls[0].url).toBe("https://dictation.assemblyai.com/warm");
    expect(new Headers(calls[0].init?.headers).get("authorization")).toBeNull();
  });
});
