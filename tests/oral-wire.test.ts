import { describe, expect, it } from "vitest";
import { harness, WS_URL } from "./oral-harness";

/**
 * End-to-end wire behaviour, without a browser.
 *
 * These are the tests that would have caught the two mistakes most likely in
 * this feature: answering a tool call on `tool.call` instead of on
 * `reply.done`, and delivering a tool result into a reply the student
 * interrupted.
 */

describe("handshake", () => {
  it("sends session.update as the very first frame", () => {
    const h = harness();
    h.connect();
    expect(h.socket.sent[0].type).toBe("session.update");
  });

  it("connects to the documented host and never puts the key in the URL", () => {
    const h = harness();
    h.start();
    expect(h.socket.url).toBe(WS_URL);
    expect(h.socket.url).toBe("wss://agents.assemblyai.com/v1/ws");
    // The key never reaches the browser at all, so it cannot reach a URL.
    expect(h.socket.url).not.toMatch(/api[_-]?key/i);
  });

  it("does not stream audio before session.ready", () => {
    const h = harness();
    h.connect();
    expect(h.socket.of("input.audio")).toHaveLength(0);
    expect(h.state()).toBe("CONNECTING");
  });

  it("starts listening only once session.ready lands", () => {
    const h = harness();
    h.start();
    expect(h.state()).toBe("LISTENING");
    expect(h.machine().sessionId).toBe("sess_live");
  });

  it("sends session.resume first when reconnecting, not session.update", () => {
    const h = harness();
    h.start();
    h.start({ sessionId: "sess_live" });
    expect(h.socket.sent[0]).toEqual({ type: "session.resume", session_id: "sess_live" });
    expect(h.socket.of("session.update")).toHaveLength(0);
  });
});

describe("tool result delivery", () => {
  it("sends NOTHING on tool.call and delivers on reply.done", async () => {
    // The API is explicit: send tool.result when reply.done is the latest
    // event. Replying on tool.call is a protocol error.
    const h = harness({ toolRunner: async () => ({ supported: true }) });
    h.start();
    h.socket.emit({ type: "tool.call", call_id: "c1", name: "check_my_understanding", arguments: { claim: "x" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(h.socket.of("tool.result")).toHaveLength(0);
    expect(h.machine().ready).toHaveLength(1);

    const sent = h.drain("completed");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: "tool.result",
      call_id: "c1",
      result: JSON.stringify({ supported: true }),
      is_error: false,
    });
  });

  it("delivers several results in call order", async () => {
    const h = harness({
      toolRunner: async (name) => ({ from: name }),
    });
    h.start();
    h.socket.emit({ type: "tool.call", call_id: "c1", name: "search_my_material", arguments: {} });
    h.socket.emit({ type: "tool.call", call_id: "c2", name: "quote_my_material", arguments: {} });
    await new Promise((r) => setTimeout(r, 0));
    const sent = h.drain("completed");
    expect(sent.map((s) => s.call_id)).toEqual(["c1", "c2"]);
  });

  it("marks a failed tool is_error so the agent can apologise out loud", async () => {
    const h = harness({
      toolRunner: async () => {
        throw new Error("store down");
      },
    });
    h.start();
    h.socket.emit({ type: "tool.call", call_id: "c1", name: "grade_my_answer", arguments: {} });
    await new Promise((r) => setTimeout(r, 0));
    const sent = h.drain("completed");
    expect(sent[0].is_error).toBe(true);
    expect(JSON.parse(String(sent[0].result)).error).toBeTruthy();
  });
});

describe("interruption", () => {
  it("discards a queued result when the student barges in", async () => {
    const h = harness({ toolRunner: async () => ({ verdict: "incorrect" }) });
    h.start();
    h.socket.emit({ type: "tool.call", call_id: "c1", name: "grade_my_answer", arguments: {} });
    await new Promise((r) => setTimeout(r, 0));
    expect(h.machine().ready).toHaveLength(1);

    const sent = h.drain("interrupted");
    expect(sent).toHaveLength(0);
    expect(h.socket.of("tool.result")).toHaveLength(0);
    expect(h.state()).toBe("INTERRUPTED");
    expect(h.machine().interruptions).toBe(1);
  });

  it("drops a result that resolves after the interruption", async () => {
    // A slow retrieval is the normal case, and its HTTP round trip outlasts
    // the reply it belonged to. That result must not reach the next turn.
    let release: (v: unknown) => void = () => {};
    const h = harness({
      toolRunner: () => new Promise((r) => { release = r; }),
    });
    h.start();
    h.socket.emit({ type: "tool.call", call_id: "c1", name: "check_my_understanding", arguments: {} });
    h.drain("interrupted");
    release({ status: "contradicted" });
    await new Promise((r) => setTimeout(r, 0));
    expect(h.machine().ready).toHaveLength(0);
    expect(h.drain("completed")).toHaveLength(0);
  });

  it("keeps the mic open, because the student is still talking", () => {
    const h = harness();
    h.start();
    h.drain("interrupted");
    expect(h.machine().streaming).toBe(true);
  });
});

describe("session lifecycle", () => {
  it("sends session.end on a clean exit, which stops billing immediately", () => {
    // Just closing the socket holds the session for 30 billable seconds.
    const h = harness();
    h.start();
    h.end();
    expect(h.socket.sent.at(-1)).toEqual({ type: "session.end" });
    expect(h.state()).toBe("ENDED");
  });

  it("clears the session id on end, so it cannot be resumed", () => {
    const h = harness();
    h.start();
    h.end();
    expect(h.machine().sessionId).toBeNull();
  });

  it("goes to RECOVERING on a drop rather than IDLE", () => {
    const h = harness();
    h.start();
    h.socket.serverClose(1006, "network");
    expect(h.state()).toBe("RECOVERING");
    // And it kept the session id, which is what makes the resume possible.
    expect(h.machine().sessionId).toBe("sess_live");
  });

  it("does not treat a clean teardown as a recoverable drop", () => {
    const h = harness();
    h.start();
    h.end();
    h.socket.serverClose(1000, "normal");
    expect(h.state()).toBe("ENDED");
  });

  it("records a session error and keeps the state honest", () => {
    const h = harness();
    h.start();
    h.socket.emit({ type: "session.error", code: "invalid_audio", message: "bad frame" });
    expect(h.state()).toBe("ERROR");
    expect(h.machine().reason).toBe("invalid_audio");
  });
});

describe("log hygiene", () => {
  it("never writes a credential into any frame it sends", async () => {
    const h = harness({ toolRunner: async () => ({ found: true }) });
    h.start();
    h.socket.emit({ type: "tool.call", call_id: "c1", name: "search_my_material", arguments: {} });
    await new Promise((r) => setTimeout(r, 0));
    h.drain("completed");
    const wire = JSON.stringify(h.socket.sent);
    expect(wire).not.toMatch(/[a-f0-9]{40,}/i);
    expect(wire).not.toMatch(/authorization|api[_-]?key|token":\s*"[a-z0-9]{20}/i);
  });
});
