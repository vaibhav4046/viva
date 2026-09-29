import { z } from "zod";
import { resolveIdentity } from "@/lib/auth/identity";
import { checkLimit, limitKey, type LimitClass } from "@/lib/limits";
import { withIdentityCookie } from "@/lib/http";
import { err } from "@/lib/types";
import { getSession, saveSession } from "./store";
import { RedteamError } from "./session";
import { DocumentError } from "./document";
import type { RedteamSession } from "./types";

/**
 * Shared plumbing for the RedTeam routes: who is asking, are they within
 * budget, is the body sane, and does the session they name belong to them.
 * Written once so no route can forget one of the four.
 */

const MAX_BODY = 96_000;

/**
 * Who is asking, for rate limiting, and only as far as it can be trusted.
 *
 * `x-forwarded-for` is a header the caller writes unless a proxy of yours
 * overwrites it. Reading it with no proxy in front let anyone rotate it and get
 * a fresh bucket per request (25 of 25 creations, measured). So:
 *  - on Vercel, the platform's own header;
 *  - behind proxies you run, set TRUSTED_PROXY_HOPS=N and the Nth address from
 *    the right is used (the last one the nearest trusted hop wrote);
 *  - otherwise the header is ignored and everyone shares one address bucket,
 *    which is the safe default for `npm start` and Docker. The per-cookie bucket
 *    still separates people, and a caller who drops the cookie lands in the
 *    shared bucket, where the limit applies to all of them together.
 */
export function callerAddress(req: Request): string {
  if (process.env.VERCEL) {
    const v = req.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim();
    if (v) return v;
  }
  const hops = Number.parseInt(process.env.TRUSTED_PROXY_HOPS ?? "0", 10);
  if (Number.isFinite(hops) && hops > 0) {
    const parts = (req.headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    return parts[parts.length - hops] ?? "unknown";
  }
  return "direct";
}

/** Read at most `max` bytes. `null` means it was bigger, and nothing more was read. */
async function readCapped(req: Request, max: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export type Ctx = { userId: string; req: Request; done: (res: Response) => Response };

export async function handle(
  req: Request,
  opts: { limit: LimitClass; schema?: z.ZodTypeAny; needsSession?: boolean; sessionId?: string },
  run: (ctx: Ctx & { body: any; session: RedteamSession | null }) => Promise<Response> | Response
): Promise<Response> {
  const { identity, setCookie } = await resolveIdentity(req);
  const done = (res: Response) => withIdentityCookie(res, setCookie);
  const trace = { "Cache-Control": "no-store" };

  // The class is part of the key. A bucket is sized by whichever class touches
  // it, so sharing one across "upload" (10) and "exam" (30) let a handful of
  // session creations starve every tool call behind them.
  for (const bucket of [["redteam", opts.limit, callerAddress(req)], ["redteam-did", opts.limit, identity.userId]]) {
    const rl = checkLimit(limitKey(bucket), opts.limit);
    if (!rl.ok) {
      return done(
        Response.json(
          { error: { code: "RATE_LIMITED", message: "Slow down a little — try again in a moment.", retryable: true } },
          { status: 429, headers: { ...trace, "Retry-After": String(rl.retryAfterSec) } }
        )
      );
    }
  }

  let body: unknown = {};
  if (opts.schema) {
    const raw = await readCapped(req, MAX_BODY).catch(() => "");
    if (raw === null) return done(err("TOO_LARGE", "That request is too large.", false, 413));
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return done(err("BAD_REQUEST", "Expected JSON.", false, 400));
    }
    const parsed = opts.schema.safeParse(body);
    if (!parsed.success) return done(err("BAD_REQUEST", "That request is not shaped right.", false, 400));
    body = parsed.data;
  }

  let session: RedteamSession | null = null;
  if (opts.needsSession) {
    const id = opts.sessionId ?? (body as { sessionId?: string }).sessionId ?? "";
    session = await getSession(identity.userId, id);
    // One answer for "not yours" and "not there": the id is not a probe.
    if (!session) return done(err("SESSION_NOT_FOUND", "That review is not here any more. Start a new one.", false, 404));
  }

  try {
    const res = await run({ userId: identity.userId, req, done, body, session });
    return done(new Response(res.body, { status: res.status, headers: withNoStore(res.headers) }));
  } catch (e) {
    if (e instanceof RedteamError) {
      const status = e.code === "ENDED" ? 409 : e.code === "NOT_FOUND" ? 404 : 400;
      return done(err(e.code, e.message, false, status));
    }
    if (e instanceof DocumentError) return done(err(e.code, e.message, false, 400));
    console.error("redteam.route.failed", (e as Error)?.message?.slice(0, 200));
    return done(err("REDTEAM_UNAVAILABLE", "The review hit a problem. Try that again.", true, 500));
  }
}

function withNoStore(h: Headers): Headers {
  const out = new Headers(h);
  out.set("Cache-Control", "no-store");
  return out;
}

export async function persist(s: RedteamSession): Promise<void> {
  await saveSession(s);
}
