import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The oral tool route returns next_focus with each checked answer: the concept
 * and question kind the examiner asks next, chosen by code from the stored map
 * and this exam's earlier answers. Real file store, real route, real grader
 * fallback (no model key is set in this test).
 */

const dir = mkdtempSync(path.join(tmpdir(), "viva-oral-focus-"));
const USER = "demo_00000000000000000000000000c0de03";
const saved = { DATA_DIR: process.env.DATA_DIR, DATABASE_URL: process.env.DATABASE_URL, POSTGRES_URL: process.env.POSTGRES_URL };
const pending: Promise<unknown>[] = [];

beforeAll(() => {
  process.env.DATA_DIR = dir;
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;
  vi.resetModules();
  vi.doMock("@/lib/auth/identity", () => ({ resolveIdentity: async () => ({ identity: { userId: USER, kind: "demo" } }) }));
  // after() runs its callback once the response is sent; here it runs at once and is awaited by the test.
  vi.doMock("next/server", async (orig) => ({ ...(await orig<object>()), after: (fn: () => Promise<void>) => { pending.push(fn()); } }));
});
afterAll(() => {
  vi.doUnmock("@/lib/auth/identity");
  vi.doUnmock("next/server");
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (let i = 0; i < 5; i++) {
    try { rmSync(dir, { recursive: true, force: true }); break; } catch { /* EBUSY, retry */ }
  }
});

async function call(callId: string, args: { question: string; answer: string }) {
  const { POST } = await import("@/app/api/oral/tool/route");
  const res = await POST(
    new Request("http://localhost/api/oral/tool", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callId, name: "grade_my_answer", arguments: args, sessionId: "oral_focus_session" }),
    })
  );
  const body = await res.json();
  await Promise.all(pending.splice(0));
  return body as { result: { verdict: string; next_focus?: { concept: string; concept_id: string; kind: string; reason: string } }; isError: boolean };
}

describe("POST /api/oral/tool returns next_focus", () => {
  it("names the concept and kind to ask next, and stays on the concept after a miss or partial answer", async () => {
    const wrong = await call("c1", {
      question: "What does multi-head attention add over one head?",
      answer: "Multi-head attention is just running one head twice, so nothing is added.",
    });
    expect(wrong.isError).toBe(false);
    expect(["incorrect", "partial"]).toContain(wrong.result.verdict);
    expect(wrong.result.next_focus).toBeDefined();
    // The answer named Multi-head attention and was not fully right, so the next question stays there.
    expect(wrong.result.next_focus).toMatchObject({ concept_id: "c_multihead" });
    expect(wrong.result.next_focus?.reason).toContain("Multi-head attention");
    expect(wrong.result.next_focus?.kind).toBe(wrong.result.verdict === "incorrect" ? "recall" : "why");
  });

  it("leaves a result without next_focus when the tool checked no answer", async () => {
    const { POST } = await import("@/app/api/oral/tool/route");
    const res = await POST(
      new Request("http://localhost/api/oral/tool", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callId: "s1", name: "search_my_material", arguments: { query: "positional encoding" }, sessionId: "oral_focus_session" }),
      })
    );
    const body = await res.json();
    expect(body.result.next_focus).toBeUndefined();
  });
});
