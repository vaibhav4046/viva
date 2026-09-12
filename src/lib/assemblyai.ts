/**
 * TranscriptionProvider — AssemblyAI behind a stable interface.
 * Key never reaches the browser; all calls are server-side.
 *
 * Modes (ASSEMBLYAI_TRANSCRIPTION_MODE, default "sync"):
 * - "sync":            POST {syncBase}/transcribe, multipart audio+config,
 *                       X-AAI-Model: universal-3-5-pro. Verified contract.
 * - "event-dictation":  POST ASSEMBLYAI_DICTATION_URL (event beta endpoint).
 *                       Verified contract (AssemblyAI/blurt, 2026-09-08/09):
 *                       multipart/form-data, `config` part (application/json)
 *                       FIRST, then `audio` as raw 16 kHz mono S16LE PCM.
 *                       Response {text, llm_response, llm_error}; missing
 *                       `text` is an honest BAD_RESPONSE, never a guess.
 * - "async":            /v2/upload + /v2/transcript poll. NOT the hold-to-talk
 *                       path (poll loops don't belong in the hot path);
 *                       retained for long audio (lecture uploads).
 *
 * Production NEVER selects fixture transcription (see resolve + test).
 */

export type TranscriptionMode = "sync" | "event-dictation" | "async";

export type TranscriptionRequest = {
  audio: Buffer;
  contentType: string; // audio/wav or audio/pcm (validated upstream)
  keyterms?: string[];
  prompt?: string;
  languageCode?: string;
  conversationContext?: string[];
  signal?: AbortSignal;
};

export type TranscriptionResult = {
  text: string;
  confidence: number | null;
  words?: { text: string; confidence: number }[];
  audioDurationMs: number | null;
  sessionId: string | null;
  requestTimeMs: number | null;
  latencyMs: number;
  provider: "assemblyai" | "fixture";
  mode: TranscriptionMode;
  demoFixture: boolean;
};

export interface TranscriptionProvider {
  readonly name: string;
  transcribe(req: TranscriptionRequest): Promise<TranscriptionResult>;
}

export class TranscriptionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly retryAfterSec?: number
  ) {
    super(message);
  }
}

const COURSE_KEYTERMS = [
  "self-attention", "positional encoding", "positional information",
  "queries", "keys", "values", "multi-head attention",
  "backpropagation", "gradient descent", "learning rate",
  "policy iteration", "value iteration", "Bellman equation",
];

const COURSE_PROMPT =
  "A university student thinking aloud while studying neural networks (Transformers, attention, optimization, reinforcement learning). " +
  "Transcribe verbatim including technical terms, numbers, and negations.";

function baseUrl(): string {
  return (process.env.ASSEMBLYAI_BASE_URL ?? "https://api.assemblyai.com").replace(/\/$/, "");
}

function syncBase(): string {
  return (process.env.ASSEMBLYAI_SYNC_BASE_URL ?? "https://sync.assemblyai.com").replace(/\/$/, "");
}

function apiKey(): string {
  const k = process.env.ASSEMBLYAI_API_KEY;
  if (!k) throw new TranscriptionError("NO_API_KEY", "Live transcription needs ASSEMBLYAI_API_KEY.", 503, false);
  return k;
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function mapSyncError(status: number, body: unknown, retryAfterHeader: string | null): TranscriptionError {
  const b = (body ?? {}) as { error_code?: string; message?: string; detail?: string };
  const msg = b.message ?? b.detail ?? `AssemblyAI request failed (${status}).`;
  const retryAfterSec = retryAfterHeader ? Math.max(1, parseInt(retryAfterHeader, 10) || 1) : undefined;
  switch (status) {
    case 400: return new TranscriptionError("BAD_AUDIO", msg, 400, false);
    case 401: return new TranscriptionError("AUTH_FAILED", "AssemblyAI rejected the API key.", 502, false);
    case 413: return new TranscriptionError("AUDIO_TOO_LONG", "Clip exceeds 120 s / 40 MB.", 413, false);
    case 415: return new TranscriptionError("UNSUPPORTED_FORMAT", msg, 415, false);
    case 429: return new TranscriptionError("RATE_LIMITED", "AssemblyAI rate limit hit. Try again shortly.", 429, true, retryAfterSec ?? 5);
    case 503: return new TranscriptionError("PROVIDER_BUSY", "AssemblyAI is at capacity. Try again shortly.", 503, true, retryAfterSec ?? 5);
    case 504: return new TranscriptionError("PROVIDER_TIMEOUT", "AssemblyAI exceeded its 30 s deadline.", 504, true, 2);
    default: return new TranscriptionError("TRANSCRIPTION_FAILED", msg, 502, status >= 500);
  }
}

/** Dictation `word_boost`: flat array of terms, ≤2048 chars total (UTF-8). */
function dictationWordBoost(keyterms: string[] | undefined): string[] {
  const out: string[] = [];
  let budget = 2048;
  for (const t of (keyterms ?? COURSE_KEYTERMS)) {
    if (t.length + 1 > budget) break;
    out.push(t);
    budget -= t.length + 1;
  }
  return out;
}

/** Dictation `conversation_context`: ordered array, trimmed to ≤4096 chars. */
function dictationContext(ctx: string[] | undefined): string[] {
  if (!ctx?.length) return [];
  const out: string[] = [];
  let budget = 4096;
  for (let i = ctx.length - 1; i >= 0; i--) {
    const s = ctx[i];
    if (s.length > budget) break;
    out.unshift(s);
    budget -= s.length;
  }
  return out;
}

export class AssemblyAIProvider implements TranscriptionProvider {
  readonly name = "assemblyai";
  constructor(readonly mode: TranscriptionMode = "sync") {}

  transcribe(req: TranscriptionRequest): Promise<TranscriptionResult> {
    switch (this.mode) {
      case "sync": return this.transcribeSync(req);
      case "event-dictation": return this.transcribeEvent(req);
      case "async": return this.transcribeAsync(req);
    }
  }

  private async transcribeSync(req: TranscriptionRequest): Promise<TranscriptionResult> {
    const started = Date.now();
    const form = new FormData();
    const bytes = new Uint8Array(req.audio.buffer, req.audio.byteOffset, req.audio.byteLength);
    form.append("audio", new Blob([bytes as unknown as BlobPart], { type: "audio/wav" }), "clip.wav");
    // keyterms_prompt is an ARRAY of terms (≤2048 chars total), not a string.
    const terms: string[] = [];
    let budget = 2048;
    for (const t of (req.keyterms ?? COURSE_KEYTERMS)) {
      if (t.length + 1 > budget) break;
      terms.push(t);
      budget -= t.length + 1;
    }
    form.append("config", JSON.stringify({
      prompt: req.prompt ?? COURSE_PROMPT,
      keyterms_prompt: terms,
      language_code: req.languageCode ?? "en",
      conversation_context: req.conversationContext?.slice(-6),
      timestamps: false,
    }));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 32_000);
    try {
      const res = await fetch(`${syncBase()}/transcribe`, {
        method: "POST",
        headers: { Authorization: apiKey(), "X-AAI-Model": "universal-3-5-pro" },
        body: form,
        signal: req.signal ?? ctrl.signal,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw mapSyncError(res.status, body, res.headers.get("retry-after"));
      }
      const data = (await res.json()) as {
        text: string; confidence: number; words?: { text: string; confidence: number }[];
        audio_duration_ms: number; session_id: string; request_time_ms?: number;
      };
      if (typeof data.text !== "string") throw new TranscriptionError("BAD_RESPONSE", "AssemblyAI returned an unexpected shape.", 502, false);
      return {
        text: data.text, confidence: data.confidence ?? null,
        words: data.words, audioDurationMs: data.audio_duration_ms ?? null,
        sessionId: data.session_id ?? null, requestTimeMs: data.request_time_ms ?? null,
        latencyMs: Date.now() - started, provider: "assemblyai", mode: "sync", demoFixture: false,
      };
    } catch (e) {
      if (e instanceof TranscriptionError) throw e;
      if ((e as Error).name === "AbortError") throw new TranscriptionError("PROVIDER_TIMEOUT", "Transcription timed out.", 504, true, 2);
      throw new TranscriptionError("TRANSCRIPTION_FAILED", e instanceof Error ? e.message : "Transcription failed.", 502, true, 2);
    } finally {
      clearTimeout(timer);
    }
  }

  private async transcribeEvent(req: TranscriptionRequest): Promise<TranscriptionResult> {
    const started = Date.now();
    const url = process.env.ASSEMBLYAI_DICTATION_URL;
    if (!url) throw new TranscriptionError("NO_DICTATION_URL", "Event dictation mode needs ASSEMBLYAI_DICTATION_URL.", 503, false);

    // Live dictation wants raw 16 kHz mono S16LE PCM: our pipeline hands us a
    // data-prefixed WAV, so strip the 44-byte RIFF header (validated upstream).
    const bytes = new Uint8Array(req.audio.buffer, req.audio.byteOffset, req.audio.byteLength);
    const isRiff = bytes.length >= 44 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45;
    const pcm = isRiff ? bytes.subarray(44) : bytes;

    // Verified beta contract: multipart `config` FIRST (application/json),
    // then `audio` as raw PCM. Appending in this order is the wire contract.
    const config: Record<string, unknown> = {
      sample_rate: 16000,
      channels: 1,
      word_boost: dictationWordBoost(req.keyterms),
      llm: { instruction: (req.prompt ?? COURSE_PROMPT).slice(0, 2048) },
    };
    const context = dictationContext(req.conversationContext);
    if (context.length) config.conversation_context = context;
    const form = new FormData();
    form.append("config", new Blob([JSON.stringify(config)], { type: "application/json" }), "config.json");
    form.append("audio", new Blob([pcm as unknown as BlobPart], { type: "audio/pcm" }), "clip.pcm");

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 32_000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: apiKey() },
        body: form,
        signal: req.signal ?? ctrl.signal,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        if (res.status === 400) {
          // Live route: {"error":"request must be multipart/form-data ...","error_code":"bad_request"}
          const b = (body ?? {}) as { error?: string; message?: string; detail?: string };
          throw new TranscriptionError(
            "DICTATION_BAD_REQUEST",
            b.error ?? b.message ?? b.detail ?? "Dictation request was malformed.",
            400,
            false
          );
        }
        throw mapSyncError(res.status, body, res.headers.get("retry-after"));
      }
      const data = (await res.json()) as {
        text?: unknown;
        words?: unknown;
        confidence?: unknown;
        audio_duration_ms?: unknown;
        session_id?: unknown;
        request_time_ms?: unknown;
        llm_response?: unknown;
        llm_error?: unknown;
      };
      // `text` is the verbatim transcript and the only field we trust for
      // content. `llm_response` is a best-effort cleanup and never a
      // substitute — using it would let the model rewrite what the student
      // actually said, which is the one thing this product must not do.
      if (typeof data.text !== "string") {
        throw new TranscriptionError("BAD_RESPONSE", "Event endpoint returned no text.", 502, false);
      }

      // The beta endpoint returns the same provenance fields as the sync API
      // (confidence / session_id / audio_duration_ms), plus per-word scores.
      // An earlier version of this function discarded all of them and reported
      // nulls, which is why switching modes used to look like a downgrade.
      const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
      let confidence = num(data.confidence);
      if (confidence === null && Array.isArray(data.words)) {
        const scores = (data.words as Array<{ confidence?: unknown }>)
          .map((w) => num(w?.confidence))
          .filter((n): n is number => n !== null);
        if (scores.length) confidence = scores.reduce((a, b) => a + b, 0) / scores.length;
      }

      return {
        text: data.text,
        confidence,
        audioDurationMs: num(data.audio_duration_ms),
        sessionId: typeof data.session_id === "string" ? data.session_id : null,
        requestTimeMs: num(data.request_time_ms),
        latencyMs: Date.now() - started,
        provider: "assemblyai",
        mode: "event-dictation",
        demoFixture: false,
      };
    } catch (e) {
      if (e instanceof TranscriptionError) throw e;
      if ((e as Error).name === "AbortError") throw new TranscriptionError("PROVIDER_TIMEOUT", "Transcription timed out.", 504, true, 2);
      throw new TranscriptionError("TRANSCRIPTION_FAILED", e instanceof Error ? e.message : "Transcription failed.", 502, true, 2);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Long-audio path only (lecture uploads). Bounded server wait; NOT the hot path. */
  private async transcribeAsync(req: TranscriptionRequest): Promise<TranscriptionResult> {
    const started = Date.now();
    const key = apiKey();
    const up = await fetch(`${baseUrl()}/v2/upload`, {
      method: "POST", headers: { Authorization: key },
      body: new Uint8Array(req.audio.buffer, req.audio.byteOffset, req.audio.byteLength) as unknown as BodyInit,
    });
    if (!up.ok) throw new TranscriptionError("UPLOAD_FAILED", `Upload failed (${up.status}).`, 502, true, 2);
    const { upload_url } = (await up.json()) as { upload_url: string };
    const sub = await fetch(`${baseUrl()}/v2/transcript`, {
      method: "POST",
      headers: { Authorization: key, "Content-Type": "application/json" },
      body: JSON.stringify({
        audio_url: upload_url,
        speech_models: ["universal-3-5-pro", "universal-2"],
        language_detection: true,
        disfluencies: false, punctuate: true, format_text: true,
        keyterms_prompt: req.keyterms ?? COURSE_KEYTERMS,
      }),
    });
    if (!sub.ok) throw new TranscriptionError("SUBMIT_FAILED", `Submit failed (${sub.status}).`, 502, true, 2);
    const { id } = (await sub.json()) as { id: string };
    const deadline = Date.now() + 100_000;
    while (Date.now() < deadline) {
      await sleep(2500);
      const poll = await fetch(`${baseUrl()}/v2/transcript/${id}`, { headers: { Authorization: key } });
      if (!poll.ok) throw new TranscriptionError("POLL_FAILED", `Poll failed (${poll.status}).`, 502, true, 2);
      const t = (await poll.json()) as { status: string; text?: string; error?: string; confidence?: number };
      if (t.status === "completed") {
        return {
          text: t.text ?? "", confidence: t.confidence ?? null,
          audioDurationMs: null, sessionId: id, requestTimeMs: null,
          latencyMs: Date.now() - started, provider: "assemblyai", mode: "async", demoFixture: false,
        };
      }
      if (t.status === "error") throw new TranscriptionError("TRANSCRIPTION_FAILED", t.error ?? "Transcription failed.", 502, false);
    }
    throw new TranscriptionError("PROVIDER_TIMEOUT", "Transcription is still processing; try a shorter clip.", 504, true, 5);
  }
}

/** Test-only double. Refuses to run in production — loudly. */
export function assertFixtureAllowed(nodeEnv: string | undefined, allowFlag: string | undefined): void {
  if (nodeEnv === "production" && allowFlag !== "1") {
    throw new Error("Fixture transcription forbidden in production");
  }
}

export class FixtureTranscriptionProvider implements TranscriptionProvider {
  readonly name = "fixture";
  constructor(private text = "fixture transcript") {
    assertFixtureAllowed(process.env.NODE_ENV, process.env.ALLOW_FIXTURE_IN_PROD);
  }
  async transcribe(): Promise<TranscriptionResult> {
    // Provenance is honest: a fixture never claims to be AssemblyAI output.
    return {
      text: this.text, confidence: null, audioDurationMs: null, sessionId: null,
      requestTimeMs: null, latencyMs: 0, provider: "fixture", mode: "sync", demoFixture: true,
    };
  }
}

export function resolveTranscriptionMode(): TranscriptionMode {
  const m = (process.env.ASSEMBLYAI_TRANSCRIPTION_MODE ?? "sync").toLowerCase();
  if (m === "event-dictation" || m === "event" || m === "dictation") return "event-dictation";
  if (m === "async") return "async";
  return "sync";
}

/** Production entry point. No key → coded NO_API_KEY (never a silent fixture). */
export function resolveTranscriptionProvider(): TranscriptionProvider {
  apiKey(); // throws NO_API_KEY when absent — the honest failure, not a fixture
  return new AssemblyAIProvider(resolveTranscriptionMode());
}
