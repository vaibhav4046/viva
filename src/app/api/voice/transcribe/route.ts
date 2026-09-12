import {
  AssemblyAIProvider,
  MAX_KEYTERMS,
  MAX_STT_PROMPT,
  TranscriptionError,
  type TranscriptionResult,
  resolveTranscriptionMode,
} from "@/lib/assemblyai";
import { validateWavInput } from "@/lib/audio/wav";
import { voiceMessage } from "@/lib/audio/messages";
import { assemblyAIBreaker } from "@/lib/circuit";
import { getCourse } from "@/lib/courses";
import { checkLimit, limitKey } from "@/lib/limits";
import { Trace, rid, serverLog } from "@/lib/observe";

/**
 * POST /api/voice/transcribe — the hold-to-talk path.
 *
 * multipart/form-data in: `audio` (WAV or raw PCM), `subjectId`, `mode`
 * ("study" | "verbatim"), `languageCodes`, `context`.
 *
 * Dictation is the primary; Sync is the fallback on anything that looks like
 * the service rather than the audio (auth, capacity, timeout). The response
 * says which one answered, so a fallback is visible rather than silent.
 *
 * The API key is read here and never leaves the server. Every failure is a
 * coded JSON body the UI turns into one plain sentence: no status codes, no
 * provider text, no stack traces on screen.
 */

/** §4.3. Verbatim mode omits this entirely and uses `text`. */
const STUDY_INSTRUCTION =
  "Remove filler words and false starts. Keep hedges and uncertainty phrases exactly ('I think', \"I'm not sure\", 'maybe'). " +
  "Keep negations. Do not add facts. Return one clean paragraph.";

/** Codes that mean the service failed, not the audio — worth a second try elsewhere. */
const FALLBACK_CODES = new Set([
  "AUTH_FAILED",       // 401/404: this key is not enabled for Dictation
  "RATE_LIMITED",      // 429
  "PROVIDER_BUSY",     // 503 capacity_exceeded
  "PROVIDER_TIMEOUT",  // 504 or our own abort
  "TRANSCRIPTION_FAILED", // 5xx and transport failures
  "NO_DICTATION_URL",  // misconfigured deployment, but Sync may still be live
]);

function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

function fail(code: string, status: number, retryable: boolean, retryAfterSec?: number): Response {
  const headers: Record<string, string> = {};
  if (retryAfterSec) headers["Retry-After"] = String(retryAfterSec);
  return Response.json({ error: { code, message: voiceMessage(code), retryable } }, { status, headers });
}

/**
 * Recognition bias from the subject itself. The old build shipped a hardcoded
 * Transformers word list, which quietly biased every other subject towards
 * attention and gradients; these come from the subject the learner is in.
 */
export function subjectKeyterms(subjectId: string | null): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const concept of getCourse(subjectId).concepts) {
    for (const term of [concept.name, ...concept.aliases]) {
      const key = term.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(term);
      if (out.length === MAX_KEYTERMS) return out;
    }
  }
  return out;
}

/**
 * Condense recent turns into `stt_prompt`.
 *
 * Speaker labels leak: probed live 2026-09-12, a prompt beginning "Student:"
 * produced a transcript beginning "Student:" that the learner never said. So
 * labels are stripped and the context goes in as plain prose. Newest turns are
 * kept when the budget runs out — they bias recognition the most.
 */
export function condenseContext(turns: string[], limit = MAX_STT_PROMPT): string {
  const cleaned = turns
    .map((t) => t.replace(/^\s*[A-Za-z][A-Za-z ]{0,20}:\s*/, "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(-6);
  const kept: string[] = [];
  let budget = limit;
  for (let i = cleaned.length - 1; i >= 0; i--) {
    const cost = cleaned[i].length + 1;
    if (cost > budget) break;
    kept.unshift(cleaned[i]);
    budget -= cost;
  }
  return kept.join(" ");
}

function parseLanguageCodes(raw: string | null): string[] {
  if (!raw) return ["en"];
  const parsed = raw.trim().startsWith("[")
    ? ((): unknown => { try { return JSON.parse(raw); } catch { return null; } })()
    : raw.split(",");
  const list = Array.isArray(parsed) ? parsed : [];
  const codes = list
    .filter((c): c is string => typeof c === "string")
    .map((c) => c.trim().toLowerCase())
    .filter((c) => /^[a-z]{2}$/.test(c))
    .slice(0, 4);
  return codes.length ? codes : ["en"];
}

function field(form: FormData, name: string): string | null {
  const v = form.get(name);
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export async function POST(req: Request): Promise<Response> {
  const trace = new Trace(rid());
  trace.start("total");
  try {
    // Rate limit before any expensive work: one balance, many strangers.
    // Keyed on IP, not identity — the cookie is client-resettable.
    const rl = checkLimit(limitKey(["voice", clientIp(req)]), "transcribe");
    if (!rl.ok) {
      serverLog("voice.rate_limited", trace.id, {});
      return fail("RATE_LIMITED", 429, true, rl.retryAfterSec);
    }
    if (!assemblyAIBreaker.allow()) return fail("PROVIDER_BUSY", 503, true, 5);

    trace.start("read");
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return fail("BAD_AUDIO", 415, false);
    }
    const file = form.get("audio");
    if (!(file instanceof Blob)) return fail("EMPTY_AUDIO", 400, false);
    const buf = Buffer.from(await file.arrayBuffer());
    trace.end("read");

    trace.start("validate");
    const contentType = file.type || "audio/wav";
    const valid = validateWavInput(buf, contentType);
    trace.end("validate");
    if (!valid.ok) {
      const status = valid.code === "AUDIO_TOO_LONG" || valid.code === "AUDIO_TOO_LARGE" ? 413 : 415;
      return fail(valid.code, status, false);
    }

    const subjectId = field(form, "subjectId");
    const wantsClean = (field(form, "mode") ?? "study") !== "verbatim";
    const languageCodes = parseLanguageCodes(field(form, "languageCodes"));
    const contextRaw = field(form, "context");
    const request = {
      audio: buf,
      contentType,
      keyterms: subjectKeyterms(subjectId),
      sttPrompt: condenseContext(contextRaw ? contextRaw.split("\n") : []),
      languageCodes,
      ...(wantsClean ? { llmInstruction: STUDY_INSTRUCTION } : {}),
    };

    const primary = resolveTranscriptionMode() === "sync" ? "sync" : "dictation";
    trace.start("assemblyai");
    let result: TranscriptionResult;
    let fellBackFrom: string | null = null;
    try {
      result = await new AssemblyAIProvider(primary).transcribe(request);
    } catch (e) {
      const first = e instanceof TranscriptionError ? e : null;
      if (!first || primary !== "dictation" || !FALLBACK_CODES.has(first.code)) {
        trace.end("assemblyai");
        return handleFailure(first, trace.id);
      }
      serverLog("voice.fallback", trace.id, { from: first.code });
      fellBackFrom = first.code;
      try {
        result = await new AssemblyAIProvider("sync").transcribe(request);
      } catch (e2) {
        trace.end("assemblyai");
        return handleFailure(e2 instanceof TranscriptionError ? e2 : null, trace.id);
      }
    }
    trace.end("assemblyai");
    assemblyAIBreaker.success();

    // Verbatim is what was said; clean is the tidied rewrite. When the rewrite
    // was not asked for, or it failed, clean falls back to verbatim so the UI
    // always has something to show in both tabs.
    const verbatim = result.text;
    const clean = wantsClean ? (result.clean ?? verbatim) : verbatim;

    serverLog("voice.completed", trace.id, {
      mode: result.mode, fellBackFrom: fellBackFrom ?? "", audioMs: result.audioDurationMs,
      requestTimeMs: result.requestTimeMs, latencyMs: result.latencyMs, confidence: result.confidence,
      llmError: result.llmError ?? "", keyterms: request.keyterms.length,
    });

    return Response.json({
      verbatim,
      clean,
      confidence: result.confidence,
      words: result.words ?? [],
      requestTimeMs: result.requestTimeMs,
      syncTimeMs: result.syncTimeMs,
      audioMs: result.audioDurationMs ?? valid.durationMs,
      sessionId: result.sessionId,
      mode: result.mode,
      llmError: result.llmError,
      fellBackFrom,
      latencyMs: result.latencyMs,
      traceId: trace.id,
    });
  } finally {
    trace.end("total");
  }
}

function handleFailure(e: TranscriptionError | null, traceId: string): Response {
  if (!e) {
    assemblyAIBreaker.failure();
    serverLog("voice.failed", traceId, { code: "UNKNOWN" });
    return fail("TRANSCRIPTION_FAILED", 502, true);
  }
  // Service faults trip the breaker; bad audio and bad keys are not the
  // service's fault and must not take the endpoint down for everyone else.
  if (e.retryable || e.status >= 500) assemblyAIBreaker.failure();
  serverLog("voice.failed", traceId, { code: e.code, status: e.status });
  const status = e.status >= 500 ? 502 : e.status;
  return fail(e.code, status, e.retryable, e.retryAfterSec);
}
