import { checkLimit, limitKey } from "@/lib/limits";
import { voiceMessage } from "@/lib/audio/messages";
import { resolveIdentity } from "@/lib/auth/identity";
import { clientIp, withIdentityCookie } from "@/lib/http";
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

function fail(code: string, status: number, retryable: boolean, retryAfterSec?: number): Response {
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (retryAfterSec) headers["Retry-After"] = String(retryAfterSec);
  return Response.json({ error: { code, message: voiceMessage(code), retryable } }, { status, headers });
}

/**
 * A token is minted for a learner, not for whoever finds the URL.
 *
 * This was the one route that never asked who was calling, so the whole gate
 * on someone else's AssemblyAI meter was a per-IP bucket, and rotating the
 * address is the ordinary way around one. Identity here is what it is
 * everywhere else — the `viva_did` cookie, minted when absent, because the
 * first hold of the microphone must work and there is no sign-in wall.
 *
 * That mint is also the honest limit of this: a caller who discards cookies
 * gets a fresh identity each request and stays bounded by the IP bucket alone.
 * What it buys is the learner bucket below, which the IP bucket cannot give —
 * one cookie's budget is one budget however many addresses it arrives from.
 */
export async function GET(req: Request): Promise<Response> {
  const { identity, setCookie } = await resolveIdentity(req);
  return withIdentityCookie(await mint(req, identity.userId), setCookie);
}

async function mint(req: Request, userId: string): Promise<Response> {
  const traceId = rid();
  // Same bucket class as /transcribe: a token is a licence to stream audio at
  // AssemblyAI's meter, so it must not be cheaper to obtain than a clip. Both
  // buckets are checked — the address bounds a stranger, the learner bounds a
  // cookie, and neither substitutes for the other.
  for (const bucket of [["voice-stream", clientIp(req)], ["voice-stream-did", userId]]) {
    const rl = checkLimit(limitKey(bucket), "transcribe");
    if (!rl.ok) {
      serverLog("stream_token.rate_limited", traceId, {});
      return fail("RATE_LIMITED", 429, true, rl.retryAfterSec);
    }
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
