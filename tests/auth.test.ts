import { describe, expect, it } from "vitest";
import { demoCookieName, DEMO_USER_PREFIX, resolveIdentity } from "@/lib/auth/identity";

/**
 * `resolveIdentity` with the real `next/headers`, which throws outside a
 * request scope — so everything here is the mint branch. The cookie-reading
 * branch needs a jar and lives in `auth-cookie.test.ts`; this file used to
 * claim to cover it and could not, because `expect(setCookie).toBeDefined()`
 * only ever holds when the cookie was missing.
 */

describe("identity config", () => {
  it("demo cookie name is the stable HttpOnly identity boundary", () => {
    expect(demoCookieName()).toBe("viva_did");
    expect(DEMO_USER_PREFIX).toBe("demo_");
  });
});

describe("resolveIdentity with no cookie jar", () => {
  it("mints a demo identity and hands back the cookie that carries it", async () => {
    const { identity, setCookie } = await resolveIdentity();
    expect(identity.kind).toBe("demo");
    expect(identity.userId).toMatch(new RegExp(`^${DEMO_USER_PREFIX}[0-9a-f]{32}$`));
    // The cookie itself IS the credential, so it must never be readable by JS,
    // and it must carry the id this response was already computed under.
    expect(setCookie).toBeDefined();
    expect(setCookie).toContain(`${demoCookieName()}=${identity.userId.slice(DEMO_USER_PREFIX.length)}`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).not.toContain("undefined");
  });

  /*
   * Fail-closed guard, restated for the cookie-only world: there is no bearer
   * token path left, so an Authorization header a caller invents must be inert
   * — it can neither be promoted to some other identity nor cause a 401. With
   * a cookie present it must also lose to the cookie, which is asserted in
   * `auth-cookie.test.ts`; with no cookie it resolves to a fresh isolated
   * identity, exactly as no header at all would.
   */
  it("an invented Authorization header buys nothing", async () => {
    const req = new Request("https://example.test/api/events/compile", {
      headers: { authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.forged.sig" },
    });
    const { identity } = await resolveIdentity(req);
    expect(identity.kind).toBe("demo");
    expect(identity.userId).toMatch(new RegExp(`^${DEMO_USER_PREFIX}[0-9a-f]{32}$`));
  });
});
