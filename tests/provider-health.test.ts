import { afterEach, describe, expect, it } from "vitest";
import { ProviderError, providerStatus, setReasoningProvider } from "@/lib/ai/provider";
import { reasonObject } from "@/lib/ai/reason";
import { z } from "zod";

/**
 * A configured provider that never works, and no provider at all, used to look
 * identical from outside: `configured: true, lastLatencyMs: null`, every turn
 * quietly answering from the heuristic. That is how a dead model path survives
 * to a deadline. The failure class has to leave the building.
 */

const Shape = z.object({ ok: z.boolean() });
const ask = () => reasonObject({ system: "s", user: "u", schema: Shape, timeoutMs: 500 });

function stub(behaviour: () => Promise<unknown>) {
  setReasoningProvider({
    name: "stub",
    async generateText() { return ""; },
    async generateObject() { return (await behaviour()) as never; },
  });
}

afterEach(() => setReasoningProvider(null));

describe("provider health is reportable from outside", () => {
  it("starts unknown, and unknown is not broken", () => {
    stub(async () => ({ ok: true }));
    const s = providerStatus();
    expect(s.configured).toBe(true);
    expect(s.lastOutcome).toBeNull();
    expect(s.usable).toBe(true); // nobody has asked it yet
  });

  it("names the failure class when the model answers with the wrong shape", async () => {
    stub(async () => { throw new ProviderError("SCHEMA_MISMATCH", "did not match", false); });
    expect(await ask()).toBeNull(); // the learner still gets an answer
    const s = providerStatus();
    expect(s.lastOutcome).toBe("SCHEMA_MISMATCH");
    expect(s.usable).toBe(false);
    expect(s.failuresSinceOk).toBe(1);
    expect(s.lastFailureAt).not.toBeNull();
  });

  it("tells a rate limit apart from a timeout apart from a broken shape", async () => {
    for (const code of ["RATE_LIMITED", "TRANSPORT_TIMEOUT", "PROVIDER_ERROR"] as const) {
      stub(async () => { throw new ProviderError(code, "x", true); });
      await ask();
      expect(providerStatus().lastOutcome).toBe(code);
    }
  });

  it("counts consecutive failures and clears them on the next success", async () => {
    stub(async () => { throw new ProviderError("RATE_LIMITED", "429", true); });
    await ask();
    await ask();
    await ask();
    expect(providerStatus().failuresSinceOk).toBe(3);

    stub(async () => ({ ok: true }));
    // stub() resets the health block, so re-fail once and then succeed.
    setReasoningProvider({
      name: "stub",
      async generateText() { return ""; },
      async generateObject() { return { ok: true } as never; },
    });
    expect(await ask()).not.toBeNull();
    const s = providerStatus();
    expect(s.lastOutcome).toBe("ok");
    expect(s.failuresSinceOk).toBe(0);
    expect(s.lastOkAt).not.toBeNull();
    expect(s.usable).toBe(true);
    expect(s.lastLatencyMs).not.toBeNull();
  });

  it("never puts the provider's own message where readiness can print it", async () => {
    stub(async () => { throw new ProviderError("PROVIDER_ERROR", "Bearer sk-secret-leaked-here", false); });
    await ask();
    expect(JSON.stringify(providerStatus())).not.toMatch(/sk-secret/);
  });
});
