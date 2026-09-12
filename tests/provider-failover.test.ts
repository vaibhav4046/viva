import { describe, expect, it, vi, afterEach } from "vitest";
import { z } from "zod";
import { FailoverProvider, ProviderError, parseFallbackChain } from "@/lib/ai/provider";

const Shape = z.object({ ok: z.boolean() });

/**
 * A stand-in for one credential. `generateObject` is the only method the tutor
 * path uses, so the double implements the interface loosely and the cast is
 * confined to the helper rather than sprinkled through the tests.
 */
function credential(name: string, behaviour: () => Promise<{ ok: boolean }>) {
  const calls = { count: 0 };
  const provider = {
    name: "openai-compatible",
    modelName: name,
    async generateText() {
      return "";
    },
    async generateObject() {
      calls.count += 1;
      return behaviour();
    },
  };
  return { provider, calls };
}

function chainOf(...entries: { provider: unknown }[]) {
  return new FailoverProvider(entries.map((e) => e.provider) as never);
}

const ask = { system: "s", user: "u", schema: Shape };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("parseFallbackChain", () => {
  it("reads comma-separated baseUrl|key|model entries", () => {
    const chain = parseFallbackChain("https://a.example/v1|k1|m1,https://b.example/v1|k2|m2");
    expect(chain.map((c) => c.modelName)).toEqual(["m1", "m2"]);
  });

  it("is empty when unset", () => {
    expect(parseFallbackChain(undefined)).toEqual([]);
    expect(parseFallbackChain("")).toEqual([]);
  });

  it("drops malformed entries instead of throwing, so a typo cannot take the primary down", () => {
    const chain = parseFallbackChain("garbage,https://a.example/v1|k1,http://insecure/v1|k|m,https://b.example/v1|k2|m2");
    expect(chain.map((c) => c.modelName)).toEqual(["m2"]);
  });
});

describe("FailoverProvider", () => {
  it("uses the first credential when it answers", async () => {
    const first = credential("first", async () => ({ ok: true }));
    const second = credential("second", async () => ({ ok: false }));
    await expect(chainOf(first, second).generateObject(ask)).resolves.toEqual({ ok: true });
    expect(second.calls.count).toBe(0);
  });

  it("falls through to the next credential when the first is rate limited", async () => {
    const first = credential("first", async () => {
      throw new ProviderError("RATE_LIMITED", "429", true);
    });
    const second = credential("second", async () => ({ ok: true }));
    await expect(chainOf(first, second).generateObject(ask)).resolves.toEqual({ ok: true });
    expect(first.calls.count).toBe(1);
    expect(second.calls.count).toBe(1);
  });

  it("falls through on a schema mismatch too, because another model may parse", async () => {
    const first = credential("first", async () => {
      throw new ProviderError("SCHEMA_MISMATCH", "bad shape", false);
    });
    const second = credential("second", async () => ({ ok: true }));
    await expect(chainOf(first, second).generateObject(ask)).resolves.toEqual({ ok: true });
  });

  it("stops paying for a rate-limited credential on the next turn", async () => {
    vi.useFakeTimers();
    const first = credential("first", async () => {
      throw new ProviderError("RATE_LIMITED", "429", true);
    });
    const second = credential("second", async () => ({ ok: true }));
    const chain = chainOf(first, second);

    await chain.generateObject(ask);
    await chain.generateObject(ask);
    expect(first.calls.count).toBe(1);
    expect(second.calls.count).toBe(2);

    // The cooldown is a pause, not a write-off: the budget resets eventually.
    vi.advanceTimersByTime(61_000);
    await chain.generateObject(ask);
    expect(first.calls.count).toBe(2);
  });

  it("tries everything again rather than give up when every credential is cooling down", async () => {
    vi.useFakeTimers();
    let firstFails = true;
    const first = credential("first", async () => {
      if (firstFails) throw new ProviderError("RATE_LIMITED", "429", true);
      return { ok: true };
    });
    const second = credential("second", async () => {
      throw new ProviderError("RATE_LIMITED", "429", true);
    });
    const chain = chainOf(first, second);

    await expect(chain.generateObject(ask)).rejects.toThrow();
    firstFails = false;
    await expect(chain.generateObject(ask)).resolves.toEqual({ ok: true });
  });

  it("throws the last failure when no credential answers, so the caller can use the heuristic", async () => {
    const only = credential("only", async () => {
      throw new ProviderError("PROVIDER_ERROR", "500", true);
    });
    await expect(chainOf(only).generateObject(ask)).rejects.toThrow(ProviderError);
  });
});

describe("FailoverProvider budget", () => {
  it("shares the caller's timeout across the chain instead of giving each link the whole thing", async () => {
    const given: number[] = [];
    const burn = (ms: number) => ({
      provider: {
        name: "openai-compatible",
        modelName: "burn" + ms,
        async generateText() { return ""; },
        async generateObject(input: { timeoutMs?: number }) {
          given.push(input.timeoutMs ?? -1);
          await new Promise((r) => setTimeout(r, ms));
          throw new ProviderError("PROVIDER_ERROR", "500", true);
        },
      },
    });
    // The first credential spends 2s of a 6s budget. The second must be told
    // it has about 4s left, not another full 6s — that is the whole bug.
    const chain = chainOf(burn(2_000), burn(10));
    const started = Date.now();
    await expect(chain.generateObject({ ...ask, timeoutMs: 6_000 })).rejects.toThrow(ProviderError);
    const elapsed = Date.now() - started;

    expect(given).toHaveLength(2);
    expect(given[0]).toBeLessThanOrEqual(3_100);
    expect(given[1]).toBeLessThanOrEqual(6_000 - 1_900);
    expect(elapsed).toBeLessThan(6_000);
  });

  it("stops asking once the budget is gone rather than starting another attempt", async () => {
    const tried: string[] = [];
    const burn = (name: string, ms: number) => ({
      provider: {
        name: "openai-compatible",
        modelName: name,
        async generateText() { return ""; },
        async generateObject() {
          tried.push(name);
          await new Promise((r) => setTimeout(r, ms));
          throw new ProviderError("TRANSPORT_TIMEOUT", "timed out", true);
        },
      },
    });
    const chain = chainOf(burn("a", 1_600), burn("b", 10), burn("c", 10));
    await expect(chain.generateObject({ ...ask, timeoutMs: 1_500 })).rejects.toThrow(ProviderError);
    // "a" alone outlives the budget, so "b" and "c" are never dialled.
    expect(tried).toEqual(["a"]);
  });

  it("never slices an attempt below the floor, however long the chain", async () => {
    const given: number[] = [];
    const entry = () => ({
      provider: {
        name: "openai-compatible",
        modelName: "x",
        async generateText() { return ""; },
        async generateObject(input: { timeoutMs?: number }) {
          given.push(input.timeoutMs ?? -1);
          throw new ProviderError("PROVIDER_ERROR", "500", true);
        },
      },
    });
    const chain = chainOf(entry(), entry(), entry(), entry());
    await expect(chain.generateObject({ ...ask, timeoutMs: 2_000 })).rejects.toThrow();
    for (const ms of given) expect(ms).toBeGreaterThanOrEqual(1_000);
  });

  it("hands a fast failure's unused time to the next credential", async () => {
    const given: number[] = [];
    const fast = {
      provider: {
        name: "openai-compatible", modelName: "fast",
        async generateText() { return ""; },
        async generateObject(input: { timeoutMs?: number }) {
          given.push(input.timeoutMs ?? -1);
          throw new ProviderError("RATE_LIMITED", "429", true);
        },
      },
    };
    const ok = {
      provider: {
        name: "openai-compatible", modelName: "ok",
        async generateText() { return ""; },
        async generateObject(input: { timeoutMs?: number }) {
          given.push(input.timeoutMs ?? -1);
          return { ok: true };
        },
      },
    };
    await expect(chainOf(fast, ok).generateObject({ ...ask, timeoutMs: 8_000 })).resolves.toEqual({ ok: true });
    // The 429 costs almost nothing, so the survivor still gets most of the budget.
    expect(given[1]).toBeGreaterThan(given[0]);
  });
});
