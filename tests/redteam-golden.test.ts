import { beforeEach, describe, expect, it, vi } from "vitest";

let did = "c".repeat(32);
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (n: string) => (n === "viva_did" ? { value: did } : undefined) }),
}));

import { POST as CREATE } from "@/app/api/redteam/session/route";
import { POST as TOOL } from "@/app/api/redteam/tool/route";
import { POST as TURN } from "@/app/api/redteam/turn/route";
import { POST as TYPED } from "@/app/api/redteam/typed/route";
import { POST as END } from "@/app/api/redteam/end/route";
import { createController, type Api, type Controller, type VoiceConfig } from "@/lib/redteam/controller";
import { __resetLimits } from "@/lib/limits";
import { __resetSessions } from "@/lib/redteam/store";

/**
 * THE GOLDEN FLOW, end to end, without a browser or a microphone.
 *
 * Real: the Voice Agent socket client, the state machine, the controller, the
 * route handlers, the claim engine and the ledger.
 * Fake: only the WebSocket, driven with the protocol events the service is
 * documented to send. This proves what VIVA does with those events. It does
 * not prove the service sends them; that is what the live run is for.
 */

class FakeWS {
  static all: FakeWS[] = [];
  readyState = 1;
  sent: Record<string, any>[] = [];
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: unknown) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  private l: Record<string, ((e: unknown) => void)[]> = {};
  constructor(readonly url: string) {
    FakeWS.all.push(this);
  }
  addEventListener(t: string, f: (e: unknown) => void) {
    (this.l[t] ??= []).push(f);
  }
  removeEventListener() {}
  send(raw: string) {
    const m = JSON.parse(raw);
    this.sent.push(m);
    if (m.type === "session.end") {
      queueMicrotask(() => {
        this.emit({ type: "session.ended" });
        this.close();
      });
    }
  }
  close() {
    this.fire("close", { code: 1000 });
  }
  fire(t: string, e: unknown) {
    for (const f of this.l[t] ?? []) f(e);
    const h = (this as any)[t === "message" ? "onmessage" : `on${t}`];
    if (typeof h === "function") h(e);
  }
  emit(m: Record<string, unknown>) {
    this.fire("message", { data: JSON.stringify(m) });
  }
  of(t: string) {
    return this.sent.filter((s) => s.type === t);
  }
}

const post = (body: unknown) => new Request("http://localhost/api/redteam/x", { method: "POST", headers: { "Content-Type": "application/json", "x-forwarded-for": "7.7.7.7" }, body: JSON.stringify(body) });
const call = async (h: (r: Request) => Promise<Response>, body: unknown) => {
  const res = await h(post(body));
  return (await res.json()) as any;
};
const settle = () => new Promise((r) => setTimeout(r, 25));

function api(): Api {
  return {
    token: async () => "short-lived-token",
    tool: (sessionId, name, args, callId) => call(TOOL, { sessionId, name, callId, arguments: args }),
    turn: (sessionId, event, text) => call(TURN, { sessionId, event, ...(text ? { text } : {}) }),
    typed: (sessionId, body) => call(TYPED, { sessionId, ...body }),
    end: (sessionId) => call(END, { sessionId }),
  };
}

async function boot(): Promise<{ c: Controller; ws: FakeWS; voice: VoiceConfig; flush: ReturnType<typeof vi.fn>; play: ReturnType<typeof vi.fn> }> {
  FakeWS.all = [];
  const created = await call(CREATE, { mode: "SKEPTIC", sample: true });
  const flush = vi.fn();
  const play = vi.fn();
  const c = createController(api(), created.session);
  c.startVoice(created.voice, { openSocket: (u) => new FakeWS(u) as unknown as WebSocket, playAudio: play, flushAudio: flush });
  await settle();
  const ws = FakeWS.all[0];
  ws.fire("open", {});
  ws.emit({ type: "session.ready", session_id: "sess_1", resume_token: "rt" });
  return { c, ws, voice: created.voice, flush, play };
}

const say = (ws: FakeWS, text: string, id = "u1") => {
  ws.emit({ type: "input.speech.started" });
  ws.emit({ type: "transcript.user.delta", item_id: id, text: text.slice(0, 12) });
  ws.emit({ type: "transcript.user.delta", item_id: id, text });
  ws.emit({ type: "input.speech.stopped" });
  ws.emit({ type: "transcript.user", item_id: id, text });
};

beforeEach(() => {
  __resetLimits();
  __resetSessions();
  did = "c".repeat(32);
});

describe("golden flow: contradiction, barge-in, correction, verdict change", () => {
  it("runs the whole thing and the map moves CONTRADICTED -> SUPPORTED", async () => {
    const { c, ws, voice, flush, play } = await boot();

    // Session.update went out first, with the tools, hold mode, no key.
    const update = ws.of("session.update")[0];
    expect(update.session.greeting).toMatch(/primary Postgres/i);
    expect(update.session.tools).toHaveLength(6);
    expect(JSON.stringify(update)).not.toMatch(/api[_-]?key/i);
    expect(ws.url).toBe("wss://agents.assemblyai.com/v1/ws?token=short-lived-token");
    expect(c.state().machine?.state).toBe("LISTENING");

    // The greeting is the first challenge, spoken by the service.
    ws.emit({ type: "reply.started", reply_id: "r0" });
    ws.emit({ type: "reply.audio", data: "AAAA" });
    expect(c.state().machine?.state).toBe("SPEAKING");
    ws.emit({ type: "reply.done", reply_id: "r0", status: "completed" });
    expect(c.state().machine?.state).toBe("LISTENING");
    expect(play).toHaveBeenCalled();

    // 1. The user makes a claim.
    say(ws, "We automatically fail over to a replica.");
    expect(c.state().machine?.state).toBe("THINKING");
    expect(c.state().transcript.at(-1)).toMatchObject({ speaker: "user" });

    // 2. The agent checks the source. tool.result must wait for reply.done.
    ws.emit({ type: "reply.started", reply_id: "r1" });
    ws.emit({ type: "tool.call", call_id: "call_1", name: "evaluate_spoken_claim", arguments: { spoken_text: "We automatically fail over to a replica." } });
    expect(c.state().machine?.state).toBe("CHECKING_SOURCE");
    expect(ws.of("tool.result")).toHaveLength(0);
    await settle();
    expect(ws.of("tool.result")).toHaveLength(0); // computed, but still not sent
    const claim = c.state().session.claims[0];
    expect(claim.status).toBe("CONTRADICTED"); // the map already knows
    expect(claim.contradictionPassageIds.length).toBeGreaterThan(0);

    ws.emit({ type: "reply.done", reply_id: "fc-call_1", status: "completed" });
    const sent = ws.of("tool.result");
    expect(sent).toHaveLength(1);
    expect(sent[0].call_id).toBe("call_1");
    expect(JSON.parse(sent[0].result).status).toBe("CONTRADICTED");
    expect(c.state().machine?.state).toBe("THINKING"); // composing the spoken answer

    // 3. The agent starts explaining why.
    ws.emit({ type: "reply.started", reply_id: "r2" });
    ws.emit({ type: "reply.audio", data: "BBBB" });
    expect(c.state().machine?.state).toBe("SPEAKING");

    // 4. THE USER INTERRUPTS. Speech starts, then the service cuts the reply.
    ws.emit({ type: "input.speech.started" });
    expect(c.state().machine?.state).toBe("USER_SPEAKING");
    flush.mockClear();
    ws.emit({ type: "reply.done", reply_id: "r2", status: "interrupted" });
    ws.emit({ type: "transcript.agent", text: "Your document says automatic replica fail", interrupted: true });
    expect(flush).toHaveBeenCalledTimes(1); // agent speech stops NOW, locally
    expect(c.state().machine?.interruptions).toBe(1);
    expect(c.state().transcript.at(-1)).toMatchObject({ speaker: "agent", interrupted: true });
    await settle();
    expect(c.state().interruptedClaimId).toBe(claim.id);
    expect(c.state().session.claims[0].awaitingCorrection).toBe(true);
    expect(c.state().session.timeline.some((t) => t.kind === "interruption")).toBe(true);

    // 5. The correction. The ledger moves on the transcript alone.
    ws.emit({ type: "transcript.user.delta", item_id: "u2", text: "Wait. I meant" });
    say(ws, "Wait. I meant manual failover.", "u2");
    await settle();
    const after = c.state().session.claims[0];
    expect(after.status).toBe("SUPPORTED");
    expect(after.evidencePassageIds.length).toBeGreaterThan(0);
    expect(c.state().session.claims).toHaveLength(1);
    expect(c.state().lastChange).toMatchObject({ claimId: claim.id, from: "CONTRADICTED", to: "SUPPORTED", cause: "correction" });
    expect(c.state().interruptedClaimId).toBeNull();

    // 6. The agent's own tool call then agrees, and nothing double-counts.
    ws.emit({ type: "reply.started", reply_id: "r3" });
    ws.emit({ type: "tool.call", call_id: "call_2", name: "reevaluate_claim", arguments: { claim_id: claim.id, corrected_text: "manual failover" } });
    await settle();
    ws.emit({ type: "reply.done", reply_id: "fc-call_2", status: "completed" });
    expect(JSON.parse(ws.of("tool.result")[1].result).status).toBe("SUPPORTED");
    expect(c.state().session.claims[0].revisions.map((r) => r.status)).toEqual(["CONTRADICTED", "SUPPORTED"]);

    // 7. Later, an unsupported guarantee.
    say(ws, "We guarantee GDPR compliance and SOC 2 certification for all customer data.", "u3");
    ws.emit({ type: "reply.started", reply_id: "r4" });
    ws.emit({ type: "tool.call", call_id: "call_3", name: "evaluate_spoken_claim", arguments: { spoken_text: "We guarantee GDPR compliance and SOC 2 certification for all customer data." } });
    await settle();
    ws.emit({ type: "reply.done", reply_id: "fc-call_3", status: "completed" });
    const third = JSON.parse(ws.of("tool.result")[2].result);
    expect(third.status).toBe("UNSUPPORTED");
    expect(third.say).toContain("I can't find that in the supplied material");

    // 8. Finish: the agent calls the tool and the report is built.
    ws.emit({ type: "reply.started", reply_id: "r5" });
    ws.emit({ type: "tool.call", call_id: "call_4", name: "finish_redteam_session", arguments: {} });
    await settle();
    ws.emit({ type: "reply.done", reply_id: "fc-call_4", status: "completed" });
    await settle();
    const report = c.state().report!;
    expect(report.held.map((h) => h.claim)).toEqual([expect.stringMatching(/manually fail over/i)]);
    expect(report.held[0].correctedFrom?.status).toBe("CONTRADICTED");
    expect(report.unsupported).toHaveLength(1);
    expect(report.counts.interruptions).toBe(1);
    void voice;
  });

  it("a tool result computed for a reply the user interrupted is never sent", async () => {
    const { c, ws } = await boot();
    say(ws, "We keep data for 90 days.");
    ws.emit({ type: "reply.started", reply_id: "r1" });
    ws.emit({ type: "tool.call", call_id: "call_x", name: "evaluate_spoken_claim", arguments: { spoken_text: "We keep data for 90 days." } });
    await settle();
    ws.emit({ type: "input.speech.started" });
    ws.emit({ type: "reply.done", reply_id: "fc-call_x", status: "interrupted" });
    expect(ws.of("tool.result")).toHaveLength(0);
    expect(c.state().machine?.pending).toEqual([]);
    expect(c.state().machine?.ready).toEqual([]);
    expect(c.state().machine?.discards).toBeGreaterThanOrEqual(1);
    // The ledger still shows what the document said; only the agent never heard it.
    expect(c.state().session.claims[0].status).toBe("SUPPORTED");
    // And the next turn's result is not contaminated by the discarded one.
    say(ws, "We keep data for 30 days.", "u2");
    ws.emit({ type: "reply.started", reply_id: "r2" });
    ws.emit({ type: "tool.call", call_id: "call_y", name: "evaluate_spoken_claim", arguments: { spoken_text: "We keep data for 30 days." } });
    await settle();
    ws.emit({ type: "reply.done", reply_id: "fc-call_y", status: "completed" });
    const out = ws.of("tool.result");
    expect(out.map((o) => o.call_id)).toEqual(["call_y"]);
  });

  it("if the model never calls a tool after an interruption, the correction still lands", async () => {
    const { c, ws } = await boot();
    say(ws, "We automatically fail over to a replica.");
    ws.emit({ type: "reply.started", reply_id: "r1" });
    ws.emit({ type: "tool.call", call_id: "c1", name: "evaluate_spoken_claim", arguments: { spoken_text: "We automatically fail over to a replica." } });
    await settle();
    ws.emit({ type: "reply.done", reply_id: "fc-c1", status: "completed" });
    ws.emit({ type: "reply.started", reply_id: "r2" });
    ws.emit({ type: "reply.audio", data: "AAAA" });
    ws.emit({ type: "reply.done", reply_id: "r2", status: "interrupted" });
    say(ws, "Sorry, I meant manual failover.", "u2");
    await settle();
    expect(c.state().session.claims[0].status).toBe("SUPPORTED");
    expect(ws.of("tool.call")).toHaveLength(0);
  });

  it("the map fills from the transcript alone, and the agent's tool call does not double it", async () => {
    const { c, ws } = await boot();
    say(ws, "We automatically fail over to a replica.");
    await settle();
    expect(c.state().session.claims).toHaveLength(1);
    expect(c.state().session.claims[0].status).toBe("CONTRADICTED");
    expect(ws.of("tool.call")).toHaveLength(0);

    say(ws, "Can you repeat the question?", "u2");
    await settle();
    expect(c.state().session.claims).toHaveLength(1); // talk is not a claim

    ws.emit({ type: "reply.started", reply_id: "r1" });
    ws.emit({ type: "tool.call", call_id: "c1", name: "evaluate_spoken_claim", arguments: { spoken_text: "We automatically fail over to a replica." } });
    await settle();
    ws.emit({ type: "reply.done", reply_id: "fc-c1", status: "completed" });
    expect(JSON.parse(ws.of("tool.result")[0].result).status).toBe("CONTRADICTED");
    expect(c.state().session.claims).toHaveLength(1);
  });

  it("an out-of-order pair of events (transcript before interruption marker) cannot drop the correction", async () => {
    const { c, ws } = await boot();
    say(ws, "We automatically fail over to a replica.");
    ws.emit({ type: "reply.started", reply_id: "r1" });
    ws.emit({ type: "tool.call", call_id: "c1", name: "evaluate_spoken_claim", arguments: { spoken_text: "We automatically fail over to a replica." } });
    await settle();
    ws.emit({ type: "reply.done", reply_id: "fc-c1", status: "completed" });
    ws.emit({ type: "reply.started", reply_id: "r2" });
    ws.emit({ type: "reply.audio", data: "AAAA" });
    // Both events arrive back to back; the controller keeps their order.
    ws.emit({ type: "reply.done", reply_id: "r2", status: "interrupted" });
    say(ws, "Wait. I meant manual failover.", "u2");
    await settle();
    expect(c.state().session.claims[0].status).toBe("SUPPORTED");
  });

  it("typed mode is labelled and reaches the same verdicts", async () => {
    const created = await call(CREATE, { mode: "SKEPTIC", sample: true });
    const c = createController(api(), created.session);
    await c.typed("We automatically fail over to a replica.");
    expect(c.state().mode).toBe("typed");
    expect(c.state().session.claims[0].status).toBe("CONTRADICTED");
    await c.typedInterrupt();
    expect(c.state().interruptedClaimId).toBe(c.state().session.claims[0].id);
    await c.typed("Wait. I meant manual failover.");
    expect(c.state().session.claims[0].status).toBe("SUPPORTED");
    expect(c.state().lastChange).toMatchObject({ from: "CONTRADICTED", to: "SUPPORTED" });
    await c.end();
    expect(c.state().report?.held).toHaveLength(1);
  });
});
