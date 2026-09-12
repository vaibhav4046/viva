/**
 * TranscriptionProvider — AssemblyAI behind a stable interface.
 * Key never reaches the browser; all calls are server-side.
 *
 * Modes (ASSEMBLYAI_TRANSCRIPTION_MODE, default "dictation"):
 * - "dictation": POST ASSEMBLYAI_DICTATION_URL. Contract probed live
 *                2026-09-12: multipart/form-data, `config` part
 *                (application/json) FIRST, then `audio` as raw 16 kHz mono
 *                S16LE PCM (anything else is downmixed and resampled to that
 *                before send — the declaration is read as truth upstream).
 *                Config keys are `sample_rate`, `channels`,
 *                `language_codes`, `keyterms_prompt` (array), `stt_prompt`,
 *                `llm_instruction`. Response carries both `text` (verbatim)
 *                and `llm_response` (cleaned); `llm_error` is not a request
 *                failure — fall back to `text`.
 * - "sync":      POST {syncBase}/transcribe, multipart audio+config,
 *                X-AAI-Model: universal-3-5-pro. The fallback path.
 * - "async":     /v2/upload + /v2/transcript poll. NOT the hold-to-talk path
 *                (poll loops don't belong in the hot path); retained for long
 *                audio (lecture uploads).
 *
 * Error bodies from both live endpoints are {status, title, detail}.
 * Production NEVER selects fixture transcription (see resolve + test).
 */

import { isWavType, TARGET_RATE, toPcm16kMono } from "./audio/wav";

export type TranscriptionMode = "sync" | "dictation" | "async";

export type TranscriptionRequest = {
  audio: Buffer;
  /** Must be a WAV type: both paths below declare a format to AssemblyAI, and
   *  only a RIFF header lets that declaration be verified rather than believed.
   *  Checked again here, not assumed of the caller. */
  contentType: string;
  /** Recognition bias terms (concept names + aliases). Capped before send. */
  keyterms?: string[];
  /** Conversation context, plain prose. Speaker labels leak into the
   *  transcript (probed live), so callers must strip them. Capped at 6000. */
  sttPrompt?: string;
  /** Cleanup instruction for the rewrite pass. Omit for verbatim-only. */
  llmInstruction?: string;
  /** BCP-47-ish codes, e.g. ["en"] or ["en","hi"]. */
  languageCodes?: string[];
  signal?: AbortSignal;
};

export type TranscriptionResult = {
  /** What was actually said, filler words and all. */
  text: string;
  /** The rewrite pass output, or null when it was not asked for or failed. */
  clean: string | null;
  /** "timeout" | "error" | null — never a request failure on its own. */
  llmError: string | null;
  confidence: number | null;
  words?: { text: string; confidence: number }[];
  audioDurationMs: number | null;
  sessionId: string | null;
  requestTimeMs: number | null;
  syncTimeMs: number | null;
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
  // Live error body (probed 2026-09-12): {status, title, detail}.
  const b = (body ?? {}) as { error?: string; error_code?: string; message?: string; detail?: string };
  const msg = b.message ?? b.detail ?? b.error ?? `AssemblyAI request failed (${status}).`;
  const retryAfterSec = retryAfterHeader ? Math.max(1, parseInt(retryAfterHeader, 10) || 1) : undefined;
  switch (status) {
    case 400: return new TranscriptionError("BAD_AUDIO", msg, 400, false);
    case 401: return new TranscriptionError("AUTH_FAILED", "AssemblyAI rejected the API key.", 502, false);
    // 404 on these endpoints means the key is not enabled for them, not a
    // missing route — same remedy as 401, and the same trigger to fall back.
    case 404: return new TranscriptionError("AUTH_FAILED", "AssemblyAI rejected the API key.", 502, false);
    case 413: return new TranscriptionError("AUDIO_TOO_LONG", "Clip exceeds 120 s / 40 MB.", 413, false);
    case 415: return new TranscriptionError("UNSUPPORTED_FORMAT", msg, 415, false);
    case 429: return new TranscriptionError("RATE_LIMITED", "AssemblyAI rate limit hit. Try again shortly.", 429, true, retryAfterSec ?? 5);
    case 503: return new TranscriptionError("PROVIDER_BUSY", "AssemblyAI is at capacity. Try again shortly.", 503, true, retryAfterSec ?? 5);
    case 504: return new TranscriptionError("PROVIDER_TIMEOUT", "AssemblyAI exceeded its 30 s deadline.", 504, true, 2);
    default: return new TranscriptionError("TRANSCRIPTION_FAILED", msg, 502, status >= 500);
  }
}

/** `keyterms_prompt` is an ARRAY (a string is a 400); ≤100 terms, ≤2048 chars. */
export function capKeyterms(keyterms: string[] | undefined): string[] {
  const out: string[] = [];
  let budget = 2048;
  for (const t of (keyterms ?? []).slice(0, MAX_KEYTERMS)) {
    const term = t.trim();
    if (!term || term.length + 1 > budget) continue;
    out.push(term);
    budget -= term.length + 1;
  }
  return out;
}

export const MAX_KEYTERMS = 100;
export const MAX_STT_PROMPT = 6000;
export const MAX_LLM_INSTRUCTION = 2048;

export class AssemblyAIProvider implements TranscriptionProvider {
  readonly name = "assemblyai";
  constructor(readonly mode: TranscriptionMode = "sync") {}

  transcribe(req: TranscriptionRequest): Promise<TranscriptionResult> {
    switch (this.mode) {
      case "sync": return this.transcribeSync(req);
      case "dictation": return this.transcribeDictation(req);
      case "async": return this.transcribeAsync(req);
    }
  }

  /** Fallback path. Config keys verified live 2026-09-12 (`language_codes`). */
  private async transcribeSync(req: TranscriptionRequest): Promise<TranscriptionResult> {
    const started = Date.now();
    // This path labels the bytes audio/wav to the vendor, so it must not be
    // handed anything else: the fallback used to re-send headerless PCM inside
    // a Blob typed audio/wav, which is the same mislabelling one layer down.
    if (!isWavType(req.contentType)) {
      throw new TranscriptionError("UNSUPPORTED_FORMAT", "Sync transcription needs a 16-bit PCM WAV.", 415, false);
    }
    const form = new FormData();
    const bytes = new Uint8Array(req.audio.buffer, req.audio.byteOffset, req.audio.byteLength);
    form.append("audio", new Blob([bytes as unknown as BlobPart], { type: "audio/wav" }), "clip.wav");
    form.append("config", JSON.stringify({
      language_codes: req.languageCodes?.length ? req.languageCodes : ["en"],
      keyterms_prompt: capKeyterms(req.keyterms),
      prompt: (req.sttPrompt ?? "").slice(0, MAX_STT_PROMPT) || undefined,
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
        audio_duration_ms: number; session_id: string; request_time_ms?: number; sync_time_ms?: number;
      };
      if (typeof data.text !== "string") throw new TranscriptionError("BAD_RESPONSE", "AssemblyAI returned an unexpected shape.", 502, false);
      return {
        text: data.text,
        // Sync has no rewrite pass: the caller shows verbatim in both tabs.
        clean: null,
        llmError: null,
        confidence: data.confidence ?? null,
        words: data.words, audioDurationMs: data.audio_duration_ms ?? null,
        sessionId: data.session_id ?? null, requestTimeMs: data.request_time_ms ?? null,
        syncTimeMs: data.sync_time_ms ?? null,
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

  private async transcribeDictation(req: TranscriptionRequest): Promise<TranscriptionResult> {
    const started = Date.now();
    const url = process.env.ASSEMBLYAI_DICTATION_URL;
    if (!url) throw new TranscriptionError("NO_DICTATION_URL", "Dictation mode needs ASSEMBLYAI_DICTATION_URL.", 503, false);

    // Dictation reads the byte stream at the rate the config DECLARES, so the
    // bytes have to actually be 16 kHz mono S16LE. Normalising here rather than
    // asserting it is the whole fix for the mislabelling bug: the AudioWorklet
    // path already produces 16 kHz mono, but every other entry point (a direct
    // API caller, a browser with no worklet) hands us whatever the machine
    // recorded, and a 9.5 s 48 kHz stereo clip posted as 16 kHz mono was
    // consumed as 57 s of nothing — 200, empty transcript, six times the bill.
    const norm = toPcm16kMono(req.audio, req.contentType);
    if (!norm.ok) throw new TranscriptionError(norm.code, norm.message, 415, false);
    const pcm = norm.pcm;

    // Verified contract: multipart `config` FIRST (application/json), then
    // `audio` as raw PCM. Appending in this order is the wire contract the
    // endpoint requires; the clip itself is buffered and posted whole on
    // release, so nothing is streamed while recording (see the note on
    // `transcribe` above).
    const config: Record<string, unknown> = {
      // Guaranteed by toPcm16kMono above, not assumed of the caller.
      sample_rate: TARGET_RATE,
      channels: 1,
      language_codes: req.languageCodes?.length ? req.languageCodes : ["en"],
      keyterms_prompt: capKeyterms(req.keyterms),
    };
    const sttPrompt = (req.sttPrompt ?? "").slice(0, MAX_STT_PROMPT);
    if (sttPrompt) config.stt_prompt = sttPrompt;
    if (req.llmInstruction) config.llm_instruction = req.llmInstruction.slice(0, MAX_LLM_INSTRUCTION);

    const form = new FormData();
    form.append("config", new Blob([JSON.stringify(config)], { type: "application/json" }), "config.json");
    form.append("audio", new Blob([pcm as unknown as BlobPart], { type: "audio/pcm" }), "clip.pcm");

    const ctrl = new AbortController();
    // 90 s ceiling per the published contract; a 6-10 s clip returns in ~1 s.
    const timer = setTimeout(() => ctrl.abort(), 90_000);
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
          const b = (body ?? {}) as { error?: string; message?: string; detail?: string };
          throw new TranscriptionError(
            "DICTATION_BAD_REQUEST",
            b.detail ?? b.error ?? b.message ?? "Dictation request was malformed.",
            400,
            false
          );
        }
        throw mapSyncError(res.status, body, res.headers.get("retry-after"));
      }
      const data = (await res.json()) as Record<string, unknown>;
      // `text` is the verbatim transcript. `llm_response` is the cleaned
      // rewrite; both are returned so the learner can see exactly what they
      // said next to what was tidied - the rewrite never silently replaces it.
      if (typeof data.text !== "string") {
        throw new TranscriptionError("BAD_RESPONSE", "Dictation returned no text.", 502, false);
      }

      const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
      const words = Array.isArray(data.words)
        ? (data.words as Array<{ text?: unknown; confidence?: unknown }>)
            .filter((w) => typeof w?.text === "string")
            .map((w) => ({ text: w.text as string, confidence: num(w.confidence) ?? 0 }))
        : undefined;
      let confidence = num(data.confidence);
      if (confidence === null && words?.length) {
        confidence = words.reduce((a, w) => a + w.confidence, 0) / words.length;
      }
      // A failed rewrite is not a failed request: `clean` goes null and the
      // caller falls back to verbatim rather than showing the learner nothing.
      const llmError = typeof data.llm_error === "string" ? data.llm_error : null;
      const clean = typeof data.llm_response === "string" && data.llm_response.trim() ? data.llm_response : null;

      return {
        text: data.text,
        clean,
        llmError,
        confidence,
        words,
        audioDurationMs: num(data.audio_duration_ms),
        sessionId: typeof data.session_id === "string" ? data.session_id : null,
        requestTimeMs: num(data.request_time_ms),
        syncTimeMs: num(data.sync_time_ms),
        latencyMs: Date.now() - started,
        provider: "assemblyai",
        mode: "dictation",
        demoFixture: false,
      };
    } catch (e) {
      if (e instanceof TranscriptionError) throw e;
      if ((e as Error).name === "AbortError" || (e as Error).name === "TimeoutError") {
        throw new TranscriptionError("PROVIDER_TIMEOUT", "Transcription timed out.", 504, true, 2);
      }
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
        keyterms_prompt: capKeyterms(req.keyterms),
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
          text: t.text ?? "", clean: null, llmError: null, confidence: t.confidence ?? null,
          audioDurationMs: null, sessionId: id, requestTimeMs: null, syncTimeMs: null,
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
      text: this.text, clean: null, llmError: null, confidence: null, audioDurationMs: null,
      sessionId: null, requestTimeMs: null, syncTimeMs: null, latencyMs: 0,
      provider: "fixture", mode: "sync", demoFixture: true,
    };
  }
}

/** Default is dictation: it is the primary path, sync is only the fallback.
 *  "event-dictation" is still accepted so an already-deployed env var keeps
 *  selecting the same mode after the rename. */
export function resolveTranscriptionMode(): TranscriptionMode {
  const m = (process.env.ASSEMBLYAI_TRANSCRIPTION_MODE ?? "dictation").toLowerCase();
  if (m === "sync") return "sync";
  if (m === "async") return "async";
  return "dictation";
}

/** Production entry point. No key → coded NO_API_KEY (never a silent fixture). */
export function resolveTranscriptionProvider(): TranscriptionProvider {
  apiKey(); // throws NO_API_KEY when absent — the honest failure, not a fixture
  return new AssemblyAIProvider(resolveTranscriptionMode());
}
