import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetLimits } from "@/lib/limits";

/**
 * A streaming token is minted for a learner, not for whoever finds the URL.
 *
 * The endpoint spends the owner's AssemblyAI meter. Every other route in the
 * app resolves the `viva_did` cookie and mints one when it is absent; this one
 * did not, so the only thing standing between the meter and a stranger was a
 * per-IP bucket — and rotating the IP is the ordinary way around that.
 *
 * These two cases are the requirement. Delete `resolveIdentity` from the route
 * and the first fails; drop the learner bucket and the second fails.
 *
 * What they do NOT claim: that a caller who refuses cookies is stopped. That
 * caller is minted a fresh identity per request and stays bounded by the IP
 * bucket alone, which is the price of the no-sign-in-wall guarantee.
 */

const jar = vi.hoisted(() => ({ value: undefined as string | undefined }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "viva_did" && jar.value !== undefined ? { name, value: jar.value } : undefined,
  }),
}));

const { GET } = await import("@/app/api/voice/stream-token/route");

/** 32 hex characters, the shape `randomBytes(16).toString("hex")` produces. */
const DID_A = "0123456789abcdef0123456789abcdef";
const DID_B = "fedcba9876543210fedcba9876543210";

/** The per-minute ceiling of the "transcribe" limit class. */
const BUDGET = 12;

const savedFetch = globalThis.fetch;
const savedEnv = { ...process.env };

beforeEach(() => {
  process.env.ASSEMBLYAI_API_KEY = "test-key";
  jar.value = undefined;
  __resetLimits();
  globalThis.fetch = (async () =>
    Response.json({ token: "tok_live", expires_in_seconds: 300 })) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  process.env = { ...savedEnv };
  __resetLimits();
});

function get(ip: string): Promise<Response> {
  return GET(
    new Request("http://localhost/api/voice/stream-token", { headers: { "x-forwarded-for": ip } })
  );
}

describe("GET /api/voice/stream-token binds the token to a learner", () => {
  it("a first-time visitor with no cookie still gets a token, and gets an identity with it", async () => {
    const res = await get("203.0.113.1");
    expect(res.status).toBe(200);
    expect((await res.json()).token).toBe("tok_live");
    // No sign-in wall: the first hold of the mic must work. But the response
    // has to hand back the identity it minted, or the next request is another
    // stranger and there is nothing to meter per learner.
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toMatch(/^viva_did=[0-9a-f]{32}/);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
  });

  it("a learner who already has a cookie keeps it — no churn, no second identity", async () => {
    jar.value = DID_A;
    const res = await get("203.0.113.2");
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("the budget follows the learner across IPs, and one learner cannot spend another's", async () => {
    jar.value = DID_A;
    // Twelve tokens, each from a different address, so every per-IP bucket is
    // untouched. Only a per-learner bucket can be running down here.
    for (let i = 0; i < BUDGET; i++) {
      expect((await get(`198.51.100.${i}`)).status).toBe(200);
    }
    const refused = await get("198.51.100.200");
    expect(refused.status).toBe(429);
    expect(refused.headers.get("Retry-After")).toBeTruthy();
    expect((await refused.json()).error.code).toBe("RATE_LIMITED");

    // …and the ceiling is theirs alone: the next learner is not paying for it.
    jar.value = DID_B;
    expect((await get("198.51.100.201")).status).toBe(200);
  });

  it("the per-IP bucket still holds: one address cannot mint past the class budget", async () => {
    jar.value = DID_A;
    for (let i = 0; i < BUDGET; i++) {
      expect((await get("203.0.113.9")).status).toBe(200);
    }
    // Same address, a different learner — the IP ceiling is what refuses this,
    // and losing it would make cookie-swapping a way around the meter.
    jar.value = DID_B;
    expect((await get("203.0.113.9")).status).toBe(429);
  });
});
