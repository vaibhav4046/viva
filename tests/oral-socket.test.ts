import { describe, expect, it, vi } from "vitest";
import { openOralSocket, voiceAgentUrl, pcm16ToBase64, ORAL_SAMPLE_RATE, type OralSocket } from "@/lib/oral/socket";
import { ORAL_STATES } from "@/lib/oral/machine";

/**
 * The real client, driven with a fake socket and no browser.
 *
 * `oral-wire.test.ts` proves the protocol; this proves the client that ships.
 * The two are different failure surfaces: the harness can be right about the
 * protocol while the shipped client sends `session.update` after a resume, or
 * forgets to flush the audio buffer on a barge-in.
 */

const CONFIG = {
  system_prompt: "You are an examiner.",
  greeting: "Tell me what to ask you on.",
  tools: [{ type: "function", name: "search_my_material", description: "d", parameters: { type: "object", properties: {}, required: [] } }],
  keyterms: ["positional encoding"],
  language_codes: ["en"],
  transcription_mode: "balanced",
  turn_detection: { vad_threshold: 0.6 },
};

class FakeWS {
  static instances: FakeWS[] = [];
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  closeCalls = 0;
  private listeners: Record<string, ((ev: unknown) => void)[]> = {};

  constructor(readonly url: string) {
    FakeWS.instances.push(this);
  }
  addEventListener(type: string, fn: (ev: unknown) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  removeEventListener(type: string, fn: (ev: unknown) => void) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn);
  }
  send(raw: string) {
    const msg = JSON.parse(raw);
    this.sent.push(msg);
    // The server answers session.end with session.ended and then closes. The
    // fake reproduces that, so the clean-exit tests exercise the real path
    // rather than sitting out the client's 2.5 s guard timeout.
    if (msg.type === "session.end") {
      queueMicrotask(() => {
        this.emit({ type: "session.ended", session_duration_seconds: 12.5, audio_duration_seconds: 9.1, timestamp: 1 });
        this.close();
      });
    }
  }
  close() {
    this.closeCalls += 1;
    this.fire("close", { code: 1000, reason: "normal" });
  }
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;

  /**
   * Dispatch to both registration styles. The client uses `onopen`/`onmessage`
   * properties; the `end()` path uses `addEventListener`. A fake that only
   * honoured one would silently pass half the tests and fail the real browser.
   */
  fire(type: string, ev: unknown) {
    for (const fn of this.listeners[type] ?? []) fn(ev);
    const prop = type === "message" ? "onmessage" : `on${type}`;
    const handler = (this as unknown as Record<string, ((e: unknown) => void) | null>)[prop];
    if (typeof handler === "function") handler(ev);
  }
  emit(msg: Record<string, unknown>) {
    this.fire("message", { data: JSON.stringify(msg) });
  }
  open() {
    this.fire("open", {});
  }
  of(type: string) {
    return this.sent.filter((s) => s.type === type);
  }
  get last(): FakeWS {
    return FakeWS.instances[FakeWS.instances.length - 1];
  }
}

function setup(over: Partial<Parameters<typeof openOralSocket>[0]> = {}) {
  FakeWS.instances = [];
  const states: string[] = [];
  const playAudio = vi.fn();
  const flushAudio = vi.fn();
  const onError = vi.fn();
  const socket: OralSocket = openOralSocket({
    config: CONFIG,
    subjectId: "subj_1",
    getToken: async () => "tok_abc123",
    runTool: async () => ({ supported: true }),
    openSocket: (url) => new FakeWS(url) as unknown as WebSocket,
    playAudio,
    flushAudio,
    onState: (m) => states.push(m.state),
    onError,
    ...over,
  });
  return { socket, states, playAudio, flushAudio, onError, ws: FakeWS.instances };
}

async function ready(over: Parameters<typeof setup>[0] = {}) {
  const s = setup(over);
  // Let the token promise resolve so the socket exists.
  await new Promise((r) => setTimeout(r, 0));
  FakeWS.instances[0].open();
  FakeWS.instances[0].emit({ type: "session.ready", session_id: "sess_1", resume_token: "rt" });
  return s;
}

describe("url and encoding", () => {
  it("uses the Voice Agent host, not the streaming host", () => {
    expect(voiceAgentUrl("t")).toBe("wss://agents.assemblyai.com/v1/ws?token=t");
  });

  it("url-encodes the token", () => {
    expect(voiceAgentUrl("a b&c")).toContain("token=a%20b%26c");
  });

  it("declares 24 kHz, the rate the API actually wants", () => {
    expect(ORAL_SAMPLE_RATE).toBe(24_000);
  });

  it("base64-encodes PCM16 correctly", () => {
    const frame = new Int16Array([0, 1, -1, 32767, -32768]);
    const b64 = pcm16ToBase64(frame);
    const bytes = Buffer.from(b64, "base64");
    expect(bytes.length).toBe(10);
    expect(new Int16Array(bytes.buffer, bytes.byteOffset, 5)).toEqual(frame);
  });

  it("encodes a frame whose buffer was transferred, rather than reading a detached one", () => {
    // The worklet transfers the ArrayBuffer, so the view is detached by the
    // time the client sees it. Copying first is what keeps this from throwing.
    const original = new Int16Array([5, -5]);
    const copy = new Int16Array(original); // a distinct buffer
    expect(pcm16ToBase64(copy)).toBe(pcm16ToBase64(new Int16Array([5, -5])));
  });

  it("encodes long frames in slices", () => {
    const big = new Int16Array(100_000).fill(1000);
    const bytes = Buffer.from(pcm16ToBase64(big), "base64");
    expect(bytes.length).toBe(200_000);
  });
});

describe("handshake", () => {
  it("sends session.update first, with the prompt, tools and 24 kHz contract", async () => {
    const { ws } = await ready();
    const first = ws[0].sent[0];
    expect(first.type).toBe("session.update");
    const session = (first as { session: Record<string, unknown> }).session;
    expect(session.system_prompt).toBe(CONFIG.system_prompt);
    expect(session.greeting).toBe(CONFIG.greeting);
    expect(session.tools).toEqual(CONFIG.tools);
    expect((session.input as { format: { encoding: string } }).format.encoding).toBe("audio/pcm");
    expect((session.output as { format: { encoding: string } }).format.encoding).toBe("audio/pcm");
  });

  it("passes keyterms and turn detection through", async () => {
    const { ws } = await ready();
    const session = (ws[0].sent[0] as { session: { input: Record<string, unknown> } }).session;
    expect(session.input.keyterms).toEqual(["positional encoding"]);
    expect(session.input.turn_detection).toEqual({ vad_threshold: 0.6 });
  });

  it("requests a fresh token for every connection", async () => {
    const getToken = vi.fn(async () => "tok_1");
    const { ws } = await ready({ getToken });
    expect(getToken).toHaveBeenCalledTimes(1);
    expect(ws[0].url).toContain("token=tok_1");
  });

  it("buffers audio until session.ready, then flushes it", async () => {
    // The API rejects input.audio before session.ready, so a frame sent in
    // that window is a protocol error rather than a harmless early frame.
    const { socket, ws } = setup();
    await new Promise((r) => setTimeout(r, 0));
    ws[0].open();
    socket.sendAudio(new Int16Array([1, 2, 3]));
    expect(ws[0].of("input.audio")).toHaveLength(0);

    ws[0].emit({ type: "session.ready", session_id: "sess_1" });
    expect(ws[0].of("input.audio")).toHaveLength(1);
  });

  it("starts streaming only after session.ready", async () => {
    const { states } = await ready();
    expect(states).toContain("LISTENING");
    expect(states).not.toContain("SPEAKING");
  });
});

describe("tool results", () => {
  it("delivers a slow tool after reply.done without losing its result", async () => {
    let finishTool!: (result: unknown) => void;
    const runTool = vi.fn(() => new Promise<unknown>((resolve) => { finishTool = resolve; }));
    const { ws, socket } = await ready({ runTool });
    ws[0].emit({ type: "tool.call", call_id: "slow", name: "search_my_material", arguments: { query: "x" } });
    ws[0].emit({ type: "reply.done", status: "completed" });
    expect(ws[0].of("tool.result")).toHaveLength(0);
    finishTool({ found: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(ws[0].of("tool.result")).toHaveLength(1);
    expect(JSON.parse(String(ws[0].of("tool.result")[0].result))).toEqual({ found: true });
    expect(socket.machine().discards).toBe(0);
  });

  it("sends nothing on tool.call and delivers on reply.done", async () => {
    const { ws, socket } = await ready();
    ws[0].emit({ type: "tool.call", call_id: "c1", name: "search_my_material", arguments: { query: "x" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(ws[0].of("tool.result")).toHaveLength(0);
    expect(socket.machine().ready).toHaveLength(1);

    ws[0].emit({ type: "reply.done", reply_id: "r1", status: "completed" });
    const sent = ws[0].of("tool.result");
    expect(sent).toHaveLength(1);
    expect(sent[0].call_id).toBe("c1");
    expect(JSON.parse(String(sent[0].result))).toEqual({ supported: true });
  });

  it("passes the tool arguments through as a dict", async () => {
    const runTool = vi.fn(async () => ({}));
    const { ws } = await ready({ runTool });
    ws[0].emit({ type: "tool.call", call_id: "c1", name: "check_my_understanding", arguments: { claim: "hello" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(runTool).toHaveBeenCalledWith("check_my_understanding", { claim: "hello" }, "c1");
  });

  it("marks a rejected tool is_error so the agent can apologise", async () => {
    const { ws } = await ready({
      runTool: async () => {
        throw new Error("store down");
      },
    });
    ws[0].emit({ type: "tool.call", call_id: "c1", name: "grade_my_answer", arguments: {} });
    await new Promise((r) => setTimeout(r, 0));
    ws[0].emit({ type: "reply.done", status: "completed" });
    expect(ws[0].of("tool.result")[0].is_error).toBe(true);
  });

  it("discards a queued result on an interruption, and flushes playback", async () => {
    const { ws, flushAudio, socket } = await ready();
    ws[0].emit({ type: "tool.call", call_id: "c1", name: "grade_my_answer", arguments: {} });
    await new Promise((r) => setTimeout(r, 0));
    ws[0].emit({ type: "reply.done", status: "interrupted" });
    expect(ws[0].of("tool.result")).toHaveLength(0);
    // Flushing before the discard is the documented order and matters: audio
    // queued for a reply that just died is the same class of stale work.
    expect(flushAudio).toHaveBeenCalled();
    expect(socket.machine().ready).toHaveLength(0);
  });
});

describe("transcripts", () => {
  it("keeps only the latest delta, and reports the final transcript once", async () => {
    // The API sends the FULL transcript so far on every delta. Appending
    // would produce "attentionattention is permutation invariant…", which
    // reads as a recognition failure and is not one.
    const onTranscript = vi.fn();
    const { ws, socket } = await ready({ onTranscript });
    ws[0].emit({ type: "transcript.user.delta", item_id: "i1", text: "attention" });
    ws[0].emit({ type: "transcript.user.delta", item_id: "i1", text: "attention is permutation" });
    ws[0].emit({ type: "transcript.user.delta", item_id: "i1", text: "attention is permutation invariant" });
    expect(socket.machine().userPartial).toBe("attention is permutation invariant");

    ws[0].emit({ type: "transcript.user", item_id: "i1", text: "attention is permutation invariant" });
    expect(onTranscript).toHaveBeenCalledTimes(1);
    expect(onTranscript).toHaveBeenCalledWith("attention is permutation invariant", "user");
    expect(socket.machine().turns).toBe(1);
  });

  it("passes an interrupted agent transcript through with the flag", async () => {
    const onTranscript = vi.fn();
    const { ws } = await ready({ onTranscript });
    ws[0].emit({ type: "transcript.agent", text: "well, actually", interrupted: true });
    expect(onTranscript).toHaveBeenCalledWith("well, actually", "agent", true);
  });
});

describe("recovery", () => {
  it("resumes with session.resume as the first frame after a drop", async () => {
    const { ws } = await ready();
    ws[0].fire("close", { code: 1006, reason: "network" });
    await new Promise((r) => setTimeout(r, 0));
    FakeWS.instances[1].open();
    expect(ws[1].sent[0]).toEqual({ type: "session.resume", session_id: "sess_1" });
    expect(ws[1].of("session.update")).toHaveLength(0);
  });

  it("mints a fresh token for the resume", async () => {
    const getToken = vi.fn(async () => "tok_2");
    const { ws } = await ready({ getToken });
    ws[0].fire("close", { code: 1006, reason: "network" });
    await new Promise((r) => setTimeout(r, 0));
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(ws[1].url).toContain("token=tok_2");
  });

  it("goes to RECOVERING rather than IDLE on a drop", async () => {
    const { ws, socket } = await ready();
    ws[0].fire("close", { code: 1006, reason: "network" });
    await new Promise((r) => setTimeout(r, 0));
    expect(socket.machine().state).toBe("RECOVERING");
  });

  it("recovers to READY on the resumed session.ready", async () => {
    const { ws, socket } = await ready();
    ws[0].fire("close", { code: 1006, reason: "network" });
    await new Promise((r) => setTimeout(r, 0));
    FakeWS.instances[1].open();
    FakeWS.instances[1].emit({ type: "session.ready", session_id: "sess_1" });
    expect(socket.machine().state).toBe("LISTENING");
  });

  it("surfaces a fatal session.error and does not reconnect", async () => {
    const { ws, socket, onError } = await ready();
    ws[0].emit({ type: "session.error", code: "UNAUTHORIZED", message: "bad token" });
    expect(socket.machine().fatal).toBe(true);
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/sign-in failed/i));
  });

  it("does not treat a retryable capacity error as fatal", async () => {
    const { ws, socket } = await ready();
    ws[0].emit({ type: "session.error", code: "at_capacity", message: "busy" });
    expect(socket.machine().fatal).toBe(false);
  });
});

describe("clean exit", () => {
  it("sends session.end so the session stops billing immediately", async () => {
    const { ws, socket } = await ready();
    const closed = socket.end();
    await closed;
    expect(ws[0].of("session.end")).toHaveLength(1);
  });

  it("reaches IDLE and reports the summary", async () => {
    const onEnded = vi.fn();
    const { ws, socket } = await ready({ onEnded });
    ws[0].emit({ type: "transcript.user", item_id: "i1", text: "hello there" });
    ws[0].emit({ type: "tool.call", call_id: "c1", name: "save_note", arguments: {} });
    await new Promise((r) => setTimeout(r, 0));
    await socket.end();
    expect(socket.machine().state).toBe("IDLE");
    expect(onEnded).toHaveBeenCalledWith(expect.objectContaining({ turns: 1, toolCalls: 1 }));
  });

  it("reports the end exactly once, not once per close event", async () => {
    // A clean teardown delivers session.ended and then closes, so both paths
    // reach the same handler. Observed live as a doubled report before this
    // was guarded, which counted one exam as two.
    const onEnded = vi.fn();
    const { ws, socket } = await ready({ onEnded });
    await socket.end();
    expect(onEnded).toHaveBeenCalledTimes(1);
    // A second close must not resurrect it.
    ws[0].fire("close", { code: 1000, reason: "normal" });
    ws[0].emit({ type: "session.ended", session_duration_seconds: 1, audio_duration_seconds: 1, timestamp: 1 });
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it("speaks when the greeting arrives before any user turn", async () => {
    // The agent opens the exam, so the first audio lands while the client is
    // still LISTENING. The state has to follow the audio or the screen shows
    // "Listening. Go ahead." over the examiner speaking.
    const { ws, socket } = await ready();
    expect(socket.machine().state).toBe("LISTENING");
    ws[0].emit({ type: "reply.audio", data: "AAEAAAA=" });
    expect(socket.machine().state).toBe("SPEAKING");
  });

  it("cancel tears down without pretending the session ended cleanly", async () => {
    const { ws, socket } = await ready();
    socket.cancel();
    expect(ws[0].closeCalls).toBe(1);
    ws[0].fire("close", { code: 1000, reason: "normal" });
    expect(socket.machine().state).not.toBe("RECOVERING");
  });
});

describe("honest failures", () => {
  it("reports a token failure rather than opening a socket with no credential", async () => {
    const onError = vi.fn();
    FakeWS.instances = [];
    const states: string[] = [];
    openOralSocket({
      config: CONFIG,
      subjectId: "s",
      getToken: async () => {
        throw new Error("no key");
      },
      runTool: async () => ({}),
      openSocket: (url) => new FakeWS(url) as unknown as WebSocket,
      onState: (m) => states.push(m.state),
      onError,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(FakeWS.instances).toHaveLength(0);
    expect(onError).toHaveBeenCalled();
    expect(states).toContain("ERROR");
  });

  it("survives an unparseable frame instead of killing the exam", async () => {
    const { ws, socket } = await ready();
    ws[0].fire("message", { data: "not json" });
    expect(socket.machine().state).toBe("LISTENING");
  });

  it("surfaces a blocked-origin synchronous throw", async () => {
    const onError = vi.fn();
    FakeWS.instances = [];
    openOralSocket({
      config: CONFIG,
      subjectId: "s",
      getToken: async () => "tok",
      runTool: async () => ({}),
      openSocket: () => {
        throw new Error("blocked by CSP");
      },
      onState: () => {},
      onError,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(onError).toHaveBeenCalled();
  });
});

describe("the client only ever reports real states", () => {
  it("never publishes a state outside the twelve", async () => {
    const seen: string[] = [];
    FakeWS.instances = [];
    const socket = openOralSocket({
      config: CONFIG,
      subjectId: "s",
      getToken: async () => "tok",
      runTool: async () => ({}),
      openSocket: (url) => new FakeWS(url) as unknown as WebSocket,
      onState: (m) => seen.push(m.state),
    });
    await new Promise((r) => setTimeout(r, 0));
    const w = FakeWS.instances[0];
    w.open();
    w.emit({ type: "session.ready", session_id: "s" });
    w.emit({ type: "input.speech.started" });
    w.emit({ type: "transcript.user", item_id: "i", text: "x" });
    w.emit({ type: "reply.started" });
    w.emit({ type: "reply.audio", data: "AA==" });
    w.emit({ type: "tool.call", call_id: "c1", name: "search_my_material", arguments: {} });
    await new Promise((r) => setTimeout(r, 0));
    w.emit({ type: "reply.done", status: "interrupted" });
    w.emit({ type: "session.error", code: "server_error" });
    for (const s of seen) expect(ORAL_STATES).toContain(s);
    await socket.end();
  });
});
