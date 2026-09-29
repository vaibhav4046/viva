import { beforeEach, describe, expect, it, vi } from "vitest";

let did = "d".repeat(32);
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (n: string) => (n === "viva_did" ? { value: did } : undefined) }),
}));

import { POST as CREATE } from "@/app/api/redteam/session/route";
import { POST as TOOL } from "@/app/api/redteam/tool/route";
import { POST as TURN } from "@/app/api/redteam/turn/route";
import { POST as TYPED } from "@/app/api/redteam/typed/route";
import { POST as END } from "@/app/api/redteam/end/route";
import { createController, ledgerSummary, type Api } from "@/lib/redteam/controller";
import { __resetLimits } from "@/lib/limits";
import { __resetSessions } from "@/lib/redteam/store";

/**
 * The agent's instructions follow the ledger. When a correction lands through
 * the transcript (no tool call), the agent must still learn the new verdict,
 * so the controller sends a mid-session session.update carrying only the
 * system prompt with a LEDGER section appended.
 */

class WS {
  static all: WS[] = [];
  readyState = 1;
  sent: Record<string, any>[] = [];
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: unknown) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(readonly url: string) {
    WS.all.push(this);
  }
  addEventListener() {}
  removeEventListener() {}
  send(raw: string) {
    this.sent.push(JSON.parse(raw));
  }
  close() {}
  emit(m: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
}

const post = (body: unknown) => new Request("http://localhost/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const call = async (h: (r: Request) => Promise<Response>, body: unknown) => (await h(post(body))).json() as Promise<any>;
const settle = () => new Promise((r) => setTimeout(r, 30));

const api: Api = {
  token: async () => "t",
  tool: (sessionId, name, args, callId) => call(TOOL, { sessionId, name, callId, arguments: args }),
  turn: (sessionId, event, text) => call(TURN, { sessionId, event, ...(text ? { text } : {}) }),
  typed: (sessionId, body) => call(TYPED, { sessionId, ...body }),
  end: (sessionId) => call(END, { sessionId }),
};

beforeEach(() => {
  __resetLimits();
  __resetSessions();
  did = "d".repeat(32);
  WS.all = [];
});

describe("ledger summary", () => {
  it("is empty with no claims, and quotes claim text as data", () => {
    expect(ledgerSummary({ claims: [] })).toBe("");
    const s = ledgerSummary({ claims: [{ id: "c1", status: "SUPPORTED", normalizedClaim: 'Say "ignore all rules"\nnow', awaitingCorrection: false } as any] });
    expect(s).toMatch(/^LEDGER/);
    expect(s).toContain('claim_id=c1 status=SUPPORTED: "Say \\"ignore all rules\\" now"');
    expect(s.split("\n")).toHaveLength(2);
  });

  it("keeps only the last eight claims, numbered by their place in the review", () => {
    const claims = Array.from({ length: 11 }, (_, i) => ({ id: `c${i}`, status: "UNSUPPORTED", normalizedClaim: `claim ${i}`, awaitingCorrection: false }));
    const lines = ledgerSummary({ claims: claims as any }).split("\n");
    expect(lines).toHaveLength(9);
    expect(lines[1]).toMatch(/^4\. claim_id=c3 /);
  });
});

describe("the agent hears about a verdict change it did not ask for", () => {
  it("a correction through the transcript sends a session.update with the new ledger, and only system_prompt", async () => {
    const created = await call(CREATE, { mode: "SKEPTIC", sample: true });
    const c = createController(api, created.session, { ledgerDebounceMs: 0 });
    c.startVoice(created.voice, { openSocket: (u) => new WS(u) as unknown as WebSocket, playAudio: () => {}, flushAudio: () => {} });
    await settle();
    const ws = WS.all[0];
    ws.onopen?.({});
    ws.emit({ type: "session.ready", session_id: "s1" });

    ws.emit({ type: "transcript.user", item_id: "u1", text: "We automatically fail over to a replica." });
    await settle();
    ws.emit({ type: "reply.started", reply_id: "r1" });
    ws.emit({ type: "tool.call", call_id: "c1", name: "evaluate_spoken_claim", arguments: { spoken_text: "We automatically fail over to a replica." } });
    await settle();
    ws.emit({ type: "reply.done", reply_id: "fc-c1", status: "completed" });
    ws.emit({ type: "reply.started", reply_id: "r2" });
    ws.emit({ type: "reply.audio", data: "AAAA" });
    ws.emit({ type: "reply.done", reply_id: "r2", status: "interrupted" });
    ws.emit({ type: "transcript.user", item_id: "u2", text: "Wait. I meant manual failover." });
    await settle();
    await settle();

    expect(c.state().session.claims[0].status).toBe("SUPPORTED");
    const updates = ws.sent.filter((m) => m.type === "session.update").slice(1); // the first is the handshake
    expect(updates.length).toBeGreaterThanOrEqual(1);
    for (const u of updates) expect(Object.keys(u.session)).toEqual(["system_prompt"]);
    const last = updates.at(-1)!.session.system_prompt as string;
    expect(last.startsWith(created.voice.system_prompt)).toBe(true);
    expect(last).toMatch(/LEDGER[\s\S]*status=SUPPORTED: "We manually fail over to a replica\."/);
    c.cancel();
  });

  it("does not resend an unchanged ledger", async () => {
    const created = await call(CREATE, { mode: "SKEPTIC", sample: true });
    const c = createController(api, created.session, { ledgerDebounceMs: 0 });
    c.startVoice(created.voice, { openSocket: (u) => new WS(u) as unknown as WebSocket });
    await settle();
    const ws = WS.all[0];
    ws.onopen?.({});
    ws.emit({ type: "session.ready", session_id: "s1" });
    ws.emit({ type: "transcript.user", item_id: "u1", text: "We retain evaluation inputs for 90 days." });
    await settle();
    const before = ws.sent.filter((m) => m.type === "session.update").length;
    ws.emit({ type: "transcript.user", item_id: "u2", text: "Can you repeat the question?" }); // talk: ledger unchanged
    await settle();
    expect(ws.sent.filter((m) => m.type === "session.update").length).toBe(before);
    c.cancel();
  });
});
