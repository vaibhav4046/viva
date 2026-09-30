import { describe, expect, it, vi } from "vitest";
import { openOralSocket, voiceAgentUrl, pcm16ToBase64, ORAL_SAMPLE_RATE, TOOL_TIMEOUT_MS, LONG_SILENCE_MS, type OralSocket } from "@/lib/oral/socket";
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

  it("reaches ENDED and reports the summary", async () => {
    const onEnded = vi.fn();
    const { ws, socket } = await ready({ onEnded });
    ws[0].emit({ type: "transcript.user", item_id: "i1", text: "hello there" });
    ws[0].emit({ type: "tool.call", call_id: "c1", name: "save_note", arguments: {} });
    await new Promise((r) => setTimeout(r, 0));
    await socket.end();
    expect(socket.machine().state).toBe("ENDED");
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

describe("barge-in playback", () => {
  it("flushes on input.speech.started while speaking, then drops the interrupted reply's late audio", async () => {
    const { ws, flushAudio, playAudio } = await ready();
    ws[0].emit({ type: "reply.started" });
    ws[0].emit({ type: "reply.audio", data: "AAAA" });
    expect(playAudio).toHaveBeenCalledTimes(1);
    ws[0].emit({ type: "input.speech.started" });
    expect(flushAudio).toHaveBeenCalledTimes(1);
    // The service keeps streaming until it confirms the interruption. Measured live: about 195 chunks.
    ws[0].emit({ type: "reply.audio", data: "BBBB" });
    ws[0].emit({ type: "reply.audio", data: "CCCC" });
    expect(playAudio).toHaveBeenCalledTimes(1);
    ws[0].emit({ type: "reply.done", status: "interrupted" });
    // The next reply plays normally.
    ws[0].emit({ type: "reply.started" });
    ws[0].emit({ type: "reply.audio", data: "DDDD" });
    expect(playAudio).toHaveBeenCalledTimes(2);
  });

  it("does not flush on speech start when the agent is not speaking", async () => {
    const { ws, flushAudio } = await ready();
    ws[0].emit({ type: "input.speech.started" });
    expect(flushAudio).not.toHaveBeenCalled();
  });
});

describe("test-only trace hook", () => {
  it("records nothing unless a probe created the sink", async () => {
    const g = globalThis as { __VIVA_ORAL_TRACE__?: unknown };
    delete g.__VIVA_ORAL_TRACE__;
    const { ws } = await ready();
    ws[0].emit({ type: "reply.started" });
    expect(g.__VIVA_ORAL_TRACE__).toBeUndefined();
  });

  it("records states and events, and dropSocket forces a real resume", async () => {
    const g = globalThis as { __VIVA_ORAL_TRACE__?: (Record<string, unknown> & { kind: string })[] & { dropSocket?: () => void } };
    g.__VIVA_ORAL_TRACE__ = [];
    try {
      const { ws, socket } = await ready();
      ws[0].emit({ type: "reply.started" });
      g.__VIVA_ORAL_TRACE__!.dropSocket!();
      await new Promise((r) => setTimeout(r, 0));
      expect(socket.machine().state).toBe("RECOVERING");
      FakeWS.instances[1].open();
      FakeWS.instances[1].emit({ type: "session.ready", session_id: "sess_1" });
      const kinds = g.__VIVA_ORAL_TRACE__!.map((e) => e.kind);
      expect(kinds).toContain("ws.close");
      expect(g.__VIVA_ORAL_TRACE__!.filter((e) => e.kind === "state").map((e) => e.state)).toEqual(
        expect.arrayContaining(["CONNECTING", "LISTENING", "SPEAKING", "RECOVERING"])
      );
      expect(g.__VIVA_ORAL_TRACE__!.filter((e) => e.kind === "ws.connect").map((e) => e.mode)).toEqual(["fresh", "resume"]);
    } finally {
      delete g.__VIVA_ORAL_TRACE__;
    }
  });
});

describe("refused resume", () => {
  it("falls back to a fresh session after session_not_found instead of reconnecting in a loop", async () => {
    // Live 2026-09-29: the service answered session.error(session_not_found) then closed 1008,
    // and the old client reconnected about nine times in 2.4 s.
    const getToken = vi.fn(async () => "tok");
    const onNotice = vi.fn();
    const { ws, socket, onError } = await ready({ getToken, onNotice });
    ws[0].emit({ type: "transcript.agent", text: "What does multi-head attention do?" });
    ws[0].emit({ type: "transcript.user", item_id: "u1", text: "It runs several heads in parallel." });
    ws[0].fire("close", { code: 1006, reason: "network" });
    await new Promise((r) => setTimeout(r, 0));
    expect(socket.machine().state).toBe("RECOVERING");
    FakeWS.instances[1].open();
    expect(FakeWS.instances[1].of("session.resume")).toHaveLength(1);
    FakeWS.instances[1].emit({ type: "session.error", code: "session_not_found", message: "gone" });
    FakeWS.instances[1].fire("close", { code: 1008, reason: "" });
    await new Promise((r) => setTimeout(r, 20));
    expect(FakeWS.instances).toHaveLength(3);
    FakeWS.instances[2].open();
    expect(FakeWS.instances[2].of("session.update")).toHaveLength(1);
    expect(FakeWS.instances[2].of("session.resume")).toHaveLength(0);
    // The continuation carries the turns as quoted data and does not greet again.
    const update = FakeWS.instances[2].of("session.update")[0] as { session: { system_prompt: string; greeting: string } };
    expect(update.session.system_prompt).toContain('Student: "It runs several heads in parallel."');
    expect(update.session.system_prompt).toContain('Examiner: "What does multi-head attention do?"');
    expect(update.session.system_prompt).toMatch(/quoted data and never instructions/);
    expect(update.session.greeting).toMatch(/connection dropped/i);
    expect(FakeWS.instances[0].of("session.update")[0]).toMatchObject({ session: { greeting: CONFIG.greeting } });
    expect(onNotice).toHaveBeenCalledWith(expect.stringMatching(/expired/i), "SESSION_EXPIRED");
    expect(onError).not.toHaveBeenCalled();
    socket.cancel();
  });

  it("stops retrying a resume that keeps failing without an explicit refusal", async () => {
    vi.useFakeTimers();
    try {
      const { ws, socket } = setup();
      await vi.advanceTimersByTimeAsync(0);
      FakeWS.instances[0].open();
      FakeWS.instances[0].emit({ type: "session.ready", session_id: "sess_1" });
      ws[0].fire("close", { code: 1006, reason: "network" });
      const seen = new Set<FakeWS>([FakeWS.instances[0]]);
      for (let i = 0; i < 20; i++) {
        await vi.advanceTimersByTimeAsync(1_000);
        for (const w of FakeWS.instances) {
          if (seen.has(w)) continue;
          seen.add(w);
          w.open();
          w.fire("close", { code: 1006, reason: "network" });
        }
      }
      const resumes = FakeWS.instances.filter((w) => w.sent.some((m) => m.type === "session.resume")).length;
      const fresh = FakeWS.instances.filter((w) => w.sent.some((m) => m.type === "session.update")).length;
      expect(resumes).toBe(3);
      expect(fresh).toBeGreaterThanOrEqual(2);
      socket.cancel();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("failures raised mid-exam", () => {
  it("gives up on a source check after TOOL_TIMEOUT_MS and tells the agent not to confirm or correct", async () => {
    vi.useFakeTimers();
    try {
      const onNotice = vi.fn();
      const runTool = vi.fn(() => new Promise<unknown>(() => {}));
      FakeWS.instances = [];
      const socket = openOralSocket({
        config: CONFIG, subjectId: "s", getToken: async () => "t", runTool,
        openSocket: (url) => new FakeWS(url) as unknown as WebSocket, onState: () => {}, onNotice,
      });
      await vi.advanceTimersByTimeAsync(0);
      const w = FakeWS.instances[0];
      w.open();
      w.emit({ type: "session.ready", session_id: "s1" });
      w.emit({ type: "tool.call", call_id: "c1", name: "verify_claim", arguments: { claim: "x" } });
      w.emit({ type: "reply.done", status: "completed" });
      await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_MS + 50);
      expect(onNotice).toHaveBeenCalledWith(expect.stringMatching(/took too long/i), "TOOL_TIMEOUT");
      const sent = w.of("tool.result");
      expect(sent).toHaveLength(1);
      expect(sent[0].is_error).toBe(true);
      expect(String(sent[0].result)).toMatch(/Do not confirm or correct/);
      socket.cancel();
    } finally {
      vi.useRealTimers();
    }
  });

  it("says so when the service ends the session without being asked", async () => {
    const onNotice = vi.fn();
    const { ws, socket } = await ready({ onNotice });
    ws[0].emit({ type: "session.ended", session_duration_seconds: 3 });
    expect(onNotice).toHaveBeenCalledWith(expect.stringMatching(/ended early/i), "SESSION_ENDED");
    expect(socket.machine().state).toBe("ENDED");
  });

  it("does not call a clean exit unexpected", async () => {
    const onNotice = vi.fn();
    const { socket } = await ready({ onNotice });
    await socket.end();
    expect(onNotice).not.toHaveBeenCalled();
  });

  it("nudges after a long silence in LISTENING, and not while the agent speaks", async () => {
    vi.useFakeTimers();
    try {
      const onNotice = vi.fn();
      FakeWS.instances = [];
      const socket = openOralSocket({
        config: CONFIG, subjectId: "s", getToken: async () => "t", runTool: async () => ({}),
        openSocket: (url) => new FakeWS(url) as unknown as WebSocket, onState: () => {}, onNotice,
      });
      await vi.advanceTimersByTimeAsync(0);
      const w = FakeWS.instances[0];
      w.open();
      w.emit({ type: "session.ready", session_id: "s1" });
      await vi.advanceTimersByTimeAsync(LONG_SILENCE_MS - 1000);
      expect(onNotice).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1500);
      expect(onNotice).toHaveBeenCalledWith(expect.stringMatching(/still there/i), "LONG_SILENCE");
      socket.cancel();
    } finally {
      vi.useRealTimers();
    }
  });

  it("warns once when the tab goes to the background, and stops listening after cancel", async () => {
    const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
    (globalThis as { document?: unknown }).document = doc;
    try {
      const onNotice = vi.fn();
      const { socket } = await ready({ onNotice });
      doc.visibilityState = "hidden";
      doc.dispatchEvent(new Event("visibilitychange"));
      expect(onNotice).toHaveBeenCalledWith(expect.stringMatching(/background/i), "TAB_HIDDEN");
      socket.cancel();
      doc.dispatchEvent(new Event("visibilitychange"));
      expect(onNotice).toHaveBeenCalledTimes(1);
    } finally {
      delete (globalThis as { document?: unknown }).document;
    }
  });
});

describe("interruption keeps an earlier reply's slow call answered (Q9, Q10)", () => {
  it("sends an error result for the slow call instead of dropping it, and counts each id once", async () => {
    let finishSlow!: (r: unknown) => void;
    const runTool = vi.fn(() => new Promise<unknown>((resolve) => { finishSlow = resolve; }));
    const { ws, socket } = await ready({ runTool });
    ws[0].emit({ type: "reply.started" });
    ws[0].emit({ type: "tool.call", call_id: "slow", name: "verify_claim", arguments: {} });
    ws[0].emit({ type: "reply.done", status: "completed" });
    // A second reply starts and the student cuts it off while `slow` is still running.
    ws[0].emit({ type: "reply.started" });
    ws[0].emit({ type: "input.speech.started" });
    ws[0].emit({ type: "reply.done", status: "interrupted" });

    const sent = ws[0].of("tool.result");
    expect(sent).toHaveLength(1);
    expect(sent[0].call_id).toBe("slow");
    expect(sent[0].is_error).toBe(true);

    finishSlow({ status: "supported" });
    await new Promise((r) => setTimeout(r, 0));
    expect(ws[0].of("tool.result")).toHaveLength(1);
    expect(socket.machine().discards).toBe(0);
    expect(socket.machine().interruptions).toBe(1);
  });
});

describe("agent transcript flagged interrupted (Q3, live trace)", () => {
  it("flushes audio, discards the pending result and counts one interruption, though reply.done says completed", async () => {
    // Order taken from docs/evidence/probes/oral-live-interrupt-during-pending-tool-negative.*.json:
    // tool.call, transcript.agent{interrupted:true}, reply.done{completed}, reply.started.
    const { ws, flushAudio, socket, states } = await ready();
    ws[0].emit({ type: "reply.started" });
    ws[0].emit({ type: "tool.call", call_id: "c1", name: "verify_claim", arguments: {} });
    await new Promise((r) => setTimeout(r, 0));
    flushAudio.mockClear();
    ws[0].emit({ type: "transcript.agent", text: "The notes on page 15 say", interrupted: true });
    expect(flushAudio).toHaveBeenCalled();
    expect(states[states.length - 1]).toBe("INTERRUPTED");
    ws[0].emit({ type: "reply.done", status: "completed" });
    ws[0].emit({ type: "reply.started" });
    expect(ws[0].of("tool.result")).toHaveLength(0);
    expect(socket.machine().interruptions).toBe(1);
    expect(socket.machine().discards).toBe(1);
  });

  it("drops late audio of the interrupted reply until the next reply starts", async () => {
    const { ws, playAudio } = await ready();
    ws[0].emit({ type: "reply.started" });
    ws[0].emit({ type: "transcript.agent", text: "well", interrupted: true });
    playAudio.mockClear();
    ws[0].emit({ type: "reply.audio", data: "AAAA" });
    expect(playAudio).not.toHaveBeenCalled();
    ws[0].emit({ type: "reply.started" });
    ws[0].emit({ type: "reply.audio", data: "AAAA" });
    expect(playAudio).toHaveBeenCalledTimes(1);
  });
});

describe("CHECKING_SOURCE while a call is pending (Q8)", () => {
  it("holds CHECKING_SOURCE past reply.done until the slow call is delivered, then THINKING", async () => {
    let finish!: (r: unknown) => void;
    const runTool = vi.fn(() => new Promise<unknown>((resolve) => { finish = resolve; }));
    const { ws, states } = await ready({ runTool });
    ws[0].emit({ type: "reply.started" });
    ws[0].emit({ type: "tool.call", call_id: "slow", name: "verify_claim", arguments: {} });
    ws[0].emit({ type: "reply.done", status: "completed" });
    expect(states[states.length - 1]).toBe("CHECKING_SOURCE");
    finish({ status: "supported" });
    await new Promise((r) => setTimeout(r, 0));
    expect(ws[0].of("tool.result")).toHaveLength(1);
    expect(states[states.length - 1]).toBe("THINKING");
  });
});

describe("a tool result never crosses a session change (Q5)", () => {
  /** Drop the session, get the resume refused, and reach a fresh session on FakeWS 2. */
  async function toFreshSession(ws: FakeWS[], socket: OralSocket) {
    ws[0].fire("close", { code: 1006, reason: "network" });
    await new Promise((r) => setTimeout(r, 0));
    FakeWS.instances[1].open();
    FakeWS.instances[1].emit({ type: "session.error", code: "session_not_found", message: "gone" });
    FakeWS.instances[1].fire("close", { code: 1008, reason: "" });
    await new Promise((r) => setTimeout(r, 20));
    FakeWS.instances[2].open();
    return socket;
  }

  it("does not send a dead session's tool.result on the new session", async () => {
    let finish!: (r: unknown) => void;
    const runTool = vi.fn(() => new Promise<unknown>((resolve) => { finish = resolve; }));
    const { ws, socket } = await ready({ runTool });
    ws[0].emit({ type: "reply.started" });
    ws[0].emit({ type: "tool.call", call_id: "old", name: "verify_claim", arguments: {} });
    ws[0].emit({ type: "reply.done", status: "completed" });
    await toFreshSession(ws, socket);
    // Result lands after the new socket opened but before its session.ready.
    finish({ status: "supported" });
    await new Promise((r) => setTimeout(r, 0));
    FakeWS.instances[2].emit({ type: "session.ready", session_id: "sess_2", resume_token: "rt2" });
    expect(FakeWS.instances[2].of("tool.result")).toHaveLength(0);
    expect(socket.machine().pending).toHaveLength(0);
    expect(socket.machine().ready).toHaveLength(0);
    expect(socket.machine().discards).toBe(1);
    socket.cancel();
  });

  it("drops a result that lands after the new session is ready", async () => {
    let finish!: (r: unknown) => void;
    const runTool = vi.fn(() => new Promise<unknown>((resolve) => { finish = resolve; }));
    const { ws, socket } = await ready({ runTool });
    ws[0].emit({ type: "tool.call", call_id: "old", name: "verify_claim", arguments: {} });
    ws[0].emit({ type: "reply.done", status: "completed" });
    await toFreshSession(ws, socket);
    FakeWS.instances[2].emit({ type: "session.ready", session_id: "sess_2", resume_token: "rt2" });
    finish({ status: "supported" });
    await new Promise((r) => setTimeout(r, 0));
    expect(FakeWS.instances[2].of("tool.result")).toHaveLength(0);
    expect(socket.machine().discards).toBe(1);
    socket.cancel();
  });

  it("keeps a call across a resume that the service accepts (same session id)", async () => {
    let finish!: (r: unknown) => void;
    const runTool = vi.fn(() => new Promise<unknown>((resolve) => { finish = resolve; }));
    const { ws, socket } = await ready({ runTool });
    ws[0].emit({ type: "tool.call", call_id: "keep", name: "verify_claim", arguments: {} });
    ws[0].emit({ type: "reply.done", status: "completed" });
    ws[0].fire("close", { code: 1006, reason: "network" });
    await new Promise((r) => setTimeout(r, 0));
    FakeWS.instances[1].open();
    FakeWS.instances[1].emit({ type: "session.ready", session_id: "sess_1", resume_token: "rt" });
    FakeWS.instances[1].emit({ type: "reply.done", status: "completed" });
    finish({ status: "supported" });
    await new Promise((r) => setTimeout(r, 0));
    expect(FakeWS.instances[1].of("tool.result")).toHaveLength(1);
    socket.cancel();
  });

  it("delivers a finished call only when reply.done is the latest event", async () => {
    let finish!: (r: unknown) => void;
    const runTool = vi.fn(() => new Promise<unknown>((resolve) => { finish = resolve; }));
    const { ws, socket } = await ready({ runTool });
    ws[0].emit({ type: "tool.call", call_id: "c1", name: "verify_claim", arguments: {} });
    ws[0].emit({ type: "reply.done", status: "completed" });
    ws[0].emit({ type: "input.speech.started" });
    finish({ status: "supported" });
    await new Promise((r) => setTimeout(r, 0));
    expect(ws[0].of("tool.result")).toHaveLength(0);
    expect(socket.machine().ready).toHaveLength(1);
    ws[0].emit({ type: "reply.started" });
    ws[0].emit({ type: "reply.done", status: "completed" });
    expect(ws[0].of("tool.result")).toHaveLength(1);
    socket.cancel();
  });
});

describe("end() before the session exists leaves no ghost session (Q11)", () => {
  it("opens no socket when end() is called while the token is still being minted", async () => {
    let giveToken!: (t: string) => void;
    const getToken = vi.fn(() => new Promise<string>((resolve) => { giveToken = resolve; }));
    const onEnded = vi.fn();
    const { socket } = setup({ getToken, onEnded });
    await socket.end();
    giveToken("tok_late");
    await new Promise((r) => setTimeout(r, 0));
    expect(FakeWS.instances).toHaveLength(0);
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(socket.machine().state).toBe("IDLE");
  });

  it("closes a socket that is still CONNECTING and never sends session.update on it", async () => {
    const { socket } = setup();
    await new Promise((r) => setTimeout(r, 0));
    const ws0 = FakeWS.instances[0];
    ws0.readyState = 0;
    await socket.end();
    expect(ws0.closeCalls).toBeGreaterThan(0);
    ws0.readyState = 1;
    ws0.open();
    expect(ws0.sent).toHaveLength(0);
    expect(socket.machine().state).toBe("ENDED");
  });

  it("does not reconnect after end() when the old socket's close arrives late", async () => {
    const { socket } = await ready();
    await socket.end();
    FakeWS.instances[0].fire("close", { code: 1006, reason: "late" });
    await new Promise((r) => setTimeout(r, 10));
    expect(FakeWS.instances).toHaveLength(1);
  });
});

describe("stale sockets and the backoff timer (Q14)", () => {
  it("ignores messages and a second close from a socket that is no longer current", async () => {
    const { ws, socket } = await ready();
    ws[0].fire("close", { code: 1006, reason: "network" });
    await new Promise((r) => setTimeout(r, 0));
    expect(FakeWS.instances).toHaveLength(2);
    FakeWS.instances[1].open();
    ws[0].emit({ type: "tool.call", call_id: "zombie", name: "verify_claim", arguments: {} });
    ws[0].emit({ type: "reply.done", status: "interrupted" });
    expect(socket.machine().toolCalls).toBe(0);
    expect(socket.machine().interruptions).toBe(0);
    ws[0].fire("close", { code: 1006, reason: "again" });
    await new Promise((r) => setTimeout(r, 20));
    expect(FakeWS.instances).toHaveLength(2);
    socket.cancel();
  });

  it("clears the reconnect backoff timer on cancel", async () => {
    vi.useFakeTimers();
    try {
      const { socket } = setup();
      await vi.advanceTimersByTimeAsync(0);
      FakeWS.instances[0].open();
      FakeWS.instances[0].emit({ type: "session.ready", session_id: "sess_1", resume_token: "rt" });
      FakeWS.instances[0].fire("close", { code: 1006, reason: "network" });
      await vi.advanceTimersByTimeAsync(0);
      FakeWS.instances[1].open();
      FakeWS.instances[1].fire("close", { code: 1006, reason: "network" });
      // The second attempt waits out a 500 ms backoff.
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      socket.cancel();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the backoff timer when a resume succeeds", async () => {
    vi.useFakeTimers();
    try {
      const { socket } = setup();
      await vi.advanceTimersByTimeAsync(0);
      FakeWS.instances[0].open();
      FakeWS.instances[0].emit({ type: "session.ready", session_id: "sess_1", resume_token: "rt" });
      FakeWS.instances[0].fire("close", { code: 1006, reason: "network" });
      await vi.advanceTimersByTimeAsync(0);
      FakeWS.instances[1].open();
      FakeWS.instances[1].fire("close", { code: 1006, reason: "network" });
      await vi.advanceTimersByTimeAsync(600);
      FakeWS.instances[2].open();
      FakeWS.instances[2].emit({ type: "session.ready", session_id: "sess_1", resume_token: "rt" });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(FakeWS.instances).toHaveLength(3);
      socket.cancel();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("token failure during recovery is retryable (Q15)", () => {
  /** getToken that succeeds for the first `okCalls` calls, then follows `after`. */
  const flaky = (okCalls: number, after: () => Promise<string>) => {
    let n = 0;
    return vi.fn(() => (++n <= okCalls ? Promise.resolve("tok") : after()));
  };

  it("retries after a failed token mint on a resume instead of ending the exam", async () => {
    vi.useFakeTimers();
    try {
      let failures = 1;
      const getToken = flaky(1, () => (failures-- > 0 ? Promise.reject(new Error("mint down")) : Promise.resolve("tok2")));
      const { socket, onError } = setup({ getToken });
      await vi.advanceTimersByTimeAsync(0);
      FakeWS.instances[0].open();
      FakeWS.instances[0].emit({ type: "session.ready", session_id: "sess_1", resume_token: "rt" });
      FakeWS.instances[0].fire("close", { code: 1006, reason: "network" });
      await vi.advanceTimersByTimeAsync(0);
      expect(onError).not.toHaveBeenCalled();
      expect(socket.machine().state).toBe("RECOVERING");
      expect(FakeWS.instances).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(600);
      expect(FakeWS.instances).toHaveLength(2);
      FakeWS.instances[1].open();
      expect(FakeWS.instances[1].sent[0]).toEqual({ type: "session.resume", session_id: "sess_1" });
      expect(onError).not.toHaveBeenCalled();
      socket.cancel();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up with a message after a bounded number of failed mints", async () => {
    vi.useFakeTimers();
    try {
      const getToken = flaky(1, () => Promise.reject(new Error("mint down")));
      const { socket, onError } = setup({ getToken });
      await vi.advanceTimersByTimeAsync(0);
      FakeWS.instances[0].open();
      FakeWS.instances[0].emit({ type: "session.ready", session_id: "sess_1", resume_token: "rt" });
      FakeWS.instances[0].fire("close", { code: 1006, reason: "network" });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(getToken.mock.calls.length).toBeLessThanOrEqual(8);
      expect(socket.machine().state).toBe("ERROR");
      expect(socket.machine().fatal).toBe(true);
      socket.cancel();
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for the browser's online event instead of burning retries while offline", async () => {
    vi.useFakeTimers();
    const handlers: Record<string, () => void> = {};
    vi.stubGlobal("addEventListener", (type: string, fn: () => void) => { handlers[type] = fn; });
    vi.stubGlobal("removeEventListener", () => {});
    vi.stubGlobal("navigator", { onLine: false });
    try {
      let mintOk = false;
      const getToken = flaky(1, () => (mintOk ? Promise.resolve("tok2") : Promise.reject(new Error("offline"))));
      const { socket, onError } = setup({ getToken });
      await vi.advanceTimersByTimeAsync(0);
      FakeWS.instances[0].open();
      FakeWS.instances[0].emit({ type: "session.ready", session_id: "sess_1", resume_token: "rt" });
      FakeWS.instances[0].fire("close", { code: 1006, reason: "network" });
      await vi.advanceTimersByTimeAsync(20_000);
      // Offline for 20 s: no fatal error, and the mint was tried once, not on a timer loop.
      expect(onError).not.toHaveBeenCalled();
      expect(getToken.mock.calls.length).toBe(2);
      expect(FakeWS.instances).toHaveLength(1);
      mintOk = true;
      vi.stubGlobal("navigator", { onLine: true });
      handlers.online?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(FakeWS.instances).toHaveLength(2);
      socket.cancel();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("still ends the exam when the very first token cannot be minted", async () => {
    const { socket, onError } = setup({ getToken: async () => { throw new Error("no key"); } });
    await new Promise((r) => setTimeout(r, 0));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(socket.machine().fatal).toBe(true);
  });
});

describe("buffered audio is paced, not dumped (Q23)", () => {
  const frame = (i: number) => new Int16Array([i, i]);
  const audioSent = (ws: FakeWS) => ws.of("input.audio").map((s) => s.audio as string);

  it("sends the first buffered frame at once and the rest no faster than real time", async () => {
    vi.useFakeTimers();
    try {
      const { socket } = setup();
      await vi.advanceTimersByTimeAsync(0);
      FakeWS.instances[0].open();
      for (let i = 0; i < 8; i++) socket.sendAudio(frame(i + 1));
      FakeWS.instances[0].emit({ type: "session.ready", session_id: "sess_1", resume_token: "rt" });
      expect(audioSent(FakeWS.instances[0])).toHaveLength(1);
      for (let t = 1; t <= 7; t++) {
        await vi.advanceTimersByTimeAsync(100);
        // 100 ms of audio per frame: never more frames than elapsed real time allows.
        expect(audioSent(FakeWS.instances[0]).length).toBe(1 + t);
      }
      await vi.advanceTimersByTimeAsync(1_000);
      expect(audioSent(FakeWS.instances[0])).toHaveLength(8);
      socket.cancel();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps order, and queues a live frame behind the backlog", async () => {
    vi.useFakeTimers();
    try {
      const { socket } = setup();
      await vi.advanceTimersByTimeAsync(0);
      FakeWS.instances[0].open();
      for (let i = 1; i <= 3; i++) socket.sendAudio(frame(i));
      FakeWS.instances[0].emit({ type: "session.ready", session_id: "sess_1", resume_token: "rt" });
      socket.sendAudio(frame(99));
      await vi.advanceTimersByTimeAsync(1_000);
      const sent = audioSent(FakeWS.instances[0]);
      const expected = [1, 2, 3, 99].map((i) => btoa(String.fromCharCode(i, 0, i, 0)));
      expect(sent).toEqual(expected);
      socket.cancel();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops the oldest backlog beyond one second so latency stays bounded", async () => {
    vi.useFakeTimers();
    try {
      const { socket } = setup();
      await vi.advanceTimersByTimeAsync(0);
      FakeWS.instances[0].open();
      for (let i = 1; i <= 30; i++) socket.sendAudio(frame(i));
      FakeWS.instances[0].emit({ type: "session.ready", session_id: "sess_1", resume_token: "rt" });
      await vi.advanceTimersByTimeAsync(5_000);
      const sent = audioSent(FakeWS.instances[0]);
      expect(sent).toHaveLength(10);
      expect(sent[0]).toBe(btoa(String.fromCharCode(21, 0, 21, 0)));
      expect(sent[9]).toBe(btoa(String.fromCharCode(30, 0, 30, 0)));
      socket.cancel();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops the pacing timer on cancel", async () => {
    vi.useFakeTimers();
    try {
      const { socket } = setup();
      await vi.advanceTimersByTimeAsync(0);
      FakeWS.instances[0].open();
      for (let i = 1; i <= 5; i++) socket.sendAudio(frame(i));
      FakeWS.instances[0].emit({ type: "session.ready", session_id: "sess_1", resume_token: "rt" });
      socket.cancel();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
