import { NextRequest } from "next/server";
import { demoCookieName, resolveIdentity } from "@/lib/auth/identity";
import { clientIp, withIdentityCookie } from "@/lib/http";
import { checkLimit, limitKey } from "@/lib/limits";
import { PAIR_TTL_SECONDS, didFromCookieValue, mintToken, pairingSurvivesDeploys } from "@/lib/mcp/auth";
import { err } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/mcp/pair — mint a short-lived code that hands this browser's
 * study account to one assistant.
 *
 * This is the ONE place a cookie turns into something an MCP client can hold,
 * and it only ever works in the direction that is safe: a browser that already
 * has the cookie asks for a code for itself. There is no parameter here — no
 * user, no device, no "pair this other account" — so the worst a caller can do
 * is mint a code for the identity they already are.
 *
 * `SameSite=Lax` is what keeps another site from making this call with the
 * student's cookie: Lax cookies are not sent on a cross-site POST.
 *
 * The code expires in ten minutes and carries no rights of its own. It buys
 * exactly one thing, once it is exchanged: a key scoped to this account.
 */
export async function POST(req: NextRequest) {
  const { identity, setCookie } = await resolveIdentity(req);
  const done = (res: Response) => withIdentityCookie(res, setCookie);

  const rl = checkLimit(limitKey(["mcp-pair", clientIp(req)]), "default");
  if (!rl.ok) {
    return done(
      Response.json(
        { error: { code: "RATE_LIMITED", message: "Slow down a little — try again in a moment.", retryable: true } },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
      )
    );
  }

  // The cookie value, not the row-owner string: the code has to rebuild the
  // exact cookie the app's own routes read.
  const cookieValue = req.cookies.get(demoCookieName())?.value;
  const did = didFromCookieValue(cookieValue) ?? didFromCookieValue(setCookie?.match(/viva_did=([0-9a-f]{32})/)?.[1]);
  if (!did) {
    return done(
      err("NO_IDENTITY", "VIVA could not tell which study account this browser is. Reload the page and try again.", true, 409)
    );
  }
  // The cookie and the identity the rest of the app derives must agree, or the
  // code would hand an assistant a different account than the one on screen.
  if (!identity.userId.endsWith(did)) {
    return done(err("NO_IDENTITY", "VIVA could not tell which study account this browser is. Reload the page and try again.", true, 409));
  }

  return done(
    Response.json({
      code: mintToken(did, "pair"),
      expiresInSeconds: PAIR_TTL_SECONDS,
      /** False when a paired assistant stops working after the next deploy. */
      survivesDeploys: pairingSurvivesDeploys(),
    })
  );
}
