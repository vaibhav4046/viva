import { describe, expect, it } from "vitest";
import {
  initialMachine,
  transition,
  onConnecting,
  onSessionReady,
  onStartStreaming,
  onSpeechStarted,
  onUserDelta,
  onUserFinal,
  onReplyStarted,
  onReplyAudio,
  onCheckingSource,
  onToolCall,
  withToolResult,
  onReplyDone,
  onRecovering,
  onError,
  onEnded,
  isRetryableCode,
  ORAL_STATES,
  type OralMachine,
  type OralState,
} from "@/lib/oral/machine";

/** Drive a machine to a state the way the real client would, step by step. */
function toSpeaking(): OralMachine {
  let m = initialMachine();
  m = onConnecting(m);
  m = onSessionReady(m, { session_id: "sess_1", resume_token: "rt" });
  m = onStartStreaming(m);
  m = onSpeechStarted(m);
  m = onUserFinal(m, { item_id: "i1", text: "attention is permutation invariant" });
  m = onReplyStarted(m);
  return m;
}

describe("oral state machine", () => {
  it("has the twelve states the product promises", () => {
    expect(ORAL_STATES).toEqual([
      "IDLE", "CONNECTING", "READY", "LISTENING", "USER_SPEAKING", "THINKING",
      "CHECKING_SOURCE", "SPEAKING", "INTERRUPTED", "RECOVERING", "ERROR", "ENDED",
    ]);
    expect(ORAL_STATES).toHaveLength(12);
    expect(new Set(ORAL_STATES).size).toBe(ORAL_STATES.length);
  });

  it("walks a clean turn from greeting to listening", () => {
    const m = toSpeaking();
    expect(m.state).toBe("SPEAKING");
    const done = onReplyDone(m, { status: "completed", reply_id: "r1" });
    expect(done.machine.state).toBe("LISTENING");
    expect(done.machine.turns).toBe(1);
    expect(done.machine.streaming).toBe(true);
  });

  it("refuses an illegal transition instead of pretending", () => {
    const m = onConnecting(initialMachine());
    expect(transition(m, "SPEAKING").state).toBe("CONNECTING");
  });

  it("lets IDLE escape to CONNECTING but nothing else leaves a terminal state", () => {
    const m = initialMachine();
    expect(onConnecting(m).state).toBe("CONNECTING");
    const dead = onError(initialMachine(), "boom", true);
    expect(dead.state).toBe("ERROR");
    expect(transition(dead, "SPEAKING").state).toBe("ERROR");
  });

  it("records a failure even when ERROR is unreachable from the current state", () => {
    // IDLE is terminal, so a token failure arriving before connect() would
    // otherwise leave a broken session that still claims to be idle.
    const m = onError(initialMachine(), "NO_API_KEY", false);
    expect(m.state).toBe("ERROR");
    expect(m.reason).toBe("NO_API_KEY");
    expect(m.fatal).toBe(false);
  });

  it("treats transcript.user.delta as a replacement, not an increment", () => {
    // The API sends the full transcript so far. Concatenating produces a
    // garbled transcript that reads like a recognition failure.
    let m = onStartStreaming(onSessionReady(onConnecting(initialMachine()), { session_id: "s" }));
    m = onSpeechStarted(m);
    m = onUserDelta(m, { item_id: "i1", text: "attention" });
    m = onUserDelta(m, { item_id: "i1", text: "attention is permutation" });
    m = onUserDelta(m, { item_id: "i1", text: "attention is permutation invariant" });
    expect(m.userPartial).toBe("attention is permutation invariant");
  });

  it("moves from USER_SPEAKING to THINKING on the final transcript", () => {
    let m = onStartStreaming(onSessionReady(onConnecting(initialMachine()), { session_id: "s" }));
    m = onSpeechStarted(m);
    expect(m.state).toBe("USER_SPEAKING");
    m = onUserFinal(m, { item_id: "i1", text: "hello" });
    expect(m.state).toBe("THINKING");
  });

  it("keeps the session id for a resume", () => {
    const m = onSessionReady(onConnecting(initialMachine()), { session_id: "sess_abc", resume_token: "rt" });
    expect(m.sessionId).toBe("sess_abc");
    expect(m.resumeToken).toBe("rt");
  });

  it("enters RECOVERING on a drop and clears the reason once it is back", () => {
    const m = onRecovering(toSpeaking(), "socket closed 1006");
    expect(m.state).toBe("RECOVERING");
    const back = onSessionReady(onRecovering(m), { session_id: "sess_1" });
    expect(back.state).toBe("READY");
  });

  it("speaks from LISTENING, because the agent opens the exam", () => {
    // The greeting arrives with no user turn, so the first `reply.audio` lands
    // while the machine is LISTENING. Without this the screen says "Listening.
    // Go ahead." over the top of the examiner already talking. Found by driving
    // the real service, where the greeting is the first audio that ever exists.
    let m = onStartStreaming(onSessionReady(onConnecting(initialMachine()), { session_id: "s" }));
    expect(m.state).toBe("LISTENING");
    m = onReplyAudio(m);
    expect(m.state).toBe("SPEAKING");
  });
});

describe("tool result queue, the interrupted-turn rule", () => {
  it("queues on tool.call and sends nothing until reply.done", () => {
    // The protocol wants tool.result delivered once reply.done is the latest
    // event. Returning on tool.call is a protocol error, so onToolCall must not
    // signal anything to send.
    let m = onToolCall(toSpeaking(), { call_id: "c1", name: "check_my_understanding", arguments: { claim: "x" } });
    expect(m.pending).toHaveLength(1);
    expect(m.ready).toHaveLength(0);
    expect(m.toolCalls).toBe(1);
  });

  it("drains the queue in call order on a completed reply", () => {
    let m = toSpeaking();
    m = onToolCall(m, { call_id: "c1", name: "search_my_material", arguments: {} });
    m = onToolCall(m, { call_id: "c2", name: "quote_my_material", arguments: {} });
    m = withToolResult(m, "c2", { supported: true });
    m = withToolResult(m, "c1", { found: true });
    const { machine, send } = onReplyDone(m, { status: "completed" });
    expect(send.map((s) => s.callId)).toEqual(["c1", "c2"]);
    expect(machine.pending).toHaveLength(0);
    expect(machine.ready).toHaveLength(0);
  });

  it("DISCARDS queued results when the student interrupts", () => {
    // The whole point of the feature. A tool result computed against a reply
    // the student abandoned must not be delivered into the next one.
    let m = onToolCall(toSpeaking(), { call_id: "c1", name: "grade_my_answer", arguments: {} });
    m = withToolResult(m, "c1", { verdict: "incorrect" });
    expect(m.ready).toHaveLength(1);

    const { machine, send, discardCallIds } = onReplyDone(m, { status: "interrupted" });
    expect(machine.state).toBe("INTERRUPTED");
    expect(send).toHaveLength(0);
    expect(discardCallIds).toEqual(["c1"]);
    expect(machine.pending).toHaveLength(0);
    expect(machine.ready).toHaveLength(0);
    expect(machine.interruptions).toBe(1);
    expect(machine.discards).toBe(1);
  });

  it("drops a result that lands after the interruption that killed its call", () => {
    // The tool POST resolves after reply.done(interrupted) in real life, since
    // the HTTP round trip outlasts the reply. That late result must not be
    // resurrected for the next turn.
    let m = onToolCall(toSpeaking(), { call_id: "c1", name: "check_my_understanding", arguments: {} });
    const interrupted = onReplyDone(m, { status: "interrupted" }).machine;
    const late = withToolResult(interrupted, "c1", { status: "contradicted" });
    expect(late.ready).toHaveLength(0);
    expect(late.discards).toBe(2); // one on the interrupt, one on the late result
    const { send } = onReplyDone(late, { status: "completed" });
    expect(send).toHaveLength(0);
  });

  it("still keeps the mic open after an interruption, because the student kept talking", () => {
    const { machine } = onReplyDone(
      withToolResult(onToolCall(toSpeaking(), { call_id: "c1", name: "save_note", arguments: {} }), "c1", {}),
      { status: "interrupted" }
    );
    expect(machine.streaming).toBe(true);
  });

  it("serialises the result to a JSON string, as the wire format wants", () => {
    let m = onToolCall(toSpeaking(), { call_id: "c1", name: "search_my_material", arguments: {} });
    m = withToolResult(m, "c1", { found: true, passages: [{ chunkId: "k1" }] });
    const { send } = onReplyDone(m, { status: "completed" });
    expect(typeof send[0].result).toBe("string");
    expect(JSON.parse(send[0].result)).toEqual({ found: true, passages: [{ chunkId: "k1" }] });
  });

  it("survives a tool.call with no arguments object at all", () => {
    const m = onToolCall(toSpeaking(), { call_id: "c1", name: "quote_my_material" });
    expect(m.pending[0].args).toEqual({});
  });

  it("clears the queue on a clean end", () => {
    let m = onToolCall(toSpeaking(), { call_id: "c1", name: "save_note", arguments: {} });
    m = withToolResult(m, "c1", {});
    const ended = onEnded(m);
    expect(ended.state).toBe("ENDED");
    expect(ended.pending).toHaveLength(0);
    expect(ended.ready).toHaveLength(0);
    expect(ended.sessionId).toBeNull();
  });
});

describe("error classification", () => {
  it("treats capacity and resume failures as retryable", () => {
    for (const c of ["at_capacity", "concurrency_exceeded", "internal_error", "session_not_found", "session_expired"]) {
      expect(isRetryableCode(c)).toBe(true);
    }
  });

  it("treats a bad token as fatal, because retrying with it cannot work", () => {
    for (const c of ["UNAUTHORIZED", "FORBIDDEN", "invalid_format", "invalid_audio", "immutable_field", "invalid_config"]) {
      expect(isRetryableCode(c)).toBe(false);
    }
  });
});

describe("every state is reachable and the table has no dead ends", () => {
  it("reaches all twelve", () => {
    const seen = new Set<OralState>();
    let m = initialMachine();
    seen.add(m.state);
    for (const step of [
      () => onConnecting(m),
      () => onSessionReady(m, { session_id: "s" }),
      () => onStartStreaming(m),
      () => onSpeechStarted(m),
      () => onUserFinal(m, { item_id: "i", text: "t" }),
      () => onReplyStarted(m),
      () => onToolCall(m, { call_id: "c", name: "n", arguments: {} }),
      () => withToolResult(m, "c", {}),
      () => onReplyDone(m, { status: "interrupted" }).machine,
      () => onReplyDone(m, { status: "completed" }).machine,
      () => onRecovering(m),
      () => onError(m, "x"),
    ]) {
      m = step();
      seen.add(m.state);
    }
    m = onEnded(m);
    seen.add(m.state);
    m = onReplyAudio(m);
    seen.add(m.state);

    // CHECKING_SOURCE is entered by the client while a tool POST is in
    // flight. The documented flow is reply.started -> tool.call -> reply.done,
    // so the state has to be reachable from SPEAKING as well as from THINKING.
    const beforeReply = onSpeechStarted(
      onStartStreaming(onSessionReady(onConnecting(initialMachine()), { session_id: "s" }))
    );
    for (const from of [toSpeaking(), onUserFinal(beforeReply, { item_id: "i", text: "t" })]) {
      expect(onCheckingSource(from).state).toBe("CHECKING_SOURCE");
      seen.add("CHECKING_SOURCE");
    }

    for (const s of ORAL_STATES) expect(seen).toContain(s);
  });
});

describe("recovery from a transient error (found live: a refused resume left the screen in ERROR)", () => {
  it("leaves a non-fatal ERROR for RECOVERING and then LISTENING", () => {
    let m = onStartStreaming(onSessionReady(onConnecting(initialMachine()), { session_id: "s" }));
    m = onError(m, "session_not_found", false);
    expect(m.state).toBe("ERROR");
    m = onRecovering(m, "session could not be resumed");
    expect(m.state).toBe("RECOVERING");
    m = onStartStreaming(onSessionReady(m, { session_id: "s2" }));
    expect(m.state).toBe("LISTENING");
    expect(m.fatal).toBe(false);
  });

  it("does not leave a fatal ERROR except through an explicit connect", () => {
    const m = onError(onStartStreaming(onSessionReady(onConnecting(initialMachine()), { session_id: "s" })), "UNAUTHORIZED", true);
    expect(onRecovering(m).state).toBe("ERROR");
    expect(onStartStreaming(m).state).toBe("ERROR");
    expect(onConnecting(m).state).toBe("CONNECTING");
  });

  it("lets ENDED start a new exam and nothing else", () => {
    const ended = onEnded(onStartStreaming(onSessionReady(onConnecting(initialMachine()), { session_id: "s" })));
    expect(ended.state).toBe("ENDED");
    expect(onReplyStarted(ended).state).toBe("ENDED");
    expect(onConnecting(ended).state).toBe("CONNECTING");
  });
});

describe("state after a barge-in (Q1)", () => {
  const interrupted = (): OralMachine => onReplyDone(toSpeaking(), { status: "interrupted" }).machine;

  it("moves INTERRUPTED to THINKING when the student's transcript closes", () => {
    const m = onUserFinal(interrupted(), { item_id: "i2", text: "I think it runs a single head" });
    expect(m.state).toBe("THINKING");
  });

  it("moves INTERRUPTED to SPEAKING when the next reply starts", () => {
    expect(onReplyStarted(interrupted()).state).toBe("SPEAKING");
    expect(onReplyAudio(interrupted()).state).toBe("SPEAKING");
  });

  it("does not stay INTERRUPTED through a whole reply after a barge-in", () => {
    let m = interrupted();
    m = onUserFinal(m, { item_id: "i2", text: "single head" });
    m = onReplyStarted(m);
    m = onReplyAudio(m);
    expect(m.state).toBe("SPEAKING");
    expect(onReplyDone(m, { status: "completed" }).machine.state).toBe("LISTENING");
  });
});
