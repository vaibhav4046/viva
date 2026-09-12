import { cookies } from "next/headers";
import { randomBytes } from "crypto";

/**
 * Identity: an isolated per-browser demo identity, and nothing else.
 * - Demo identity = random 128-bit id in an HttpOnly cookie (`viva_did`).
 * - ALL data access is scoped to the resolved user id (§15, §16).
 * - No login never becomes access to arbitrary records: there is no
 *   user-switching parameter anywhere; the cookie is the identity.
 */

const DEMO_COOKIE = "viva_did";
export const DEMO_USER_PREFIX = "demo_";

export type Identity = { userId: string; kind: "demo" };

/**
 * Resolve the caller from the `viva_did` cookie, minting one when absent.
 *
 * The request is accepted but deliberately not trusted for identity: there is
 * no bearer-token path, so an Authorization header a caller invents resolves
 * to the same isolated demo identity as no header at all. The HttpOnly cookie
 * IS the boundary, and no user-switching parameter exists anywhere, so an
 * anonymous caller can never address another user's rows.
 */
export async function resolveIdentity(_req?: Request): Promise<{ identity: Identity; setCookie?: string }> {
  try {
    const store = await cookies();
    const existing = store.get(DEMO_COOKIE)?.value;
    if (existing && /^[0-9a-f]{32}$/.test(existing)) {
      return { identity: { userId: `${DEMO_USER_PREFIX}${existing}`, kind: "demo" } };
    }
  } catch { /* cookies() unavailable (tests) → mint below */ }
  const fresh = randomBytes(16).toString("hex");
  const setCookie = `${DEMO_COOKIE}=${fresh}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
  return { identity: { userId: `${DEMO_USER_PREFIX}${fresh}`, kind: "demo" }, setCookie };
}

export function demoCookieName(): string {
  return DEMO_COOKIE;
}
