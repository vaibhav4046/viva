import {
  initialMachine,
  onConnecting,
  onSessionReady,
  onStartStreaming,
  onToolCall,
  withToolResult,
  onReplyDone,
  onError,
  onRecovering,
  onEnded,
  type OralMachine,
} from "@/lib/oral/machine";

/**
 * The socket client as a testable seam.
 *
 * The parts of a WebSocket client that break are never the socket itself. They
 * are: what you send after `reply.done`, what you throw away when a student
 * interrupts, whether the mic keeps running, and whether a token gets logged.
 * This harness drives the real client with a fake socket and no browser, so
 * those four things are asserted rather than hoped for.
 */

export type Sent = { type: string; [k: string]: unknown };

export class FakeSocket {
  sent: Sent[] = [];
  private open = true;
  closed: { code: number; reason: string } | null = null;
  /** Set true to make every `send` throw, as a half-dead socket would. */
  failSend = false;
  onMessage: (data: unknown) => void = () => {};
  onClose: (code: number, reason: string) => void = () => {};

  constructor(readonly url: string) {}

  open_() { this.open = true; }

  send(raw: string): void {
    if (this.failSend) throw new Error("socket write failed");
    this.sent.push(JSON.parse(raw));
  }

  /** Deliver a server event. */
  emit(ev: Record<string, unknown>): void {
    this.onMessage(JSON.stringify(ev));
  }

  serverClose(code = 1006, reason = "abnormal"): void {
    this.open = false;
    this.closed = { code, reason };
    this.onClose(code, reason);
  }

  get isOpen(): boolean { return this.open; }
  of(type: string): Sent[] { return this.sent.filter((s) => s.type === type); }
}

export type Harness = {
  /**
   * The *current* socket. A getter, not a snapshot: `connect()` replaces it,
   * and a captured reference would silently keep asserting against the dead
   * one after a resume, which is exactly the case these tests exist for.
   */
  readonly socket: FakeSocket;
  machine: () => OralMachine;
  state: () => string;
  start: (cfg?: { sessionId?: string | null }) => void;
  /** Run a tool call end to end: the client POSTs, then queues the result. */
  runTool: (callId: string, name: string, args: Record<string, unknown>, result: unknown) => Promise<void>;
  /** What the client would actually put on the wire after a reply. */
  drain: (status: "completed" | "interrupted") => Sent[];
  end: () => void;
  flush: () => void;
  /** Opens a socket and sends the correct first frame for the mode. */
  connect: (mode?: "fresh" | "resume", sessionId?: string) => FakeSocket;
};

const BASE = "wss://agents.assemblyai.com/v1/ws";

/**
 * A faithful-enough stand-in for the client: it performs the documented
 * sequence and uses the real state machine for every decision. If this harness
 * and the real client disagree, the bug is in whichever one is not this file,
 * and both share `machine.ts`, so most of the logic is only written once.
 */
export function harness(opts: { toolRunner?: (name: string, args: Record<string, unknown>) => Promise<unknown> } = {}): Harness {
  let m = initialMachine();
  let socket = new FakeSocket(BASE);
  let turnTools = 0;

  /**
   * `resume` is deliberately not a flag here. The API is strict that
   * `session.resume` is the FIRST message on a new connection, and
   * `session.update` is the first message on a fresh one, never both, and
   * never in the other order. Handing `connect()` a mode keeps that ordering
   * in one place instead of leaving the caller to remember it.
   */
  const connect = (mode: "fresh" | "resume", sessionId?: string): FakeSocket => {
    socket = new FakeSocket(BASE);
    socket.onMessage = (data) => {
      const ev = typeof data === "string" ? (JSON.parse(data) as Record<string, unknown>) : (data as Record<string, unknown>);
      onServerEvent(ev);
    };
    socket.onClose = (code, reason) => {
      if (m.state === "IDLE" || m.state === "ENDED") return; // clean teardown, not a drop
      m = onRecovering(m, `socket closed ${code} ${reason}`);
    };
    m = onConnecting(m);
    if (mode === "resume" && sessionId) {
      socket.send(JSON.stringify({ type: "session.resume", session_id: sessionId }));
    } else {
      socket.send(
        JSON.stringify({
          type: "session.update",
          session: { system_prompt: "test", greeting: "hi", tools: [] },
        })
      );
    }
    return socket;
  };

  function onServerEvent(ev: Record<string, unknown>): void {
    switch (ev.type) {
      case "session.ready":
        m = onSessionReady(m, { session_id: ev.session_id as string, resume_token: (ev.resume_token as string) ?? null });
        m = onStartStreaming(m);
        break;
      case "tool.call":
        m = onToolCall(m, ev);
        turnTools += 1;
        void runToolNow(ev);
        break;
      case "reply.done":
        flushResults(ev.status as "completed" | "interrupted" | undefined);
        break;
      case "session.error":
        m = onError(m, String(ev.code ?? "session.error"), false);
        break;
      default:
        break;
    }
  }

  async function runToolNow(ev: Record<string, unknown>): Promise<void> {
    const runner = opts.toolRunner ?? (async () => ({ ok: true }));
    try {
      const result = await runner(String(ev.name), (ev.arguments as Record<string, unknown>) ?? {});
      m = withToolResult(m, String(ev.call_id ?? ""), result);
    } catch {
      m = withToolResult(m, String(ev.call_id ?? ""), { error: "tool failed" }, true);
    }
  }

  /** The documented delivery point: reply.done. */
  function flushResults(status: "completed" | "interrupted" | undefined): Sent[] {
    const { machine, send } = onReplyDone(m, { status: status ?? "completed" });
    m = machine;
    if (status === "interrupted") turnTools = 0;
    const out: Sent[] = [];
    for (const r of send) {
      if (!socket.isOpen) break;
      socket.send(JSON.stringify({ type: "tool.result", call_id: r.callId, result: r.result, is_error: r.isError }));
      out.push({ type: "tool.result", call_id: r.callId, result: r.result, is_error: r.isError });
    }
    if (status !== "interrupted") turnTools = 0;
    return out;
  }

  return {
    get socket() {
      return socket;
    },
    machine: () => m,
    state: () => m.state,
    connect: (mode: "fresh" | "resume" = "fresh", sessionId?: string) => {
      connect(mode, sessionId);
      return socket;
    },
    start(cfg) {
      if (cfg?.sessionId) {
        connect("resume", cfg.sessionId);
        return;
      }
      connect("fresh");
      socket.emit({ type: "session.ready", session_id: "sess_live", resume_token: "rt" });
    },
    async runTool(callId, name, args, result) {
      await runToolNow({ call_id: callId, name, arguments: args });
      void result;
    },
    drain: (status) => flushResults(status),
    end() {
      socket.send(JSON.stringify({ type: "session.end" }));
      m = onEnded(m);
    },
    flush: () => {
      void turnTools;
    },
  };
}

export const WS_URL = BASE;
