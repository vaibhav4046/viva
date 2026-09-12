import { checkLimit, limitKey } from "@/lib/limits";
import { rid, serverLog } from "@/lib/observe";

/**
 * POST /api/voice/telemetry — the one number the server cannot measure.
 *
 * `voice.completed` already logs the upstream facts (mode, audioMs,
 * request_time_ms, our own latency). What it cannot see is release-to-review in
 * the browser, which is the number any latency claim about this product is
 * actually about. That number used to be written into an in-tab Map that
 * nothing read and nothing sent: it looked like evidence and was not. Now it
 * lands in the same server log as everything else, so a claim can be checked
 * against something.
 *
 * Metrics only. Unknown fields are ignored rather than logged, so no transcript
 * text can reach a log line even if a future caller puts it in the body.
 */

/** A clip is capped at 120 s; anything past 10 minutes is a broken clock. */
const MAX_MS = 600_000;

function metric(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(Math.round(v), MAX_MS) : null;
}

/** Free-text would be a log-injection door; the vocabulary is closed. */
const MODES = new Set(["dictation", "sync", "async"]);
const CODES = new Set([
  "AUTH_FAILED", "RATE_LIMITED", "PROVIDER_BUSY", "PROVIDER_TIMEOUT", "TRANSCRIPTION_FAILED", "NO_DICTATION_URL",
]);

function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

export async function POST(req: Request): Promise<Response> {
  const rl = checkLimit(limitKey(["voice-telemetry", clientIp(req)]), "transcribe");
  if (!rl.ok) return new Response(null, { status: 429 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return new Response(null, { status: 400 });
  const latencyMs = metric(body.latencyMs);
  if (latencyMs === null) return new Response(null, { status: 400 });
  const mode = typeof body.mode === "string" && MODES.has(body.mode) ? body.mode : "";
  const fellBackFrom = typeof body.fellBackFrom === "string" && CODES.has(body.fellBackFrom) ? body.fellBackFrom : "";
  serverLog("voice.client_completed", rid(), {
    latencyMs,
    audioMs: metric(body.audioMs),
    requestTimeMs: metric(body.requestTimeMs),
    mode,
    fellBackFrom,
  });
  return new Response(null, { status: 204 });
}
