import { z } from "zod";
import { resolveIdentity } from "@/lib/auth/identity";
import { checkLimit, limitKey, type LimitClass } from "@/lib/limits";
import { withIdentityCookie } from "@/lib/http";
import { err } from "@/lib/types";
import { getSession, saveSession } from "./store";
import { RedteamError, publicView } from "./session";
import { DocumentError } from "./document";
import { revisionOf, sealSession, type Snapshot } from "./seal";
import type { RedteamSession } from "./types";

/**
 * Shared plumbing for the RedTeam routes: who is asking, are they within
 * budget, is the body sane, and does the session they name belong to them.
 * Written once so no route can forget one of the four.
 */

const MAX_BODY = 96_000;

/**
 * How many events of the review the browser has already seen (see `revisionOf`).
 * The browser's client sends it on calls it makes about a review it holds a
 * sealed copy of. It is a hint that can only ever make a route refuse, never
 * accept: a caller who lies about it locks themselves out of their own review
 * until they restore, and learns only how far their own review has got, because
 * the refusal is the same answer as for a review that does not exist.
 */
const REVISION_HEADER = "x-redteam-rev";

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

/** The revision the browser said it had seen, or null when it did not say (or said something else). */
function seenByBrowser(req: Request): number | null {
  const v = req.headers.get(REVISION_HEADER);
  return v !== null && /^\d{1,7}$/.test(v) ? Number(v) : null;
}

/**
 * The answer for a review that is not here: never made, someone else's, gone
 * with an instance, or behind what the browser has seen. One body for all of
 * them, so the answer is not a way to tell them apart.
 */
export function sessionGone(): Response {
  return err("SESSION_NOT_FOUND", "That review is not here any more. Start a new one.", false, 404);
}

export type Ctx = { userId: string; req: Request; done: (res: Response) => Response };

export async function handle(
  req: Request,
  // `maxBody` exists for the one route whose body is a sealed review, which is
  // legitimately larger than anything a person types.
  opts: { limit: LimitClass; schema?: z.ZodTypeAny; needsSession?: boolean; sessionId?: string; maxBody?: number },
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
    const raw = await readCapped(req, opts.maxBody ?? MAX_BODY).catch(() => "");
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
    // An instance holding an older copy of the review than the browser last saw
    // would answer from it, fork the ledger and drop what happened elsewhere
    // without a word. It says "not here" instead, which sends the browser to
    // restore its newer copy over this one. Only a browser that holds a sealed
    // copy sends the hint, so every other caller is unaffected.
    const seen = seenByBrowser(req);
    if (session && seen !== null && revisionOf(session) < seen) session = null;
    // One answer for "not yours" and "not there": the id is not a probe.
    if (!session) return done(sessionGone());
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

/**
 * What a response says about a review: the screen's view of it, and the sealed
 * copy the browser keeps so a restore is possible (see seal.ts). Every route
 * that returns a review spreads this, so no route can forget the copy.
 *
 * Sealing must not be able to fail a request. By the time a route calls this it
 * has already changed and saved the review, and an error now would tell the
 * browser to try again a change that happened. So a failure sends the reply
 * without a copy, and the browser drops the older copy it holds rather than
 * restore a review to a state that is behind. Nothing about the review is logged.
 */
export function reviewFields(s: RedteamSession): { session: ReturnType<typeof publicView>; snapshot?: Snapshot } {
  const session = publicView(s);
  try {
    return { session, snapshot: sealSession(s) };
  } catch (e) {
    console.error("redteam.seal.failed", (e as Error)?.name);
    return { session };
  }
}
