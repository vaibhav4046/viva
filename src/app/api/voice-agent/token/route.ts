import { NextResponse } from "next/server";
import { resolveIdentity } from "@/lib/auth/identity";
import { checkLimit, limitKey } from "@/lib/limits";
import { clientIp, withIdentityCookie } from "@/lib/http";
import { rid, serverLog } from "@/lib/observe";
import { voiceMessage } from "@/lib/audio/messages";

/**
 * GET /api/voice-agent/token, mint a short-lived Voice Agent session token.
 *
 * This is the whole security model of the oral exam in one route: the browser
 * gets a token scoped to one socket, never the account key. Nothing else in the
 * client is allowed to read `ASSEMBLYAI_API_KEY`, and this handler is the only
 * place that does.
 *
 * The token endpoint is separate from the streaming one on purpose. Universal
 * Streaming and Voice Agent are different products with different hosts, and
 * reusing the streaming token URL for this would have been a quiet way to hand
 * voice-agent sessions a credential minted for something else.
 *
 * Verified against the live endpoint on 2026-09-28, not only the docs page.
 * The published events reference does not mention the expiry parameter, but
 * the endpoint is strict about it and says so precisely:
 *
 *   GET https://agents.assemblyai.com/v1/token            -> 422
 *     {"detail":[{"type":"missing","loc":["query","expires_in_seconds"]}]}
 *   GET .../v1/token?expires_in_seconds=3600             -> 422
 *     {"type":"less_than_equal","le":600}
 *   GET .../v1/token?expires_in_seconds=600              -> 200
 *     {"token":"…2486 chars…","expires_in_seconds":600}
 *
 * So the expiry is required, it is capped at 600 s, and the response echoes it.
 * The first version of this route sent no parameter and answered 502 for every
 * caller, a failure with no local clue, which is why the probe above is
 * recorded here rather than left in a scratch file.
 */

const TOKEN_URL = process.env.ASSEMBLYAI_VOICE_AGENT_TOKEN_URL ?? "https://agents.assemblyai.com/v1/token";

/** The endpoint's own ceiling, measured. Sending more is a 422, not a clamp. */
export const MAX_EXPIRY_SEC = 600;
/**
 * Long enough to outlive a full exam with reconnects, short enough that a
 * leaked token is dead within minutes. An oral session is bounded by
 * `max_session_duration_seconds` upstream, so 600 s does not truncate one.
 */
export const DEFAULT_EXPIRY_SEC = 600;
const MIN_EXPIRY_SEC = 60;

const TOKEN_TIMEOUT_MS = 8_000;

/** Clamp a caller-supplied expiry into what the endpoint actually accepts. */
export function clampVoiceAgentExpiry(raw: string | null): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return DEFAULT_EXPIRY_SEC;
  return Math.min(MAX_EXPIRY_SEC, Math.max(MIN_EXPIRY_SEC, n));
}

function fail(code: string, status: number, retryable: boolean): NextResponse {
  return NextResponse.json(
    { error: { code, message: voiceMessage(code), retryable } },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}

export async function GET(req: Request): Promise<Response> {
  const { identity, setCookie } = await resolveIdentity(req);
  return withIdentityCookie(await mint(req, identity.userId), setCookie);
}

async function mint(req: Request, userId: string): Promise<Response> {
  const traceId = rid();

  // Same two buckets as the streaming token: the address bounds a stranger,
  // the learner bounds a cookie. A token is a licence to spend AssemblyAI
  // minutes, so it must not be cheaper to get than a recorded clip.
  for (const bucket of [["voice-agent-token", clientIp(req)], ["voice-agent-token-did", userId]]) {
    const rl = checkLimit(limitKey(bucket), "transcribe");
    if (!rl.ok) {
      serverLog("voice_agent_token.rate_limited", traceId, {});
      return fail("RATE_LIMITED", 429, true);
    }
  }

  const key = process.env.ASSEMBLYAI_API_KEY;
  if (!key) return fail("NO_API_KEY", 503, false);

  // Required by the endpoint, capped at 600 s. Clamped here rather than trusted
  // from the query string, so a client asking for a day-long token gets ten
  // minutes and no 422.
  const expiresInSeconds = clampVoiceAgentExpiry(new URL(req.url).searchParams.get("expires_in_seconds"));

  let res: Response;
  try {
    res = await fetch(`${TOKEN_URL}?expires_in_seconds=${expiresInSeconds}`, {
      // Raw key, no Bearer. Both forms were probed: the endpoint accepts the
      // raw key and answers identically for either, so the raw form is used.
      headers: { Authorization: key },
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (e) {
    const timedOut = (e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError";
    serverLog("voice_agent_token.failed", traceId, { code: timedOut ? "PROVIDER_TIMEOUT" : "TRANSCRIPTION_FAILED" });
    return fail(timedOut ? "PROVIDER_TIMEOUT" : "TRANSCRIPTION_FAILED", 502, true);
  }

  if (!res.ok) {
    // Upstream's body can name the account and, on a 422, name the exact field
    // that was wrong. It never reaches the browser; the trace keeps the status
    // so the next person does not have to re-derive it from a 502.
    serverLog("voice_agent_token.rejected", traceId, { status: res.status });
    if (res.status === 401 || res.status === 403) return fail("AUTH_FAILED", 502, false);
    if (res.status === 429) return fail("RATE_LIMITED", 429, true);
    // A 422 is our own request being wrong, not the provider being unwell.
    // Saying "try again" would send a student into an infinite retry for a
    // bug that only a code change fixes, so it is marked non-retryable.
    if (res.status === 422) return fail("BAD_RESPONSE", 502, false);
    // 5xx is worth another attempt; any other 4xx means the request itself is
    // wrong and repeating it will not help.
    return fail("TRANSCRIPTION_FAILED", 502, res.status >= 500);
  }

  const body = (await res.json().catch(() => null)) as { token?: unknown; expires_in_seconds?: unknown } | null;
  // A 200 with no token is a contract change, not a token. Refusing it here
  // beats opening a socket with the string "undefined" in the query.
  if (typeof body?.token !== "string" || !body.token) {
    serverLog("voice_agent_token.bad_shape", traceId, {});
    return fail("BAD_RESPONSE", 502, false);
  }

  // Report the expiry the provider actually granted, not the one we asked for.
  const granted =
    typeof body.expires_in_seconds === "number" ? body.expires_in_seconds : expiresInSeconds;
  serverLog("voice_agent_token.minted", traceId, { expiresInSeconds: granted });
  return NextResponse.json(
    { token: body.token, expiresInSeconds: granted },
    { headers: { "Cache-Control": "no-store" } }
  );
}
