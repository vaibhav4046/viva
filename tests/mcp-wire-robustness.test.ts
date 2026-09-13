import { randomBytes } from "crypto";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { mintToken } from "@/lib/mcp/auth";
import { handleBody, handleMessage, parseError } from "@/lib/mcp/rpc";
import type { ToolEnvironment } from "@/lib/mcp/tools";
import { DELETE, GET, POST } from "@/app/api/mcp/route";

/**
 * The wire must answer, never crash.
 *
 * Every shape a client can POST — malformed JSON-RPC, nested arrays,
 * oversized batches, missing/garbage/expired/mis-purposed credentials —
 * gets a well-formed JSON-RPC answer or a 4xx. An oversized batch of real
 * tool calls fans out to nothing. Callers without a readable key share one
 * bucket and are refused before anything is spent.
 */
const hex = () => randomBytes(16).toString("hex");
const env: ToolEnvironment = {
  origin: "https://viva.test",
  authorization: null,
  forwardedFor: "mcp:unpaired",
  fetch: async () => Response.json({ subjects: [] }),
};

function post(body: string | null, headers: Record<string, string> = {}) {
  return POST(
    new NextRequest("https://viva.test/api/mcp", {
      method: "POST",
      headers: { host: "viva.test", ...headers },
      body,
    })
  );
}

describe("adversarial: wire shapes", () => {
  it("never throws on any JSON shape", async () => {
    const shapes: unknown[] = [
      null, "hello", 42, true, [], {}, { method: 42, id: 1 },
      { id: 1 }, { method: "ping" }, { method: "ping", id: null },
      { method: "nope", id: 7 }, { method: "nope" },
      { method: "tools/call", id: 1, params: null },
      { method: "tools/call", id: 1, params: { name: 42 } },
      { method: "tools/call", id: 1, params: { name: "list_my_subjects", arguments: "oops" } },
      { method: "initialize", id: 1, params: { protocolVersion: 123 } },
      { method: "initialize", id: 1, params: { protocolVersion: null } },
      { method: "initialize", id: 1, params: null },
      [["nested"]], [{ method: "ping", id: 1 }, ["nested"], null, "s"],
      Array.from({ length: 17 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "ping" })),
      Array.from({ length: 17 }, (_, i) => ({
        jsonrpc: "2.0", id: i, method: "tools/call",
        params: { name: "list_my_subjects", arguments: {} },
      })),
    ];
    for (const shape of shapes) {
      const out = await handleBody(shape, env);
      expect(Array.isArray(out)).toBe(true);
      for (const r of out) {
        expect(r.jsonrpc).toBe("2.0");
        expect(r.result !== undefined || r.error !== undefined).toBe(true);
      }
    }
  });

  it("a 17-batch of real tool calls fans out to nothing", async () => {
    let calls = 0;
    const counting: ToolEnvironment = {
      ...env,
      authorization: `Bearer ${mintToken(hex(), "access")}`,
      fetch: async () => { calls += 1; return Response.json({ subjects: [] }); },
    };
    const batch = Array.from({ length: 17 }, (_, i) => ({
      jsonrpc: "2.0", id: i, method: "tools/call",
      params: { name: "list_my_subjects", arguments: {} },
    }));
    const out = await handleBody(batch, counting);
    expect(out).toHaveLength(1);
    expect(out[0].error?.code).toBe(-32600);
    expect(calls).toBe(0);
  });

  it("parseError is a well-formed JSON-RPC error", () => {
    const e = parseError();
    expect(e.jsonrpc).toBe("2.0");
    expect(e.error?.code).toBe(-32700);
  });
});

describe("adversarial: HTTP edge", () => {
  it("empty body is a 400 parse error, not a 500", async () => {
    const res = await post(null, { "Content-Type": "application/json" });
    expect(res.status).toBe(400);
  });

  it("garbage body is a 400 parse error", async () => {
    const res = await post("{not json", { "Content-Type": "application/json" });
    expect(res.status).toBe(400);
  });

  it("unauthenticated, garbage, expired and wrong-purpose callers all land unpaired and are refused without spend", async () => {
    const did = hex();
    const expired = mintToken(did, "access", Date.now() - 31 * 24 * 3600 * 1000);
    const pairCode = mintToken(did, "pair");
    const cases: (string | null)[] = [null, "Bearer garbage", `Bearer ${expired}`, `Bearer ${pairCode}`];
    for (const auth of cases) {
      let spent = false;
      vi.stubGlobal("fetch", async () => { spent = true; return Response.json({ subjects: [] }); });
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (auth) headers.authorization = auth;
      const res = await post(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_my_subjects", arguments: {} } }),
        headers
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.isError ?? body.result?.isError).toBeTruthy();
      expect(spent).toBe(false);
      vi.unstubAllGlobals();
    }
  });

  it("GET and DELETE are 405", async () => {
    expect(GET().status).toBe(405);
    expect(DELETE().status).toBe(405);
  });
});
