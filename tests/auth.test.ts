import { describe, expect, it } from "vitest";
import { demoCookieName, DEMO_USER_PREFIX, resolveIdentity } from "@/lib/auth/identity";

describe("identity config", () => {
  it("demo cookie name is the stable HttpOnly identity boundary", () => {
    expect(demoCookieName()).toBe("viva_did");
    expect(DEMO_USER_PREFIX).toBe("demo_");
  });
});

describe("resolveIdentity is cookie-only", () => {
  it("no request → minted demo identity in an HttpOnly SameSite=Lax cookie", async () => {
    const { identity, setCookie } = await resolveIdentity();
    expect(identity.kind).toBe("demo");
    expect(identity.userId).toMatch(new RegExp(`^${DEMO_USER_PREFIX}[0-9a-f]{32}$`));
    // The cookie itself IS the credential, so it must never be readable by JS.
    expect(setCookie).toBeDefined();
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).not.toContain("undefined");
  });

  /*
   * Fail-closed guard, restated for the cookie-only world: there is no bearer
   * token path left, so an Authorization header a caller invents must be inert
   * — it can neither be promoted to some other identity nor cause a 401. It
   * resolves to exactly the same isolated demo identity as no header at all.
   */
  it.each([
    ["a bogus bearer token", "Bearer not-a-real-token"],
    ["a forged privy-looking token", "Bearer eyJhbGciOiJIUzI1NiJ9.forged.sig"],
    ["a non-bearer scheme", "Basic ZGVtbzpkZW1v"],
  ])("Authorization header is ignored: %s", async (_label, header) => {
    const req = new Request("https://example.test/api/events/compile", {
      headers: { authorization: header },
    });
    const { identity } = await resolveIdentity(req);
    expect(identity.kind).toBe("demo");
    expect(identity.userId).toMatch(new RegExp(`^${DEMO_USER_PREFIX}[0-9a-f]{32}$`));
    // No claim from the header may leak into the resolved id.
    expect(identity.userId).not.toContain("privy");
  });

  it("two callers with no cookie get separate isolated identities", async () => {
    const a = await resolveIdentity();
    const b = await resolveIdentity();
    expect(a.identity.userId).not.toBe(b.identity.userId);
  });
});
