/**
 * The oral exam state machine, and the tool-result queue.
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

/** Every state the oral screen can be in. Nothing else is renderable. */
export type OralState =
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
  | "ENDED"; // session.ended seen: a clean finish, the summary is final

export const ORAL_STATES: readonly OralState[] = [
  "IDLE", "CONNECTING", "READY", "LISTENING", "USER_SPEAKING", "THINKING",
  "CHECKING_SOURCE", "SPEAKING", "INTERRUPTED", "RECOVERING", "ERROR", "ENDED",
] as const;

/**
 * States the machine does not leave on its own. ERROR is only terminal when
 * `fatal`: a transient session.error leaves the socket alive and the machine
 * must be able to recover from it. (Found live 2026-09-29: the guard treated
 * every ERROR as terminal, so a refused resume left the screen on "Something
 * went wrong" through a healthy continued exam.)
 */
const TERMINAL: ReadonlySet<OralState> = new Set<OralState>(["IDLE", "ERROR", "ENDED"]);

export type PendingTool = {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  /** Millisecond stamp, for the diagnostics panel. Never used for ordering. */
  at: number;
  /** reply.done completed; the result may now be delivered when HTTP finishes. */
  released?: boolean;
};

export type QueuedResult = {
  callId: string;
  /** Already JSON-stringified: the wire format wants a string, and doing it
   *  here means a result cannot be half-serialised on the way out. */
  result: string;
  isError: boolean;
};

export type OralMachine = {
  state: OralState;
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
  /**
   * Call ids that left `pending` without a live result: discarded by an
   * interruption, answered with an error, or dropped on a session change. A
   * late HTTP result for one of these is expected and is not counted again.
   */
  gone: string[];
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
  /**
   * The current reply's interruption is already counted and its calls already
   * discarded. transcript.agent(interrupted) and reply.done(interrupted) can
   * both announce one barge-in; this keeps it to a single count. Cleared when
   * the next reply starts.
   */
  interruptHandled: boolean;
};

export function initialMachine(): OralMachine {
  return {
    state: "IDLE",
    fatal: false,
    reason: null,
    sessionId: null,
    resumeToken: null,
    pending: [],
    ready: [],
    gone: [],
    turns: 0,
    interruptions: 0,
    toolCalls: 0,
    discards: 0,
    userItemId: null,
    userPartial: "",
    streaming: false,
    interruptHandled: false,
  };
}

/**
 * Allowed transitions. An explicit table rather than a pile of `if`s, because
 * "what may follow SPEAKING" is the question a reviewer actually asks, and a
 * table is answerable by reading it.
 */
const TRANSITIONS: Record<OralState, readonly OralState[]> = {
  IDLE: ["CONNECTING"],
  CONNECTING: ["READY", "ERROR", "IDLE", "ENDED"],
  READY: ["LISTENING", "ERROR", "RECOVERING", "IDLE", "ENDED"],
  // LISTENING -> SPEAKING is not decoration: the agent opens the exam. The
  // greeting arrives with no user turn at all, so the client is in LISTENING
  // when the first `reply.audio` lands, and without this the screen reads
  // "Listening. Go ahead." while the examiner is already talking. Found by
  // driving the real service, where the greeting is the first thing that ever
  // comes back.
  LISTENING: ["USER_SPEAKING", "THINKING", "SPEAKING", "CHECKING_SOURCE", "ERROR", "RECOVERING", "IDLE", "ENDED"],
  // USER_SPEAKING -> SPEAKING: reply audio still arriving while the student is
  // audibly speaking (a cough, a false start) is the examiner still talking.
  USER_SPEAKING: ["LISTENING", "THINKING", "SPEAKING", "CHECKING_SOURCE", "ERROR", "RECOVERING", "IDLE", "ENDED"],
  THINKING: ["CHECKING_SOURCE", "SPEAKING", "LISTENING", "ERROR", "RECOVERING", "IDLE", "ENDED"],
  CHECKING_SOURCE: ["SPEAKING", "THINKING", "LISTENING", "ERROR", "RECOVERING", "IDLE", "ENDED"],
  // A tool call arrives while a reply is still nominally in flight: the
  // documented flow is reply.started -> tool.call -> reply.done, so SPEAKING
  // has to be allowed to hand off to CHECKING_SOURCE. Without this the screen
  // would claim the agent is speaking while a retrieval was actually running.
  // SPEAKING -> USER_SPEAKING: input.speech.started lands about 2 s before
  // reply.done(interrupted), and the screen must show the student talking then.
  SPEAKING: ["USER_SPEAKING", "INTERRUPTED", "CHECKING_SOURCE", "LISTENING", "THINKING", "ERROR", "RECOVERING", "IDLE", "ENDED"],
  // After a barge-in the reply that follows must be able to leave INTERRUPTED,
  // or the screen keeps saying the student cut in through the whole answer.
  INTERRUPTED: ["LISTENING", "USER_SPEAKING", "THINKING", "SPEAKING", "CHECKING_SOURCE", "ERROR", "RECOVERING", "IDLE", "ENDED"],
  RECOVERING: ["READY", "LISTENING", "ERROR", "IDLE", "ENDED"],
  // A non-fatal ERROR (a retryable session.error) recovers through a resume, a
  // fresh connect, or the session.ready of a socket that stayed up.
  ERROR: ["CONNECTING", "RECOVERING", "READY", "LISTENING", "SPEAKING", "USER_SPEAKING", "IDLE", "ENDED"],
  ENDED: ["CONNECTING", "IDLE"],
};

/**
 * Move to `next`, or stay put and report why not.
 *
 * Refusing an illegal transition is deliberate. A UI that renders whatever
 * state it was handed will happily draw "the agent is thinking" while the
 * socket is dead; the machine is the thing that knows the difference.
 */
export function transition(m: OralMachine, next: OralState, opts: { reason?: string; fatal?: boolean } = {}): OralMachine {
  if (m.state === next) {
    // Re-entering the same state is only meaningful for ERROR, which can
    // escalate from transient to fatal in place.
    if (next === "ERROR") {
      return { ...m, fatal: !!opts.fatal, reason: opts.reason ?? m.reason };
    }
    return m;
  }
  if (TERMINAL.has(m.state)) {
    const startAgain = (m.state === "IDLE" || m.state === "ENDED" || m.state === "ERROR") && next === "CONNECTING";
    const recoverFromTransient = m.state === "ERROR" && !m.fatal;
    if (!startAgain && !recoverFromTransient) return m;
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

export function onConnecting(m: OralMachine): OralMachine {
  return { ...transition(m, "CONNECTING"), fatal: false, reason: null };
}

export function onSessionReady(
  m: OralMachine,
  ev: { session_id?: string; resume_token?: string | null }
): OralMachine {
  const next = transition(m, "READY");
  return {
    ...next,
    sessionId: ev.session_id ?? next.sessionId,
    resumeToken: ev.resume_token ?? next.resumeToken,
  };
}

export function onStartStreaming(m: OralMachine): OralMachine {
  return { ...transition(m, "LISTENING"), streaming: true };
}

/** `input.speech.started`, turn detection says the student began. */
export function onSpeechStarted(m: OralMachine): OralMachine {
  return { ...transition(m, "USER_SPEAKING"), userPartial: "" };
}

/**
 * `transcript.user.delta`, the text is the FULL transcript so far for this
 * item, so it replaces. A note says this twice because the wrong reading
 * produces a transcript that looks like a recognition failure.
 */
export function onUserDelta(m: OralMachine, ev: { item_id?: string; text?: string }): OralMachine {
  return { ...m, userItemId: ev.item_id ?? m.userItemId, userPartial: ev.text ?? "" };
}

/** `transcript.user`, the turn is closed and the final text is known. */
export function onUserFinal(m: OralMachine, ev: { item_id?: string; text?: string }): OralMachine {
  return {
    ...m,
    turns: m.turns + 1,
    userItemId: ev.item_id ?? m.userItemId,
    userPartial: ev.text ?? m.userPartial,
    state: m.state === "USER_SPEAKING" || m.state === "INTERRUPTED" ? "THINKING" : m.state,
  };
}

/** `reply.started`, the agent is composing. */
export function onReplyStarted(m: OralMachine): OralMachine {
  return { ...transition(m, "SPEAKING"), interruptHandled: false };
}

/** `reply.audio`, speech is arriving. Also means we are speaking. */
export function onReplyAudio(m: OralMachine): OralMachine {
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
export function onCheckingSource(m: OralMachine): OralMachine {
  return transition(m, "CHECKING_SOURCE");
}

/**
 * `tool.call`, queue it. Nothing is sent back yet: the protocol wants
 * `tool.result` delivered once `reply.done` is the latest event.
 */
export function onToolCall(m: OralMachine, ev: { call_id?: string; name?: string; arguments?: unknown }): OralMachine {
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
  m: OralMachine,
  callId: string,
  result: unknown,
  isError = false
): OralMachine {
  // If the call is already gone (the turn was interrupted and discarded), the
  // result is dropped rather than resurrected into the next turn. This is the
  // single most important line in the file.
  if (!m.pending.some((p) => p.callId === callId)) {
    // Counted once per call id: an id already in `gone` was counted (or
    // answered) when it left the queue, so its late result costs nothing more.
    return m.gone.includes(callId) ? m : { ...m, discards: m.discards + 1 };
  }
  return {
    ...m,
    ready: [...m.ready, { callId, result: JSON.stringify(result ?? null), isError }],
  };
}

const GONE_LIMIT = 200;
const markGone = (gone: string[], ids: string[]): string[] => [...gone, ...ids].slice(-GONE_LIMIT);

/** What the examiner is told when the student cut in before a slow check finished. */
function interruptedResult(callId: string): QueuedResult {
  return {
    callId,
    result: JSON.stringify({ error: "The learner interrupted before this check finished. Do not confirm or correct them on this point." }),
    isError: true,
  };
}

/** Deliver only results whose reply has completed. A later reply may have
 * started while an earlier HTTP call is still running, so draining every
 * ready result here would send the later reply's result too early. */
export function drainReleasedResults(m: OralMachine): { machine: OralMachine; send: QueuedResult[] } {
  const released = new Set(m.pending.filter((p) => p.released).map((p) => p.callId));
  const send = m.ready.filter((r) => released.has(r.callId)).sort(
    (a, b) => m.pending.findIndex((p) => p.callId === a.callId) - m.pending.findIndex((p) => p.callId === b.callId)
  );
  const sent = new Set(send.map((r) => r.callId));
  const pending = m.pending.filter((p) => !sent.has(p.callId));
  // The screen says CHECKING_SOURCE for exactly as long as a call is pending.
  // Once the last one is delivered the agent has its answer and is composing.
  const state = m.state === "CHECKING_SOURCE" && pending.length === 0 ? "THINKING" : m.state;
  return {
    machine: { ...m, state, pending, ready: m.ready.filter((r) => !sent.has(r.callId)) },
    send,
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
  m: OralMachine,
  ev: { status?: string; reply_id?: string }
): { machine: OralMachine; send: QueuedResult[]; discardCallIds: string[] } {
  const interrupted = ev.status === "interrupted";

  if (interrupted) {
    // Only calls from the reply that just died are discarded. A call whose own
    // reply already completed (released) is one the service is still waiting
    // on, so it gets its real result if it is ready and an error result if not.
    // Silently dropping it would leave the examiner waiting on a call forever.
    const unreleased = m.pending.filter((p) => !p.released);
    const released = m.pending.filter((p) => p.released);
    const send = released.map((p) => m.ready.find((r) => r.callId === p.callId) ?? interruptedResult(p.callId));
    const discarded = unreleased.map((p) => p.callId).filter((id) => !m.gone.includes(id));
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
        gone: markGone(m.gone, m.pending.map((p) => p.callId)),
        interruptions: m.interruptHandled ? m.interruptions : m.interruptions + 1,
        interruptHandled: true,
        discards: m.discards + discarded.length,
        streaming: true,
      },
      send,
      discardCallIds: unreleased.map((p) => p.callId),
    };
  }

  // A tool POST may still be running when reply.done arrives. Keep those calls
  // and release their results as each request resolves.
  const released = drainReleasedResults({ ...m, pending: m.pending.map((p) => ({ ...p, released: true })) });
  // reply.done does not end a source check that is still running: the screen
  // keeps saying so until the call is delivered (live: about 1.3 s of "Listening"
  // over a running verify_claim before this).
  const next = released.machine.pending.length > 0 ? "CHECKING_SOURCE" : "LISTENING";
  return {
    machine: {
      ...transition(released.machine, next),
      streaming: true,
    },
    send: released.send,
    discardCallIds: [],
  };
}

/**
 * `transcript.agent` with `interrupted: true`. Measured live (2026-09-29, the
 * interrupt-during-pending-tool probe): the service sent this, then
 * reply.done(status "completed"), and never reply.done(interrupted). The flag
 * is therefore the interruption signal in that shape. Same effect as the
 * interrupted reply.done minus the tool results, because reply.done is not the
 * latest event here: unreleased calls are discarded, released ones wait for
 * the next reply.done.
 */
export function onAgentInterrupted(m: OralMachine): { machine: OralMachine; discardCallIds: string[] } {
  if (TERMINAL.has(m.state)) return { machine: m, discardCallIds: [] };
  const unreleased = m.pending.filter((p) => !p.released).map((p) => p.callId);
  const fresh = unreleased.filter((id) => !m.gone.includes(id));
  return {
    machine: {
      ...m,
      state: "INTERRUPTED",
      pending: m.pending.filter((p) => p.released),
      ready: m.ready.filter((r) => !unreleased.includes(r.callId)),
      gone: markGone(m.gone, unreleased),
      interruptions: m.interruptHandled ? m.interruptions : m.interruptions + 1,
      interruptHandled: true,
      discards: m.discards + fresh.length,
      streaming: true,
    },
    discardCallIds: unreleased,
  };
}

/**
 * The session changed (a fresh session replaced a dead one). Every call still
 * queued belongs to a session that no longer exists, and a tool.result for its
 * call_id would be sent to the new session. Each is counted as one discard.
 */
export function onSessionChanged(m: OralMachine): OralMachine {
  if (m.pending.length === 0 && m.ready.length === 0) return m;
  const ids = m.pending.map((p) => p.callId);
  const fresh = ids.filter((id) => !m.gone.includes(id));
  return { ...m, pending: [], ready: [], gone: markGone(m.gone, ids), discards: m.discards + fresh.length, interruptHandled: false };
}

/** A socket drop that we intend to resume from. */
export function onRecovering(m: OralMachine, reason?: string): OralMachine {
  const next = transition(m, "RECOVERING");
  return { ...next, reason: reason ?? next.reason };
}

export function onError(m: OralMachine, reason: string, fatal = false): OralMachine {
  const next = transition(m, "ERROR", { reason, fatal });
  // If ERROR is not reachable from the current state, which can happen from
  // IDLE, which is terminal, record the failure anyway. A dead session that
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
export function onEnded(m: OralMachine): OralMachine {
  return { ...transition(m, "ENDED"), streaming: false, pending: [], ready: [], sessionId: null };
}
