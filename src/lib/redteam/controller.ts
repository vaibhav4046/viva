import { openVoiceSocket, type VoiceSocket, type VoiceSocketOptions } from "./socket";
import type { VoiceMachine } from "./machine";
import type { Report } from "./report";
import type { publicView } from "./session";
import type { ClaimStatus } from "./types";

/**
 * Everything between the socket and the screen, with no React in it.
 *
 * The screen renders `state()`. This module is what makes that state true:
 * protocol events go in, server calls come out, and the ledger the server
 * returns is the only thing the Defensibility Map is drawn from. It is a
 * module of its own so the golden flow — claim, contradiction, interruption,
 * correction, verdict change — can be driven in a test with a fake socket and
 * the real route handlers, which is the only honest way to test barge-in
 * without a browser and a microphone.
 */

export type SessionView = ReturnType<typeof publicView>;
export type VoiceConfig = VoiceSocketOptions["config"] & { sessionId: string };

export type Api = {
  token: () => Promise<string>;
  tool: (sessionId: string, name: string, args: Record<string, unknown>, callId: string) => Promise<{ result: Record<string, unknown>; isError: boolean; session: SessionView }>;
  turn: (sessionId: string, event: "interrupted" | "user_final", text?: string) => Promise<{ changed: boolean; claimId: string | null; statusBefore: string | null; session: SessionView }>;
  typed: (sessionId: string, body: { text?: string; interrupt?: boolean; next?: boolean }) => Promise<{ claimId: string | null; previousStatus: string | null; corrected: boolean; session: SessionView }>;
  end: (sessionId: string) => Promise<{ report: Report; session: SessionView }>;
};

export type TranscriptLine = { id: number; speaker: "user" | "agent"; text: string; interrupted: boolean };

/** A verdict that moved, kept so the screen can show the transition and not just the new state. */
export type StatusChange = { claimId: string; from: ClaimStatus; to: ClaimStatus; cause: "correction" | "reevaluation"; at: number };

export type ControllerState = {
  machine: VoiceMachine | null;
  session: SessionView;
  transcript: TranscriptLine[];
  /** The live partial of what the user is saying right now. */
  partial: string;
  /** Set by a barge-in until the correction lands. */
  interruptedClaimId: string | null;
  lastChange: StatusChange | null;
  report: Report | null;
  /** Plain sentence, or null. */
  error: string | null;
  degraded: string | null;
  mode: "voice" | "typed";
  /** True while a server call is running for the source check. */
  checking: boolean;
};

export type Controller = {
  state: () => ControllerState;
  subscribe: (fn: (s: ControllerState) => void) => () => void;
  startVoice: (config: VoiceConfig, hooks: { openSocket?: VoiceSocketOptions["openSocket"]; playAudio?: (b64: string) => void; flushAudio?: () => void }) => VoiceSocket;
  sendAudio: (frame: Int16Array) => void;
  typed: (text: string) => Promise<void>;
  typedInterrupt: () => Promise<void>;
  typedNext: () => Promise<void>;
  end: () => Promise<void>;
  stopVoice: () => Promise<void>;
  cancel: () => void;
};

export function createController(api: Api, initial: SessionView, opts: { now?: () => number } = {}): Controller {
  const now = opts.now ?? Date.now;
  let socket: VoiceSocket | null = null;
  let lineId = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const subs = new Set<(s: ControllerState) => void>();

  let s: ControllerState = {
    machine: null,
    session: initial,
    transcript: [],
    partial: "",
    interruptedClaimId: null,
    lastChange: null,
    report: null,
    error: null,
    degraded: null,
    mode: "voice",
    checking: false,
  };

  const set = (patch: Partial<ControllerState>) => {
    s = { ...s, ...patch };
    for (const fn of subs) fn(s);
  };

  /** One server call at a time, in the order the protocol produced them. */
  const enqueue = <T,>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };

  const statusOf = (v: SessionView, id: string | null): ClaimStatus | null => v.claims.find((c) => c.id === id)?.status ?? null;

  const fail = (message: string) => set({ error: message });

  const startVoice: Controller["startVoice"] = (config, hooks) => {
    const sessionId = config.sessionId;
    set({ mode: "voice", error: null });
    socket = openVoiceSocket({
      config,
      getToken: api.token,
      reconnectGreeting: "I lost you for a moment. Your review is intact. Carry on.",
      ...(hooks.openSocket ? { openSocket: hooks.openSocket } : {}),
      ...(hooks.playAudio ? { playAudio: hooks.playAudio } : {}),
      ...(hooks.flushAudio ? { flushAudio: hooks.flushAudio } : {}),
      onState: (machine) => set({ machine, partial: machine.state === "USER_SPEAKING" || machine.state === "INTERRUPTED" ? machine.userPartial : "", checking: machine.state === "CHECKING_SOURCE" }),
      onDegraded: (_level, note) => set({ degraded: note }),
      onError: (message) => fail(message),
      onTranscript: (text, speaker, interrupted) => {
        if (!text.trim()) return;
        set({ transcript: [...s.transcript, { id: ++lineId, speaker, text, interrupted: interrupted === true }], partial: "" });
        if (speaker !== "user") return;
        // The finished user turn is reported to the ledger now, in order, so a
        // correction lands even if the model is slow to ask for it.
        void enqueue(async () => {
          try {
            const before = statusOf(s.session, s.interruptedClaimId);
            const r = await api.turn(sessionId, "user_final", text);
            const patch: Partial<ControllerState> = { session: r.session };
            if (r.changed && r.claimId) {
              const to = statusOf(r.session, r.claimId);
              const from = (r.statusBefore as ClaimStatus | null) ?? before;
              if (from && to) patch.lastChange = { claimId: r.claimId, from, to, cause: "correction", at: now() };
              patch.interruptedClaimId = null;
            }
            set(patch);
          } catch {
            // The transcript is still on screen; the agent's own tool call can still land it.
          }
        });
      },
      onInterrupted: () => {
        void enqueue(async () => {
          try {
            const r = await api.turn(sessionId, "interrupted");
            set({ session: r.session, interruptedClaimId: r.claimId });
          } catch {
            // Playback was already flushed locally; the ledger just misses one marker.
          }
        });
      },
      runTool: async (name, args, callId) => {
        const r = await enqueue(() => api.tool(sessionId, name, args, callId));
        const patch: Partial<ControllerState> = { session: r.session };
        const res = r.result as { status?: ClaimStatus; previous_status?: ClaimStatus | null; status_changed?: boolean; claim_id?: string };
        if (name === "reevaluate_claim" && res.status_changed && res.claim_id && res.previous_status && res.status && s.lastChange?.claimId !== res.claim_id) {
          patch.lastChange = { claimId: res.claim_id, from: res.previous_status, to: res.status, cause: "reevaluation", at: now() };
          patch.interruptedClaimId = null;
        }
        if (name === "finish_redteam_session") {
          void api.end(sessionId).then((e) => set({ report: e.report, session: e.session })).catch(() => undefined);
        }
        set(patch);
        return r.result;
      },
      onEnded: () => {
        // The review, not the socket, decides when the report exists.
      },
    });
    return socket;
  };

  return {
    state: () => s,
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    startVoice,
    sendAudio: (frame) => socket?.sendAudio(frame),
    async typed(text) {
      set({ mode: "typed", error: null });
      set({ transcript: [...s.transcript, { id: ++lineId, speaker: "user", text, interrupted: false }] });
      try {
        const r = await enqueue(() => api.typed(s.session.id, { text }));
        const patch: Partial<ControllerState> = { session: r.session };
        if (r.corrected && r.claimId && r.previousStatus) {
          const to = statusOf(r.session, r.claimId);
          if (to) patch.lastChange = { claimId: r.claimId, from: r.previousStatus as ClaimStatus, to, cause: "correction", at: now() };
          patch.interruptedClaimId = null;
        }
        set(patch);
      } catch {
        fail("That did not go through. Try it again.");
      }
    },
    async typedInterrupt() {
      set({ mode: "typed", error: null });
      try {
        const r = await enqueue(() => api.typed(s.session.id, { interrupt: true }));
        set({ session: r.session, interruptedClaimId: r.session.activeClaimId });
      } catch {
        fail("That did not go through. Try it again.");
      }
    },
    async typedNext() {
      try {
        const r = await enqueue(() => api.typed(s.session.id, { next: true }));
        set({ session: r.session });
      } catch {
        fail("That did not go through. Try it again.");
      }
    },
    async end() {
      try {
        const r = await enqueue(() => api.end(s.session.id));
        set({ report: r.report, session: r.session });
      } catch {
        fail("The report could not be built. Try again.");
      }
    },
    async stopVoice() {
      await socket?.end();
    },
    cancel() {
      socket?.cancel();
    },
  };
}
