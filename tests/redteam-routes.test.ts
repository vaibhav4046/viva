import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let did = "a".repeat(32);
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (n: string) => (n === "viva_did" ? { value: did } : undefined) }),
}));

import { POST as CREATE } from "@/app/api/redteam/session/route";
import { GET as SNAPSHOT, DELETE as FORGET } from "@/app/api/redteam/session/[id]/route";
import { POST as TOOL } from "@/app/api/redteam/tool/route";
import { POST as TURN } from "@/app/api/redteam/turn/route";
import { POST as TYPED } from "@/app/api/redteam/typed/route";
import { POST as END } from "@/app/api/redteam/end/route";
import { GET as REPORT } from "@/app/api/redteam/report/[id]/route";
import { GET as TOKEN } from "@/app/api/voice-agent/token/route";
import { __resetLimits } from "@/lib/limits";
import { __resetSessions } from "@/lib/redteam/store";

const json = (body: unknown, url = "http://localhost/api/redteam/x") =>
  new Request(url, { method: "POST", headers: { "Content-Type": "application/json", "x-forwarded-for": "9.9.9.9" }, body: JSON.stringify(body) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const get = (url: string) => new Request(url, { headers: { "x-forwarded-for": "9.9.9.9" } });

const SECRET = "sk-permanent-assemblyai-key-DO-NOT-LEAK";
const savedEnv = { ...process.env };
const savedFetch = globalThis.fetch;

async function start(mode = "SKEPTIC") {
  const res = await CREATE(json({ mode, sample: true }));
  expect(res.status).toBe(201);
  return (await res.json()) as { session: { id: string; claims: any[]; timeline: any[]; document: { sample: boolean } }; voice: any };
}

beforeEach(() => {
  __resetLimits();
  __resetSessions();
  did = "a".repeat(32);
  process.env.ASSEMBLYAI_API_KEY = SECRET;
});
afterEach(() => {
  process.env = { ...savedEnv };
  globalThis.fetch = savedFetch;
});

describe("the permanent AssemblyAI key never reaches the browser", () => {
  it("is absent from every RedTeam response, including the voice config", async () => {
    const { session, voice } = await start();
    const bodies = [
      JSON.stringify({ session, voice }),
      await (await SNAPSHOT(get("http://x"), ctx(session.id))).text(),
      await (await TOOL(json({ sessionId: session.id, name: "retrieve_source", arguments: { query: "primary" } }))).text(),
      await (await END(json({ sessionId: session.id }))).text(),
    ];
    for (const b of bodies) expect(b).not.toContain(SECRET);
    expect(JSON.stringify(voice)).not.toMatch(/api[_-]?key|authorization|bearer/i);
  });

  it("token route sends the key upstream only, and returns only the short-lived token", async () => {
    const calls: { url: string; auth: string | null }[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({ token: "temp-token-abc", expires_in_seconds: 600 }), { status: 200 });
    }) as typeof fetch;
    const res = await TOKEN(get("http://localhost/api/voice-agent/token"));
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ token: "temp-token-abc", expiresInSeconds: 600 });
    expect(text).not.toContain(SECRET);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://agents.assemblyai.com/v1/token?expires_in_seconds=600");
    expect(calls[0].auth).toBe(SECRET);
  });

  it("token route without a server key answers with a plain non-retryable error and no upstream call", async () => {
    delete process.env.ASSEMBLYAI_API_KEY;
    globalThis.fetch = (async () => {
      throw new Error("must not be called");
    }) as typeof fetch;
    const res = await TOKEN(get("http://localhost/api/voice-agent/token"));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.retryable).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/assemblyai|401|403|stack/i);
  });

  it("an upstream failure (auth, 422, outage) never leaks its body", async () => {
    for (const status of [401, 422, 500]) {
      globalThis.fetch = (async () => new Response(`secret upstream detail ${SECRET}`, { status })) as typeof fetch;
      __resetLimits();
      const res = await TOKEN(get("http://localhost/api/voice-agent/token"));
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await res.text()).not.toMatch(/secret upstream detail|sk-permanent/);
    }
  });

  it("a token response with no token is refused, not passed on", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ nope: 1 }), { status: 200 })) as typeof fetch;
    expect((await TOKEN(get("http://localhost/api/voice-agent/token"))).status).toBe(502);
  });
});

describe("session lifecycle over HTTP", () => {
  it("creates a labelled sample review with an opening challenge and a voice config", async () => {
    const { session, voice } = await start();
    expect(session.document.sample).toBe(true);
    expect(session.timeline[0].kind).toBe("challenge");
    expect(voice.greeting).toMatch(/primary Postgres/i);
    expect(voice.tools.map((t: any) => t.name)).toHaveLength(6);
    expect(voice.tools.every((t: any) => t.execution_mode === "hold")).toBe(true);
    expect(voice.system_prompt).not.toContain("Automatic replica failover is not configured");
  });

  it("accepts the user's own document, and refuses one that is too short or too long", async () => {
    const ok = await CREATE(json({ mode: "ARCHITECT", title: "Mine", text: "The cache holds ten items. The cache evicts the oldest item first." }));
    expect(ok.status).toBe(201);
    expect((await CREATE(json({ text: "x", title: "t", sample: false }))).status).toBe(400);
    expect((await CREATE(json({ text: "y".repeat(70_000), title: "t" }))).status).toBe(400);
    expect((await CREATE(json({ mode: "NOPE", sample: true }))).status).toBe(400);
    expect((await CREATE(json({ sample: true, admin: true }))).status).toBe(400); // strict
  });

  it("runs the golden flow through the tool, turn and report routes", async () => {
    const { session } = await start();
    const id = session.id;

    const a = await (await TOOL(json({ sessionId: id, callId: "c1", name: "evaluate_spoken_claim", arguments: { spoken_text: "We automatically fail over to a replica." } }))).json();
    expect(a.result.status).toBe("CONTRADICTED");
    expect(a.session.claims[0].status).toBe("CONTRADICTED");

    const cut = await (await TURN(json({ sessionId: id, event: "interrupted" }))).json();
    expect(cut.session.claims[0].awaitingCorrection).toBe(true);

    // The browser reports the finished transcript; the ledger moves without the model.
    const fix = await (await TURN(json({ sessionId: id, event: "user_final", text: "Wait. I meant manual failover." }))).json();
    expect(fix.changed).toBe(true);
    expect(fix.statusBefore).toBe("CONTRADICTED");
    expect(fix.session.claims[0].status).toBe("SUPPORTED");
    expect(fix.session.claims).toHaveLength(1);

    // The agent's own tool call afterwards agrees and does not double-count.
    const again = await (await TOOL(json({ sessionId: id, name: "reevaluate_claim", arguments: { claim_id: a.result.claim_id, corrected_text: "manual failover" } }))).json();
    expect(again.result.status).toBe("SUPPORTED");
    expect(again.session.claims[0].revisions).toHaveLength(2);

    const u = await (await TOOL(json({ sessionId: id, name: "evaluate_spoken_claim", arguments: { spoken_text: "We guarantee GDPR compliance and SOC 2 certification for all customer data." } }))).json();
    expect(u.result.status).toBe("UNSUPPORTED");

    const ended = await (await END(json({ sessionId: id }))).json();
    expect(ended.report.held).toHaveLength(1);
    expect(ended.report.unsupported).toHaveLength(1);
    expect(ended.report.counts.corrections).toBe(1);
    const again2 = await (await REPORT(get("http://x"), ctx(id))).json();
    expect(again2.ended).toBe(true);
    expect((await TOOL(json({ sessionId: id, name: "retrieve_source", arguments: { query: "x" } }))).status).toBe(200);
  });

  it("a non-correction transcript after an interruption does not touch the ledger", async () => {
    const { session } = await start();
    await TOOL(json({ sessionId: session.id, name: "evaluate_spoken_claim", arguments: { spoken_text: "We automatically fail over to a replica." } }));
    await TURN(json({ sessionId: session.id, event: "interrupted" }));
    const r = await (await TURN(json({ sessionId: session.id, event: "user_final", text: "Can you repeat that please?" }))).json();
    expect(r.changed).toBe(false);
    expect(r.session.claims[0].status).toBe("CONTRADICTED");
  });

  it("typed mode goes through the same ledger, including the interrupt-and-correct move", async () => {
    const { session } = await start();
    const a = await (await TYPED(json({ sessionId: session.id, text: "We automatically fail over to a replica." }))).json();
    expect(a.session.claims[0].status).toBe("CONTRADICTED");
    await TYPED(json({ sessionId: session.id, interrupt: true }));
    const b = await (await TYPED(json({ sessionId: session.id, text: "Wait. I meant manual failover." }))).json();
    expect(b.corrected).toBe(true);
    expect(b.previousStatus).toBe("CONTRADICTED");
    expect(b.session.claims[0].status).toBe("SUPPORTED");
  });

  it("a reload restores the ledger and speaks a resume line, not the opening again", async () => {
    const { session, voice } = await start();
    await TOOL(json({ sessionId: session.id, name: "evaluate_spoken_claim", arguments: { spoken_text: "We manually fail over to a replica." } }));
    const back = await (await SNAPSHOT(get("http://x"), ctx(session.id))).json();
    expect(back.session.claims).toHaveLength(1);
    expect(back.voice.greeting).toMatch(/^Picking up where we left off/);
    expect(back.voice.greeting).not.toBe(voice.greeting);
  });
});

describe("ownership", () => {
  it("another browser gets the same 404 as a session that never existed, on every route", async () => {
    const { session } = await start();
    did = "b".repeat(32);
    const responses = await Promise.all([
      SNAPSHOT(get("http://x"), ctx(session.id)),
      REPORT(get("http://x"), ctx(session.id)),
      FORGET(get("http://x"), ctx(session.id)),
      TOOL(json({ sessionId: session.id, name: "retrieve_source", arguments: { query: "primary" } })),
      TURN(json({ sessionId: session.id, event: "interrupted" })),
      TYPED(json({ sessionId: session.id, text: "hello there friend" })),
      END(json({ sessionId: session.id })),
    ]);
    const ghost = await SNAPSHOT(get("http://x"), ctx("00000000-0000-0000-0000-000000000000"));
    for (const r of responses) {
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual(await ghost.clone().json());
    }
    did = "a".repeat(32);
    const still = await (await SNAPSHOT(get("http://x"), ctx(session.id))).json();
    expect(still.session.status).toBe("active");
  });
});

describe("hostile input", () => {
  it("malformed JSON, oversized bodies and unknown fields are refused cleanly", async () => {
    const { session } = await start();
    const bad = new Request("http://x", { method: "POST", body: "{not json" });
    expect((await TOOL(bad)).status).toBe(400);
    expect((await TOOL(json({ sessionId: session.id, name: "retrieve_source", arguments: {}, extra: 1 }))).status).toBe(400);
    expect((await TOOL(json({ sessionId: session.id, name: "x".repeat(20_000) }))).status).toBe(400);
    const huge = await TOOL(json({ sessionId: session.id, name: "retrieve_source", arguments: { query: "y".repeat(120_000) } }));
    expect(huge.status).toBe(413);
  });

  it("an unknown tool is an error result, not a crash or a 500", async () => {
    const { session } = await start();
    const r = await TOOL(json({ sessionId: session.id, name: "constructor", arguments: {} }));
    expect(r.status).toBe(200);
    expect((await r.json()).isError).toBe(true);
  });

  it("starting reviews does not starve the calls inside a review", async () => {
    const { session } = await start();
    for (let i = 0; i < 8; i++) await CREATE(json({ sample: true })); // burns the creation budget
    let refused = 0;
    for (let i = 0; i < 25; i++) {
      const r = await TOOL(json({ sessionId: session.id, name: "retrieve_source", arguments: { query: "primary" } }));
      if (r.status === 429) refused += 1;
    }
    expect(refused).toBe(0);
  });

  it("rate limits a client that hammers a route", async () => {
    let limited = 0;
    for (let i = 0; i < 40; i++) {
      const r = await CREATE(json({ sample: true }));
      if (r.status === 429) limited += 1;
    }
    expect(limited).toBeGreaterThan(0);
  });
});
