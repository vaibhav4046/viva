import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_USER_PREFIX, demoCookieName, resolveIdentity } from "@/lib/auth/identity";
import { didFromCookieValue } from "@/lib/mcp/auth";

/**
 * The cookie-reading half of `resolveIdentity`, which nothing had ever run.
 *
 * `cookies()` throws outside a request scope, so under vitest the catch in
 * identity.ts swallowed it on every call and the function was, to the whole
 * suite, a `randomBytes` wrapper. Two mutations proved it: deleting the entire
 * try block (every student loses their history on every page load) and
 * weakening the 32-hex check to `if (existing)` (any caller-supplied cookie
 * value becomes a user id) both left all six tests in `auth.test.ts` green.
 *
 * So this file gives `next/headers` a cookie jar the test controls, and the
 * hit / malformed / missing branches each get a case. `auth.test.ts` keeps the
 * unmocked module, where `cookies()` really does throw.
 */

const jar = vi.hoisted(() => ({ value: undefined as string | undefined }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "viva_did" && jar.value !== undefined ? { name, value: jar.value } : undefined,
  }),
}));

/** 32 hex characters, the shape `randomBytes(16).toString("hex")` produces. */
const DID_A = "0123456789abcdef0123456789abcdef";
const DID_B = "fedcba9876543210fedcba9876543210";

beforeEach(() => {
  jar.value = undefined;
});

describe("resolveIdentity reads the viva_did cookie", () => {
  it("a device id already in the cookie is the identity, and nothing is re-minted", async () => {
    jar.value = DID_A;
    const { identity, setCookie } = await resolveIdentity();
    expect(identity.userId).toBe(`${DEMO_USER_PREFIX}${DID_A}`);
    expect(identity.kind).toBe("demo");
    // Re-minting here is the whole failure mode: a fresh cookie on every load
    // means a student's history belongs to a user id that lasts one request.
    expect(setCookie).toBeUndefined();
  });

  it("the same cookie twice is the same student; a different cookie is a different one", async () => {
    jar.value = DID_A;
    const first = (await resolveIdentity()).identity.userId;
    const again = (await resolveIdentity()).identity.userId;
    jar.value = DID_B;
    const other = (await resolveIdentity()).identity.userId;
    expect(again).toBe(first);
    expect(other).not.toBe(first);
  });

  /*
   * The cookie value is attacker-supplied: it is whatever sits in the request
   * header. Anything that is not a 128-bit device id must be discarded and a
   * fresh one minted, because the alternative is that the caller names their
   * own user id and reads the rows filed under it.
   */
  it.each([
    ["a user id someone else's rows are filed under", `${DEMO_USER_PREFIX}${DID_A}`],
    ["upper-case hex", DID_A.toUpperCase()],
    ["one character short", DID_A.slice(1)],
    ["one character long", `${DID_A}f`],
    ["non-hex characters", "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"],
    ["a path traversal", "../../../etc/passwd"],
    ["a smuggled cookie attribute", `${DID_A}; Path=/; HttpOnly`],
    ["a SQL fragment", "' OR 1=1 --"],
    ["empty", ""],
  ])("a malformed cookie is discarded, not trusted: %s", async (_label, value) => {
    jar.value = value;
    const { identity, setCookie } = await resolveIdentity();
    // Not "does not contain the value" — that is probabilistic on a short
    // input. The claim is exact: this value did not become the user id.
    expect(identity.userId).not.toBe(`${DEMO_USER_PREFIX}${value}`);
    expect(identity.userId).toMatch(new RegExp(`^${DEMO_USER_PREFIX}[0-9a-f]{32}$`));
    expect(setCookie).toBeDefined();
    expect(setCookie).toContain("HttpOnly");
  });

  it("no cookie mints one, and the cookie it sets is the identity it returned", async () => {
    const { identity, setCookie } = await resolveIdentity();
    expect(setCookie).toBeDefined();
    const did = identity.userId.slice(DEMO_USER_PREFIX.length);
    // A Set-Cookie carrying a different id than the one this response was
    // computed under hands the next request a stranger's identity.
    expect(setCookie).toContain(`${demoCookieName()}=${did}`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
  });

  it("an Authorization header cannot override the cookie it arrives with", async () => {
    jar.value = DID_A;
    const req = new Request("https://example.test/api/events/compile", {
      headers: { authorization: `Bearer ${DEMO_USER_PREFIX}${DID_B}` },
    });
    const { identity } = await resolveIdentity(req);
    expect(identity.userId).toBe(`${DEMO_USER_PREFIX}${DID_A}`);
  });
});

describe("the two device-id checks agree", () => {
  /*
   * identity.ts inlines `/^[0-9a-f]{32}$/` and mcp/auth.ts has its own copy
   * behind `didFromCookieValue`. They guard the same boundary from two files,
   * so they must not drift: a value one of them accepts and the other rejects
   * is a hole in whichever is wrong.
   */
  it.each([DID_A, DID_B, DID_A.toUpperCase(), DID_A.slice(1), `${DID_A}f`, "", "' OR 1=1 --"])(
    "%s",
    async (value) => {
      jar.value = value;
      const reused = (await resolveIdentity()).setCookie === undefined;
      expect(didFromCookieValue(value) !== null).toBe(reused);
    }
  );
});
