/**
 * The Voice Agent session state machine, and the tool-result queue.
 *
 * Both are pure and synchronous, with no WebSocket and no React, because the
 * part of this feature most likely to be wrong is the part that only shows up
 * when a student interrupts the agent mid-tool-call. That is also the part a
 * browser test is worst at provoking, so it lives here where it can be
 * asserted directly.
 *
 * Protocol facts this encodes, taken from the AssemblyAI Voice Agent API
 * events reference rather than from memory:
 *
 *  - `tool.result` must be sent when `reply.done` is the latest event received.
 *    The documented pattern is "accumulate on tool.call, drain inside the
 *    reply.done handler". Sending it straight back on `tool.call` is a
 *    protocol error.
 *  - On `reply.done` with `status: "interrupted"`, the client must flush
 *    playback, and **discard any pending `tool.result` accumulators from the
 *    just-ended reply**. A tool result computed against a reply the user
 *    abandoned would otherwise be delivered into the next one.
 *  - `transcript.user.delta` carries the **full transcript so far** for an
 *    item, not an increment. Concatenating deltas produces a garbled
 *    transcript, which is a bug that looks like a transcription problem and is
 *    not one.
 */

/** Every state the review screen can be in. Nothing else is renderable. */
export type VoiceState =
  | "IDLE" // no session; the mic is closed
  | "CONNECTING" // socket opening, token in hand
  | "READY" // session.ready seen, no audio flowing yet
  | "LISTENING" // mic open, silent, waiting for speech
  | "USER_SPEAKING" // input.speech.started, transcript deltas arriving
  | "THINKING" // turn closed, no reply yet
  | "CHECKING_SOURCE" // a source tool is running
  | "SPEAKING" // reply.audio arriving
  | "INTERRUPTED" // reply.done(status=interrupted) seen this turn
  | "RECOVERING" // dropped, attempting session.resume
  | "ERROR" // recoverable or not, decided by `fatal`
  | "ENDED"; // the session finished; a report exists

export const VOICE_STATES: readonly VoiceState[] = [
  "IDLE", "CONNECTING", "READY", "LISTENING", "USER_SPEAKING", "THINKING",
  "CHECKING_SOURCE", "SPEAKING", "INTERRUPTED", "RECOVERING", "ERROR", "ENDED",
] as const;

/** States from which no further progress is possible without user action. */
const TERMINAL: ReadonlySet<VoiceState> = new Set<VoiceState>(["IDLE", "ERROR", "ENDED"]);

export type PendingTool = {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  /** Millisecond stamp, for the diagnostics panel. Never used for ordering. */
  at: number;
};

export type QueuedResult = {
  callId: string;
  /** Already JSON-stringified: the wire format wants a string, and doing it
   *  here means a result cannot be half-serialised on the way out. */
  result: string;
  isError: boolean;
};

export type VoiceMachine = {
  state: VoiceState;
  /** False for a `session.error` that a reconnect cannot fix. */
  fatal: boolean;
  /** Why we are in ERROR, in one plain sentence. */
  reason: string | null;
  sessionId: string | null;
  resumeToken: string | null;
  /** Tool calls awaiting their result, in arrival order. */
  pending: PendingTool[];
  /** Results computed and ready to send at the next `reply.done`. */
  ready: QueuedResult[];
  /** Counters for the diagnostics panel. Real numbers only. */
  turns: number;
  interruptions: number;
  toolCalls: number;
  discards: number;
  /** Item id of the transcript currently being assembled from deltas. */
  userItemId: string | null;
  userPartial: string;
  /** Whether the microphone is currently streaming to the socket. */
  streaming: boolean;
};

export function initialMachine(): VoiceMachine {
  return {
    state: "IDLE",
    fatal: false,
    reason: null,
    sessionId: null,
    resumeToken: null,
    pending: [],
    ready: [],
    turns: 0,
    interruptions: 0,
    toolCalls: 0,
    discards: 0,
    userItemId: null,
    userPartial: "",
    streaming: false,
  };
}

/**
 * Allowed transitions. An explicit table rather than a pile of `if`s, because
 * "what may follow SPEAKING" is the question a reviewer actually asks, and a
 * table is answerable by reading it.
 */
const TRANSITIONS: Record<VoiceState, readonly VoiceState[]> = {
  IDLE: ["CONNECTING"],
  CONNECTING: ["READY", "ERROR", "IDLE"],
  READY: ["LISTENING", "ERROR", "RECOVERING", "IDLE"],
  // LISTENING -> SPEAKING is not decoration: the agent opens the exam. The
  // greeting arrives with no user turn at all, so the client is in LISTENING
  // when the first `reply.audio` lands, and without this the screen reads
  // "Listening. Go ahead." while the examiner is already talking. Found by
  // driving the real service, where the greeting is the first thing that ever
  // comes back.
  LISTENING: ["USER_SPEAKING", "THINKING", "SPEAKING", "ERROR", "RECOVERING", "IDLE"],
  USER_SPEAKING: ["LISTENING", "THINKING", "ERROR", "RECOVERING", "IDLE"],
  THINKING: ["CHECKING_SOURCE", "SPEAKING", "USER_SPEAKING", "LISTENING", "ERROR", "RECOVERING", "IDLE"],
  CHECKING_SOURCE: ["SPEAKING", "USER_SPEAKING", "THINKING", "LISTENING", "ERROR", "RECOVERING", "IDLE"],
  // A tool call arrives while a reply is still nominally in flight: the
  // documented flow is reply.started -> tool.call -> reply.done, so SPEAKING
  // has to be allowed to hand off to CHECKING_SOURCE. Without this the screen
  // would claim the agent is speaking while a retrieval was actually running.
  // SPEAKING -> USER_SPEAKING: `input.speech.started` can land before the
  // `reply.done(interrupted)` that explains it. Refusing it would leave the
  // screen saying the agent is speaking while the user is mid-sentence.
  SPEAKING: ["INTERRUPTED", "USER_SPEAKING", "CHECKING_SOURCE", "LISTENING", "THINKING", "ERROR", "RECOVERING", "IDLE"],
  INTERRUPTED: ["LISTENING", "USER_SPEAKING", "THINKING", "ERROR", "RECOVERING", "IDLE"],
  RECOVERING: ["READY", "LISTENING", "ERROR", "IDLE"],
  ERROR: ["CONNECTING", "RECOVERING", "IDLE"],
  ENDED: ["CONNECTING"],
};

/**
 * Move to `next`, or stay put and report why not.
 *
 * Refusing an illegal transition is deliberate. A UI that renders whatever
 * state it was handed will happily draw "the agent is thinking" while the
 * socket is dead; the machine is the thing that knows the difference.
 */
export function transition(m: VoiceMachine, next: VoiceState, opts: { reason?: string; fatal?: boolean } = {}): VoiceMachine {
  if (m.state === next) {
    // Re-entering the same state is only meaningful for ERROR, which can
    // escalate from transient to fatal in place.
    if (next === "ERROR") {
      return { ...m, fatal: !!opts.fatal, reason: opts.reason ?? m.reason };
    }
    return m;
  }
  if (TERMINAL.has(m.state)) {
    if ((m.state === "IDLE" || m.state === "ENDED") && next === "CONNECTING") {
      // IDLE/ENDED -> CONNECTING is the one legal escape from a terminal state.
    } else {
      return m;
    }
  }
  if (!TRANSITIONS[m.state].includes(next)) {
    return m;
  }
  return {
    ...m,
    state: next,
    ...(next === "ERROR" ? { fatal: !!opts.fatal, reason: opts.reason ?? null } : {}),
  };
}

// --- event handlers. One per protocol event, so the mapping is readable. ---

export function onConnecting(m: VoiceMachine): VoiceMachine {
  return { ...transition(m, "CONNECTING"), fatal: false, reason: null };
}

export function onSessionReady(
  m: VoiceMachine,
  ev: { session_id?: string; resume_token?: string | null }
): VoiceMachine {
  const next = transition(m, "READY");
  return {
    ...next,
    sessionId: ev.session_id ?? next.sessionId,
    resumeToken: ev.resume_token ?? next.resumeToken,
  };
}

export function onStartStreaming(m: VoiceMachine): VoiceMachine {
  return { ...transition(m, "LISTENING"), streaming: true };
}

/** `input.speech.started` — turn detection says the student began. */
export function onSpeechStarted(m: VoiceMachine): VoiceMachine {
  return { ...transition(m, "USER_SPEAKING"), userPartial: "" };
}

/**
 * `transcript.user.delta` — the text is the FULL transcript so far for this
 * item, so it replaces. A note says this twice because the wrong reading
 * produces a transcript that looks like a recognition failure.
 */
export function onUserDelta(m: VoiceMachine, ev: { item_id?: string; text?: string }): VoiceMachine {
  return { ...m, userItemId: ev.item_id ?? m.userItemId, userPartial: ev.text ?? "" };
}

/** `transcript.user` — the turn is closed and the final text is known. */
export function onUserFinal(m: VoiceMachine, ev: { item_id?: string; text?: string }): VoiceMachine {
  return {
    ...m,
    turns: m.turns + 1,
    userItemId: ev.item_id ?? m.userItemId,
    userPartial: ev.text ?? m.userPartial,
    // A finished user turn means the agent owes a reply, whichever state we
    // were in when the words closed. SPEAKING is left alone on purpose: a
    // back-channel ("uh-huh") closes a user turn without interrupting anyone.
    state: m.state === "USER_SPEAKING" || m.state === "INTERRUPTED" || m.state === "LISTENING" ? "THINKING" : m.state,
  };
}

/** `reply.started` — the agent is composing. */
export function onReplyStarted(m: VoiceMachine): VoiceMachine {
  return transition(m, "SPEAKING");
}

/** `reply.audio` — speech is arriving. Also means we are speaking. */
export function onReplyAudio(m: VoiceMachine): VoiceMachine {
  return transition(m, "SPEAKING");
}

/**
 * A tool call is in flight: the browser holds the POST open while the server
 * runs it against the learner's own material.
 *
 * This is the one state the machine reaches from the client rather than from a
 * protocol event, because "we are checking the source" is something the screen
 * knows and the socket does not. Without it, a slow retrieval looks identical
 * to a hung agent, and the diagnostics panel has nothing to report.
 */
export function onCheckingSource(m: VoiceMachine): VoiceMachine {
  return transition(m, "CHECKING_SOURCE");
}

/**
 * `tool.call` — queue it. Nothing is sent back yet: the protocol wants
 * `tool.result` delivered once `reply.done` is the latest event.
 */
export function onToolCall(m: VoiceMachine, ev: { call_id?: string; name?: string; arguments?: unknown }): VoiceMachine {
  const callId = typeof ev.call_id === "string" ? ev.call_id : "";
  const args =
    ev.arguments && typeof ev.arguments === "object" && !Array.isArray(ev.arguments)
      ? (ev.arguments as Record<string, unknown>)
      : {};
  return {
    ...m,
    pending: [...m.pending, { callId, name: typeof ev.name === "string" ? ev.name : "", args, at: m.turns }],
    toolCalls: m.toolCalls + 1,
  };
}

/** Attach a computed result to a queued call. */
export function withToolResult(
  m: VoiceMachine,
  callId: string,
  result: unknown,
  isError = false
): VoiceMachine {
  // If the call is already gone (the turn was interrupted and discarded), the
  // result is dropped rather than resurrected into the next turn. This is the
  // single most important line in the file.
  if (!m.pending.some((p) => p.callId === callId)) {
    return { ...m, discards: m.discards + 1 };
  }
  return {
    ...m,
    ready: [...m.ready, { callId, result: JSON.stringify(result ?? null), isError }],
  };
}

/**
 * `reply.done`.
 *
 * `status: "interrupted"` is the branch that matters. The protocol says to
 * discard pending accumulators from the just-ended reply, and this is where
 * that happens, together with the `INTERRUPTED` state so the screen can show
 * that the student cut in rather than that the agent finished.
 */
export function onReplyDone(
  m: VoiceMachine,
  ev: { status?: string; reply_id?: string }
): { machine: VoiceMachine; send: QueuedResult[]; discardCallIds: string[] } {
  const interrupted = ev.status === "interrupted";

  if (interrupted) {
    const discarded = m.pending.map((p) => p.callId);
    return {
      // The server is authoritative about what happened to the reply, so the
      // state is forced rather than transitioned. A frame dropped between
      // `reply.audio` and `reply.done` can leave us in LISTENING when the
      // barge-in actually arrived during SPEAKING; the discard is the part
      // that must not be lost, and it is not conditional on the state.
      machine: {
        ...m,
        state: "INTERRUPTED",
        pending: [],
        ready: [],
        interruptions: m.interruptions + 1,
        discards: m.discards + discarded.length,
        streaming: true,
      },
      send: [],
      discardCallIds: discarded,
    };
  }

  // Completed: drain everything, in call order.
  const send = [...m.ready].sort(
    (a, b) => m.pending.findIndex((p) => p.callId === a.callId) - m.pending.findIndex((p) => p.callId === b.callId)
  );
  return {
    machine: {
      // After delivering tool results the service is composing the spoken
      // answer to them: that is THINKING, not LISTENING. Saying "listening"
      // there would invite the user to talk over a reply that is about to start.
      ...transition(m, send.length > 0 ? "THINKING" : "LISTENING"),
      pending: [],
      ready: [],
      streaming: true,
    },
    send,
    discardCallIds: [],
  };
}

/** A socket drop that we intend to resume from. */
export function onRecovering(m: VoiceMachine, reason?: string): VoiceMachine {
  const next = transition(m, "RECOVERING");
  return { ...next, reason: reason ?? next.reason };
}

export function onError(m: VoiceMachine, reason: string, fatal = false): VoiceMachine {
  const next = transition(m, "ERROR", { reason, fatal });
  // If ERROR is not reachable from the current state — which can happen from
  // IDLE, which is terminal — record the failure anyway. A dead session that
  // still claims to be IDLE is worse than one that admits it errored.
  if (next.state === "ERROR") {
    return { ...next, fatal, reason };
  }
  return { ...m, state: "ERROR", fatal, reason };
}

/** `session.error` codes that a fresh connection can plausibly fix. */
const RETRYABLE = new Set([
  "at_capacity",
  "concurrency_exceeded",
  "internal_error",
  "server_error",
  "INTERNAL_ERROR",
  "session_not_found",
  "session_expired",
]);

export function isRetryableCode(code: string): boolean {
  return RETRYABLE.has(code);
}

/** Clean teardown. */
export function onEnded(m: VoiceMachine): VoiceMachine {
  // Forced, like the interrupted branch of `onReplyDone`: the service is
  // authoritative that the session is over, whatever we thought we were doing.
  return { ...m, state: "ENDED", streaming: false, pending: [], ready: [], sessionId: null };
}
