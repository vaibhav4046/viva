import { checkLimit, limitKey } from "@/lib/limits";
import { voiceMessage } from "@/lib/audio/messages";
import { rid, serverLog } from "@/lib/observe";

/**
 * GET /api/voice/stream-token — mint a short-lived Universal-Streaming token.
 *
 * The live path is the one place the browser talks to AssemblyAI directly: a
 * WebSocket cannot be proxied through a Next route without relaying every audio
 * frame through the server, which would add the very latency streaming exists
 * to remove. So the browser gets a token, never the key.
 *
 * Probed live 2026-09-12 against the real endpoint:
 *   GET https://streaming.assemblyai.com/v3/token?expires_in_seconds=300
 *   Authorization: <raw key, no Bearer>
 *   200 -> { "token": "...", "expires_in_seconds": 300 }
 * The token is a bearer credential for one socket. It is scoped to streaming
 * only — it cannot read transcripts, spend the account's async balance, or
 * reach any other endpoint — which is what makes handing it to a browser
 * acceptable where handing over the key would not be.
 *
 * Short expiry is the whole safety model, so the ceiling is enforced here
 * rather than trusted from the query string: a client asking for a 24-hour
 * token gets a 10-minute one.
 */

const TOKEN_URL = process.env.ASSEMBLYAI_STREAM_TOKEN_URL ?? "https://streaming.assemblyai.com/v3/token";

/** Long enough to outlive the 115 s clip cap plus a reconnect; short enough
 *  that a leaked token is worthless within minutes. */
export const DEFAULT_EXPIRY_SEC = 300;
export const MAX_EXPIRY_SEC = 600;
const MIN_EXPIRY_SEC = 60;

/** Upstream is fast (measured 936 ms cold, ~200 ms warm). Anything slower than
 *  this is a failure the learner should hear about, not wait through. */
const TOKEN_TIMEOUT_MS = 8_000;

export function clampExpiry(raw: string | null): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return DEFAULT_EXPIRY_SEC;
  return Math.min(MAX_EXPIRY_SEC, Math.max(MIN_EXPIRY_SEC, n));
}

function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

function fail(code: string, status: number, retryable: boolean, retryAfterSec?: number): Response {
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (retryAfterSec) headers["Retry-After"] = String(retryAfterSec);
  return Response.json({ error: { code, message: voiceMessage(code), retryable } }, { status, headers });
}

export async function GET(req: Request): Promise<Response> {
  const traceId = rid();
  // Same bucket class as /transcribe: a token is a licence to stream audio at
  // AssemblyAI's meter, so it must not be cheaper to obtain than a clip.
  const rl = checkLimit(limitKey(["voice-stream", clientIp(req)]), "transcribe");
  if (!rl.ok) {
    serverLog("stream_token.rate_limited", traceId, {});
    return fail("RATE_LIMITED", 429, true, rl.retryAfterSec);
  }

  const key = process.env.ASSEMBLYAI_API_KEY;
  if (!key) return fail("NO_API_KEY", 503, false);

  const expiresInSeconds = clampExpiry(new URL(req.url).searchParams.get("expires_in_seconds"));

  let res: Response;
  try {
    res = await fetch(`${TOKEN_URL}?expires_in_seconds=${expiresInSeconds}`, {
      headers: { Authorization: key },
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (e) {
    const timedOut = (e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError";
    serverLog("stream_token.failed", traceId, { code: timedOut ? "PROVIDER_TIMEOUT" : "TRANSCRIPTION_FAILED" });
    return fail(timedOut ? "PROVIDER_TIMEOUT" : "TRANSCRIPTION_FAILED", 502, true, 2);
  }

  if (!res.ok) {
    // The upstream body can carry the account's own detail text; it never
    // reaches the browser. Only a code the UI maps to one plain sentence does.
    serverLog("stream_token.rejected", traceId, { status: res.status });
    if (res.status === 401 || res.status === 403 || res.status === 404) return fail("AUTH_FAILED", 502, false);
    if (res.status === 429) return fail("RATE_LIMITED", 429, true, 5);
    return fail("TRANSCRIPTION_FAILED", 502, res.status >= 500, 2);
  }

  const body = (await res.json().catch(() => null)) as { token?: unknown } | null;
  // A 200 with no token is a contract change, not a token: refuse it here
  // rather than let the client open a socket with "undefined" in the URL.
  if (typeof body?.token !== "string" || !body.token) {
    serverLog("stream_token.bad_shape", traceId, {});
    return fail("BAD_RESPONSE", 502, false);
  }

  serverLog("stream_token.minted", traceId, { expiresInSeconds });
  return Response.json(
    { token: body.token, expiresInSeconds },
    { headers: { "Cache-Control": "no-store" } }
  );
}
