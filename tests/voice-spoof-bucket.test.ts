import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetLimits } from "@/lib/limits";
import { POST as transcribe } from "@/app/api/voice/transcribe/route";
import { GET as streamToken } from "@/app/api/voice/stream-token/route";
import { POST as telemetry } from "@/app/api/voice/telemetry/route";

/**
 * The three routes that spend the AssemblyAI balance charge the hop the
 * platform wrote, not the one the caller sent.
 *
 * `src/lib/http.ts` was fixed to read the last entry of `x-forwarded-for`
 * rather than the first, and ten routes call it. These three did not — each
 * kept a local copy still reading `[0]`, which is the entry the caller gets to
 * choose. Rotating one header therefore handed out a fresh token bucket per
 * request on exactly the endpoints where a bypassed limit costs money.
 *
 * Each case rotates the forged leftmost entry and keeps the real last hop
 * fixed. Under the old spelling the key moved every request and the bucket
 * never ran out; under the shared helper the key is the last hop and the
 * budget is spent. The second case is the control: distinct real hops must
 * still get distinct buckets, or "always refuse" would pass the first.
 */

/** The per-minute ceiling of the "transcribe" limit class, which all three use. */
const BUDGET = 12;

/** The address the nearest trusted proxy actually wrote. */
const REAL_HOP = "203.0.113.9";

const savedFetch = globalThis.fetch;

beforeEach(() => {
  __resetLimits();
  // Pin the non-Vercel path: `x-forwarded-for` is the chain under test.
  vi.stubEnv("VERCEL", "");
  delete process.env.ASSEMBLYAI_API_KEY;
  // Nothing here should reach the network. If a route ever does, fail loudly
  // rather than spend someone's balance from a unit test.
  globalThis.fetch = (async () => {
    throw new Error("a rate-limit test must not reach AssemblyAI");
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  vi.unstubAllEnvs();
  __resetLimits();
});

/** One request per route, with a caller-controlled chain in front of `hop`. */
const ROUTES = {
  "POST /api/voice/transcribe": (chain: string) =>
    transcribe(
      new Request("http://localhost/api/voice/transcribe", {
        method: "POST",
        headers: { "x-forwarded-for": chain },
        // Not a multipart body: the limiter runs before the audio is read, so
        // the route refuses this at 415 — every status except 429 is a pass.
        body: "not-a-form",
      })
    ),
  "GET /api/voice/stream-token": (chain: string) =>
    streamToken(
      new Request("http://localhost/api/voice/stream-token", { headers: { "x-forwarded-for": chain } })
    ),
  "POST /api/voice/telemetry": (chain: string) =>
    telemetry(
      new Request("http://localhost/api/voice/telemetry", {
        method: "POST",
        headers: { "x-forwarded-for": chain, "content-type": "application/json" },
        body: JSON.stringify({ latencyMs: 1200, mode: "dictation" }),
      })
    ),
} as const;

describe.each(Object.entries(ROUTES))("%s refuses the forged hop", (_name, call) => {
  it("rotating the leftmost x-forwarded-for entry does not buy a fresh bucket", async () => {
    const spent: number[] = [];
    for (let i = 0; i < BUDGET; i++) spent.push((await call(`10.0.0.${i}, ${REAL_HOP}`)).status);
    // The budget belongs to REAL_HOP, so it is now gone however many addresses
    // the caller claimed to be on the way in.
    expect(spent).not.toContain(429);
    expect((await call(`10.0.0.99, ${REAL_HOP}`)).status).toBe(429);
    expect((await call(`198.51.100.7, ${REAL_HOP}`)).status).toBe(429);
  });

  it("but a genuinely different last hop still gets its own budget", async () => {
    for (let i = 0; i < BUDGET; i++) await call(`10.0.0.${i}, ${REAL_HOP}`);
    expect((await call(`10.0.0.0, ${REAL_HOP}`)).status).toBe(429);
    // A different person behind a different proxy is not the spender above.
    expect((await call("198.51.100.4")).status).not.toBe(429);
  });
});
