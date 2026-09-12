import { NextRequest } from "next/server";
import { handleBody, parseError, type JsonRpcResponse } from "@/lib/mcp/rpc";
import type { ToolEnvironment } from "@/lib/mcp/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** A subject built from pasted notes runs inline, the same as the app's own route. */
export const maxDuration = 60;

/**
 * POST /api/mcp — VIVA as a tool a student's assistant can use.
 *
 * The point is that VIVA does not become another tab. A student who lives in
 * Claude, ChatGPT, Gemini or Cursor connects their VIVA account once and can
 * then say "quiz me on histology", "keep this", "what am I weak on" from
 * wherever they already are. The voice work stays in VIVA, where the
 * microphone and the Dictation call are; the reasoning surface can be
 * anywhere.
 *
 * Identity: the bearer key, and nothing else. This endpoint deliberately does
 * NOT read the `viva_did` cookie, even though a browser would send one. A
 * cookie-authenticated tool endpoint is a cross-site request away from being
 * somebody else's session, and none of the safety of the rest of the app comes
 * from the caller being polite. Pairing is explicit: /connect mints a code
 * from the cookie, the code is exchanged once for a key, the key is what every
 * call carries.
 */

/** Where this deployment answers its own requests. */
function selfOrigin(req: NextRequest): string {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (!host) return req.nextUrl.origin;
  const proto = req.headers.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

function environmentFor(req: NextRequest): ToolEnvironment {
  return {
    origin: selfOrigin(req),
    authorization: req.headers.get("authorization"),
    // Passed through so a per-caller rate limit stays per-caller rather than
    // counting every connected student as one server talking to itself.
    forwardedFor: req.headers.get("x-forwarded-for"),
    fetch: (url: string, init: RequestInit) => fetch(url, init),
  };
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(parseError(), 400);
  }

  const answers: JsonRpcResponse[] = await handleBody(body, environmentFor(req));
  // Notifications only: accepted, nothing to say back.
  if (answers.length === 0) return new Response(null, { status: 202 });
  return json(Array.isArray(body) ? answers : answers[0]);
}

/**
 * No server-initiated stream and no session to end. The specification's answer
 * for both is 405, which is also what tells a client to stop asking.
 */
export function GET() {
  return json(
    { error: { code: "METHOD_NOT_ALLOWED", message: "VIVA answers tool calls on POST." } },
    405
  );
}

export const DELETE = GET;
