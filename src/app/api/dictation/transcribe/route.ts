import { NextRequest } from "next/server";
import {
  AssemblyAIProvider,
  TranscriptionError,
  resolveTranscriptionMode,
} from "@/lib/assemblyai";
import { assemblyAIBreaker } from "@/lib/circuit";
import { checkLimit, limitKey } from "@/lib/limits";
import { Trace, rid, serverLog } from "@/lib/observe";
import { validateWavInput } from "@/lib/audio/wav";
import { err } from "@/lib/types";

function clientIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

/**
 * POST /api/dictation/transcribe — audio in, transcript out.
 * Contract: Content-Type audio/wav (16-bit PCM) or audio/pcm, ≤40MB / ≤120s.
 * Server-side AssemblyAI only; the key never reaches the browser.
 * Production NEVER substitutes a fixture: no key → coded 503, not fake text.
 */
export async function POST(req: NextRequest) {
  const trace = new Trace(rid());
  trace.start("total");
  try {
    // Rate limit BEFORE any expensive work (one balance, many strangers).
    // Keyed on IP, not identity: the demo cookie is client-resettable.
    const rl = checkLimit(limitKey(["transcribe", clientIp(req)]), "transcribe");
    if (!rl.ok) {
      serverLog("dictation.rate_limited", trace.id, { ip: "redacted" });
      return Response.json(
        { error: { code: "RATE_LIMITED", message: "Too many dictations. Wait a few seconds and try again.", retryable: true } },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
      );
    }

    if (!assemblyAIBreaker.allow()) {
      return err("PROVIDER_BUSY", "Voice service is recovering. Your thought is safe — try again in a moment.", true, 503);
    }

    trace.start("read");
    const buf = Buffer.from(await req.arrayBuffer());
    trace.end("read");
    const mime = req.headers.get("content-type") ?? "";

    trace.start("validate");
    const valid = validateWavInput(buf, mime);
    trace.end("validate");
    if (!valid.ok) {
      const status = valid.code === "AUDIO_TOO_LONG" || valid.code === "AUDIO_TOO_LARGE" ? 413 : 415;
      return err(valid.code, valid.message, false, status);
    }

    const mode = resolveTranscriptionMode();
    if (mode === "event-dictation" && !process.env.ASSEMBLYAI_DICTATION_URL) {
      return err("NO_DICTATION_URL", "Event dictation mode needs ASSEMBLYAI_DICTATION_URL.", false, 503);
    }

    trace.start("assemblyai");
    try {
      const provider = new AssemblyAIProvider(mode);
      const r = await provider.transcribe({ audio: buf, contentType: mime });
      trace.end("assemblyai");
      assemblyAIBreaker.success();
      trace.end("total");
      serverLog("dictation.completed", trace.id, {
        mode, audioDurationMs: r.audioDurationMs, requestTimeMs: r.requestTimeMs,
        latencyMs: r.latencyMs, confidence: r.confidence, timings: JSON.stringify(trace.timings()),
      });
      return Response.json({
        transcript: r.text,
        text: r.text,
        confidence: r.confidence,
        audioDurationMs: r.audioDurationMs,
        requestTimeMs: r.requestTimeMs,
        sessionId: r.sessionId,
        latencyMs: r.latencyMs,
        provider: "assemblyai",
        mode,
        demoFixture: false,
        traceId: trace.id,
        timings: trace.timings(),
      });
    } catch (e) {
      trace.end("assemblyai");
      if (e instanceof TranscriptionError) {
        // 5xx/429/timouts trip the breaker; client errors (bad audio/auth) do not.
        if (e.retryable || e.status >= 500) assemblyAIBreaker.failure();
        serverLog("dictation.failed", trace.id, { code: e.code, status: e.status });
        if (e.code === "NO_API_KEY") {
          return err("NO_API_KEY", "Live voice is not configured on this deployment (missing ASSEMBLYAI_API_KEY). Type instead — nothing is faked.", false, 503);
        }
        const headers: Record<string, string> = {};
        if (e.retryAfterSec) headers["Retry-After"] = String(e.retryAfterSec);
        return Response.json(
          { error: { code: e.code, message: userMessage(e.code), retryable: e.retryable } },
          { status: e.status >= 500 ? 502 : e.status, headers }
        );
      }
      assemblyAIBreaker.failure();
      serverLog("dictation.failed", trace.id, { code: "UNKNOWN" });
      return err("TRANSCRIPTION_FAILED", "We couldn't transcribe that clip. Your recording wasn't saved. Try again.", true, 502);
    }
  } finally {
    trace.end("total");
  }
}

function userMessage(code: string): string {
  switch (code) {
    case "RATE_LIMITED": return "Too many dictations. Wait a few seconds and try again.";
    case "PROVIDER_BUSY": return "Voice service is recovering. Your thought is safe — try again in a moment.";
    case "PROVIDER_TIMEOUT": return "Transcription timed out. Shorter clips succeed more reliably — try again.";
    default: return "We couldn't transcribe that clip. Your recording wasn't saved. Try again.";
  }
}
