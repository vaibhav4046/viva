import { describe, expect, it, vi } from "vitest";
import { openVoiceSocket } from "@/lib/redteam/socket";

/** The behaviours the live service has surprised us on: refused settings, dead resumes, drops. */

class WS {
  static all: WS[] = [];
  readyState = 1;
  sent: Record<string, any>[] = [];
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: unknown) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: (() => void) | null = null;
  closes = 0;
  constructor(readonly url: string) {
    WS.all.push(this);
  }
  addEventListener() {}
  removeEventListener() {}
  send(raw: string) {
    this.sent.push(JSON.parse(raw));
  }
  close() {
    this.closes += 1;
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  emit(m: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
}

const CONFIG = {
  system_prompt: "p",
  greeting: "Opening question.",
  tools: [],
  keyterms: ["Postgres"],
  language_codes: ["en"],
  transcription_mode: "balanced",
  turn_detection: { vad_threshold: 0.6, silence_duration_ms: 900, interrupt_during_agent_speech: true },
};

const tick = () => new Promise((r) => setTimeout(r, 0));

async function open(extra: Partial<Parameters<typeof openVoiceSocket>[0]> = {}) {
  WS.all = [];
  const tokens = vi.fn(async () => `tok${WS.all.length}`);
  const onDegraded = vi.fn();
  const onError = vi.fn();
  const states: string[] = [];
  const socket = openVoiceSocket({
    config: CONFIG,
    getToken: tokens,
    runTool: async () => ({}),
    openSocket: (u) => new WS(u) as unknown as WebSocket,
    onState: (m) => states.push(m.state),
    onDegraded,
    onError,
    ...extra,
  });
  await tick();
  return { socket, tokens, onDegraded, onError, states };
}

describe("refused optional settings", () => {
  it("retries once with only the VAD threshold, then with nothing, and then comes up", async () => {
    const { tokens, onDegraded, states } = await open();
    const first = WS.all[0];
    first.onopen?.({});
    expect(first.sent[0].session.input.turn_detection).toEqual(CONFIG.turn_detection);

    first.emit({ type: "session.error", code: "invalid_value", param: "turn_detection", message: "no" });
    await tick();
    const second = WS.all[1];
    second.onopen?.({});
    expect(second.sent[0].session.input.turn_detection).toEqual({ vad_threshold: 0.6 });
    expect(second.sent[0].session.input.keyterms).toEqual(["Postgres"]);
    expect(second.sent[0].session.input.transcription_mode).toBeUndefined();

    second.emit({ type: "session.error", code: "invalid_config", message: "no" });
    await tick();
    const third = WS.all[2];
    third.onopen?.({});
    expect(third.sent[0].session.input).toEqual({ format: { encoding: "audio/pcm" } });
    third.emit({ type: "session.ready", session_id: "s1" });

    expect(states.at(-1)).toBe("LISTENING");
    expect(states).not.toContain("ERROR");
    expect(onDegraded).toHaveBeenCalledTimes(2);
    expect(tokens).toHaveBeenCalledTimes(3); // a fresh token per connection
    expect(new Set(WS.all.map((w) => w.url)).size).toBe(3);
  });

  it("gives up honestly if even the bare session is refused", async () => {
    const { onError, states } = await open();
    for (let i = 0; i < 3; i++) {
      WS.all[i].onopen?.({});
      WS.all[i].emit({ type: "session.error", code: "invalid_config", message: "no" });
      await tick();
    }
    expect(states.at(-1)).toBe("ERROR");
    expect(onError).toHaveBeenCalled();
  });

  it("never degrades once the session has been ready", async () => {
    const { onDegraded, states } = await open();
    WS.all[0].onopen?.({});
    WS.all[0].emit({ type: "session.ready", session_id: "s1" });
    WS.all[0].emit({ type: "session.error", code: "invalid_value", message: "late" });
    expect(onDegraded).not.toHaveBeenCalled();
    expect(states.at(-1)).toBe("ERROR");
  });
});

describe("dropped and dead sessions", () => {
  it("a drop resumes with session.resume and a fresh token", async () => {
    const { tokens, states } = await open();
    WS.all[0].onopen?.({});
    WS.all[0].emit({ type: "session.ready", session_id: "sess_9" });
    WS.all[0].drop(1006);
    expect(states).toContain("RECOVERING");
    await tick();
    const back = WS.all[1];
    back.onopen?.({});
    expect(back.sent[0]).toEqual({ type: "session.resume", session_id: "sess_9" });
    expect(tokens).toHaveBeenCalledTimes(2);
    back.emit({ type: "session.ready", session_id: "sess_9" });
    expect(states.at(-1)).toBe("LISTENING");
  });

  it("a resume the service refuses becomes a fresh session with the reconnect greeting", async () => {
    const { states } = await open({ reconnectGreeting: "Back again." });
    WS.all[0].onopen?.({});
    WS.all[0].emit({ type: "session.ready", session_id: "sess_9" });
    WS.all[0].drop(1006);
    await tick();
    WS.all[1].onopen?.({});
    WS.all[1].emit({ type: "session.error", code: "session_not_found", message: "expired" });
    await tick();
    const fresh = WS.all[2];
    fresh.onopen?.({});
    expect(fresh.sent[0].type).toBe("session.update");
    expect(fresh.sent[0].session.greeting).toBe("Back again.");
    fresh.emit({ type: "session.ready", session_id: "sess_10" });
    expect(states.at(-1)).toBe("LISTENING");
    expect(states).not.toContain("ERROR");
  });

  it("frames from a socket that was replaced cannot move the machine", async () => {
    const { states } = await open();
    WS.all[0].onopen?.({});
    WS.all[0].emit({ type: "session.error", code: "invalid_config", message: "no" });
    await tick();
    WS.all[1].onopen?.({});
    WS.all[1].emit({ type: "session.ready", session_id: "s" });
    const before = states.length;
    WS.all[0].emit({ type: "session.error", code: "INTERNAL_ERROR", message: "stale" });
    WS.all[0].drop(1011);
    expect(states.length).toBe(before);
    expect(states.at(-1)).toBe("LISTENING");
  });

  it("a fatal auth error is not retried", async () => {
    const { onError, states } = await open();
    WS.all[0].onopen?.({});
    WS.all[0].emit({ type: "session.error", code: "UNAUTHORIZED", message: "no" });
    expect(states.at(-1)).toBe("ERROR");
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/sign-in failed/i));
  });

  it("a failed token mint is a plain, non-technical error", async () => {
    WS.all = [];
    const onError = vi.fn();
    const states: string[] = [];
    openVoiceSocket({
      config: CONFIG,
      getToken: async () => {
        throw new Error("boom");
      },
      runTool: async () => ({}),
      openSocket: (u) => new WS(u) as unknown as WebSocket,
      onState: (m) => states.push(m.state),
      onError,
    });
    await tick();
    expect(WS.all).toHaveLength(0);
    expect(states.at(-1)).toBe("ERROR");
    expect(String(onError.mock.calls[0][0])).not.toMatch(/boom|Error/);
  });

  it("buffers audio until session.ready and never sends before it", async () => {
    const { socket } = await open();
    const ws = WS.all[0];
    ws.onopen?.({});
    socket.sendAudio(new Int16Array(2400));
    expect(ws.sent.filter((s) => s.type === "input.audio")).toHaveLength(0);
    ws.emit({ type: "session.ready", session_id: "s" });
    expect(ws.sent.filter((s) => s.type === "input.audio")).toHaveLength(1);
  });
});
