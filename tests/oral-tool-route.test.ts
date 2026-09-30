import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/oral/tool, the route the Voice Agent's tool calls land on.
 *
 * The store is a recording fake so the assertions are about what the route
 * would have written to a learner's map, not about what a mock returns.
 */

const store = vi.hoisted(() => ({
  recordLearning: vi.fn(async () => ({})),
  getCourseChunks: vi.fn(async () => [] as unknown[]),
  getSubject: vi.fn(async () => null),
}));

vi.mock("@/lib/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/store")>();
  return { ...actual, getStore: () => store as never };
});
// `after` needs a request scope; run the callback inline so writes are observable.
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: (fn: () => unknown) => { void fn(); } };
});

const { POST } = await import("@/app/api/oral/tool/route");

function post(body: unknown, headers: Record<string, string> = {}): Request {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Request("http://localhost/api/oral/tool", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: text,
  });
}

beforeEach(() => {
  store.recordLearning.mockClear();
  store.getCourseChunks.mockClear();
});

describe("tool allowlist", () => {
  it("does not run save_note, so a model-supplied correct:true cannot file mastery up", async () => {
    const res = await POST(
      post({ callId: "c1", name: "save_note", arguments: { claim: "Attention is O(1).", correct: true } })
    );
    const body = (await res.json()) as { isError: boolean; result: Record<string, unknown> };
    expect(body.isError).toBe(true);
    expect(store.recordLearning).not.toHaveBeenCalled();
  });

  it("does not run the legacy lexical tools the Voice Agent is never offered", async () => {
    for (const name of ["quote_my_material", "check_my_understanding", "constructor", "__proto__"]) {
      const res = await POST(post({ callId: "c2", name, arguments: { claim: "x" } }));
      const body = (await res.json()) as { isError: boolean };
      expect(body.isError, name).toBe(true);
    }
    expect(store.recordLearning).not.toHaveBeenCalled();
  });

  it("still runs the three tools the agent is offered", async () => {
    const res = await POST(post({ callId: "c3", name: "search_my_material", arguments: { query: "attention" } }));
    const body = (await res.json()) as { isError: boolean };
    expect(res.status).toBe(200);
    expect(body.isError).toBe(false);
  });
});

describe("request size", () => {
  it("answers 413 for a body over 16 KB without parsing it", async () => {
    const big = JSON.stringify({ callId: "c4", name: "search_my_material", arguments: { query: "a".repeat(20_000) } });
    const res = await POST(post(big));
    expect(res.status).toBe(413);
  });

  it("answers 413 from a lying content-length before reading a byte", async () => {
    const res = await POST(post({ callId: "c5", name: "search_my_material" }, { "content-length": "999999" }));
    expect(res.status).toBe(413);
  });

  it("accepts a normal body", async () => {
    const res = await POST(post({ callId: "c6", name: "search_my_material", arguments: { query: "attention" } }));
    expect(res.status).toBe(200);
  });
});

describe("what the browser is told when a tool throws", () => {
  it("carries no exception text", async () => {
    store.getCourseChunks.mockRejectedValueOnce(new Error("ECONNREFUSED 10.1.2.3:5432 password=hunter2"));
    const res = await POST(post({ callId: "c7", name: "search_my_material", arguments: { query: "attention" } }));
    const text = await res.text();
    expect(text).not.toMatch(/ECONNREFUSED|hunter2|10\.1\.2\.3/);
  });
});
