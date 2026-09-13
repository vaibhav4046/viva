import { randomBytes } from "crypto";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mintToken } from "@/lib/mcp/auth";
import { MAX_BATCH, handleBody } from "@/lib/mcp/rpc";
import type { ToolEnvironment } from "@/lib/mcp/tools";
import { POST } from "@/app/api/mcp/route";

/**
 * Two ways one POST to /api/mcp could cost more than the caller paid for.
 *
 * The first is fan-out: every element of a JSON-RPC batch can be a tools/call,
 * every tools/call reaches back into this same deployment over HTTP, and they
 * all go at once. An array is free to write and the work is ours, so the array
 * needs a ceiling.
 *
 * The second is the identity that ceiling's sibling depends on. The per-call
 * rate limits downstream are keyed on whatever the inner request says its
 * caller is. If that is a header the outside caller wrote, one bucket is one
 * `curl -H` away; if it is nothing at all, every paired student shares a
 * bucket and the limit is not per-caller in any sense. It has to be the key.
 */

const hex = () => randomBytes(16).toString("hex");

afterEach(() => vi.unstubAllGlobals());

function envWith(fetchSpy: ToolEnvironment["fetch"], authorization: string | null = null): ToolEnvironment {
  return { origin: "https://viva.test", authorization, forwardedFor: null, fetch: fetchSpy };
}

describe("a batch has a ceiling", () => {
  it("refuses an oversized batch outright, and reaches nothing while doing it", async () => {
    const calls: string[] = [];
    const env = envWith(async (url) => {
      calls.push(url);
      return Response.json({ subjects: [] });
    }, `Bearer ${mintToken(hex(), "access")}`);

    const batch = Array.from({ length: 200 }, (_, i) => ({
      jsonrpc: "2.0",
      id: i,
      method: "tools/call",
      params: { name: "list_my_subjects", arguments: {} },
    }));

    const answers = await handleBody(batch, env);

    // One refusal, not two hundred answers and not a silent sixteen.
    expect(answers).toHaveLength(1);
    expect(answers[0].id).toBeNull();
    expect(answers[0].error?.code).toBe(-32600);
    expect(answers[0].error?.message).toContain(String(MAX_BATCH));
    expect(answers[0].result).toBeUndefined();
    // Nothing fanned out: the ceiling is checked before any work starts.
    expect(calls).toEqual([]);
  });

  it("a batch at the ceiling still answers every message in it", async () => {
    const env = envWith(async () => Response.json({ subjects: [] }));
    const batch = Array.from({ length: MAX_BATCH }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "ping" }));
    const answers = await handleBody(batch, env);
    expect(answers).toHaveLength(MAX_BATCH);
    expect(answers.every((a) => a.error === undefined)).toBe(true);
  });
});

describe("the caller the rate limit sees", () => {
  /** POST one tools/call through the real route, and report what the inner request carried. */
  async function innerForwardedFor(key: string, header: string | null): Promise<string | undefined> {
    let seen: string | undefined;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      seen = (init.headers as Record<string, string>)["x-forwarded-for"];
      return Response.json({ subjects: [] });
    });
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      authorization: `Bearer ${key}`,
      host: "viva.test",
    };
    if (header) headers["x-forwarded-for"] = header;
    const res = await POST(
      new NextRequest("https://viva.test/api/mcp", {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "list_my_subjects", arguments: {} },
        }),
      })
    );
    expect(res.status).toBe(200);
    return seen;
  }

  it("is the key, never a header the caller wrote", async () => {
    const key = mintToken(hex(), "access");
    const spoofed = await innerForwardedFor(key, "203.0.113.9");
    // The caller's own value must not survive to the limiter in any form.
    expect(spoofed).toBeDefined();
    expect(spoofed).not.toContain("203.0.113.9");
    // Same key, different header: the same bucket, so rotating a header buys nothing.
    expect(await innerForwardedFor(key, "198.51.100.4")).toBe(spoofed);
    expect(await innerForwardedFor(key, null)).toBe(spoofed);
  });

  it("gives two paired students two buckets", async () => {
    const a = await innerForwardedFor(mintToken(hex(), "access"), null);
    const b = await innerForwardedFor(mintToken(hex(), "access"), null);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a).not.toBe(b);
  });
});
