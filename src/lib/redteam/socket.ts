import { voiceMessage } from "@/lib/audio/messages";

/**
 * The Voice Agent WebSocket client for VIVA RedTeam.
 *
 * This is the third audio path VIVA has, alongside the buffered Dictation POST
 * and the Universal-Streaming transcript socket, and it is the one that makes
 * the product a conversation rather than a recorder. Three notes on why it is
 * separate code and not a mode flag on `stream.ts`:
 *
 *  1. DIFFERENT PRODUCT, DIFFERENT HOST. Universal-Streaming is
 *     `streaming.assemblyai.com/v3/ws` and takes a streaming-only token. Voice
 *     Agent is `agents.assemblyai.com/v1/ws` and takes its own token from its
 *     own endpoint. Folding them together would mean a token route that could
 *     mint the wrong credential, which is a security bug wearing a refactor's
 *     clothes.
 *
 *  2. DIFFERENT AUDIO RATE. Streaming wants 16 kHz; Voice Agent wants 24 kHz.
 *     One resampler serves both (see `processorOptions` in
 *     `/worklets/pcm16.js`) but the frame rate is chosen per node, never
 *     negotiated.
 *
 *  3. IT SPEAKS. So it needs a playback path, an interruption path, and a
 *     state machine, none of which the transcript socket has. The transcript
 *     socket is a firehose of words; this one has to be interrupted mid-word.
 *
 * ── The protocol contract, read from the official events reference ──────
 *
 *   connect -> session.update (or session.resume) -> session.ready
 *     -> input.audio * { base64 PCM16 mono 24 kHz }
 *     <- input.speech.started / transcript.user.delta / input.speech.stopped
 *     <- transcript.user
 *     <- reply.started / reply.audio { base64 } / transcript.agent.delta
 *     <- transcript.agent { interrupted }
 *     <- reply.done { status: "completed" | "interrupted" }
 *     <- tool.call { call_id, name, arguments }
 *        ... and tool.result goes HERE, on reply.done, not on tool.call ...
 *     <- session.ended
 *
 * The one rule that is easy to get wrong, and that the existing tests exist to
 * pin: `tool.result` is sent when `reply.done` is the latest event received.
 * Replying the instant `tool.call` arrives is a protocol error. And when
 * `reply.done` carries `status: "interrupted"`, any pending tool results from
 * that reply must be discarded — the student has already moved on.
 *
 * Both of those decisions live in `@/lib/redteam/machine.ts`, which is pure. This
 * file is the I/O around it, and it does no protocol thinking of its own.
 */

import {
  initialMachine,
  isRetryableCode,
  onCheckingSource,
  onConnecting,
  onEnded,
  onError,
  onRecovering,
  onReplyAudio,
  onReplyDone,
  onReplyStarted,
  onSessionReady,
  onSpeechStarted,
  onStartStreaming,
  onToolCall,
  onUserDelta,
  onUserFinal,
  withToolResult,
  type VoiceMachine,
  type QueuedResult,
} from "@/lib/redteam/machine";

/** The Voice Agent host, per the docs. Not the streaming host. */
const WS_BASE = "wss://agents.assemblyai.com/v1/ws";

/** The API's input format. Not a preference: the STT model is tuned for it. */
export const VOICE_SAMPLE_RATE = 24_000;

/**
 * Roughly 100 ms of audio per frame. The API raises `audio_rate_violation` if
 * frames arrive faster than real time, and a 32-frame buffer is generous
 * enough to absorb a GC pause without ever getting ahead of the clock.
 */
const FRAME_SAMPLES = 2400;
const MAX_PENDING_FRAMES = 32;

export function voiceAgentUrl(token: string): string {
  return `${WS_BASE}?token=${encodeURIComponent(token)}`;
}

/** Int16 PCM -> base64, without pulling in a dependency for it. */
export function pcm16ToBase64(frame: Int16Array): string {
  // A copy into a fresh ArrayBuffer: the worklet transfers the frame's buffer
  // to us, and a view over a transferred buffer is detached. String.fromCharCode
  // is applied in slices because its argument list is a stack argument — one
  // 4096-character call, not one argument per sample.
  const bytes = new Uint8Array(frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength));
  let binary = "";
  for (let i = 0; i < bytes.length; i += 4096) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 4096));
  }
  return btoa(binary);
}

export type VoiceSocketOptions = {
  /** The session config from /api/oral/session, minus the fields the socket owns. */
  config: {
    system_prompt: string;
    greeting: string;
    tools: unknown[];
    keyterms?: string[];
    language_codes?: string[];
    transcription_mode?: string;
    turn_detection?: Record<string, unknown>;
  };
  /** Spoken instead of the greeting when a dropped session cannot be resumed. */
  reconnectGreeting?: string;
  /** The service reported `reply.done` with status "interrupted". Fired after playback is flushed. */
  onInterrupted?: () => void;
  /** Optional session settings were refused and the session was retried without them. */
  onDegraded?: (level: 1 | 2, note: string) => void;
  /** Mint a fresh token. Called before EVERY connection, per the docs. */
  getToken: () => Promise<string>;
  /** Run one tool on our server. Resolves with the JSON-ready result. */
  runTool: (name: string, args: Record<string, unknown>, callId: string) => Promise<unknown>;
  openSocket?: (url: string) => WebSocket;
  /** Play one base64 PCM16 chunk. Injected so tests need no AudioContext. */
  playAudio?: (chunk: string) => void;
  /** Drop everything queued for playback. Required on interruption. */
  flushAudio?: () => void;
  onState: (m: VoiceMachine) => void;
  onTranscript?: (text: string, speaker: "user" | "agent", interrupted?: boolean) => void;
  onError?: (message: string) => void;
  /** Fired when the session stops for good, for the report. */
  onEnded?: (summary: { turns: number; toolCalls: number; interruptions: number; discards: number }) => void;
};

export type VoiceSocket = {
  readonly machine: () => VoiceMachine;
  /** One 24 kHz Int16 frame from the microphone. */
  sendAudio: (frame: Int16Array) => void;
  /** Clean exit: session.end, then session.ended, then close. */
  end: () => Promise<void>;
  /** Tear down without a clean teardown (navigation, unmount). */
  cancel: () => void;
};

/** Codes meaning "a field you sent in session.update is not acceptable". */
const CONFIG_REFUSED = new Set(["invalid_config", "invalid_value", "invalid_format"]);
const RESUME_REFUSED = new Set(["session_not_found", "session_forbidden", "session_expired"]);

/** Map a protocol error code to a sentence a person can act on. */
function errorSentence(code: string): string {
  switch (code) {
    case "UNAUTHORIZED":
    case "FORBIDDEN":
      return "Voice sign-in failed. Reload the page and try again.";
    case "at_capacity":
    case "concurrency_exceeded":
      return "VIVA is busy right now. Try again in a moment.";
    case "session_not_found":
    case "session_expired":
      return "That exam session expired. Starting a new one.";
    case "audio_rate_violation":
      return "The microphone is running too fast for the connection. Type instead.";
    case "invalid_config":
    case "immutable_field":
    case "invalid_value":
      return "VIVA could not set up the exam audio. Reload the page.";
    case "invalid_audio":
      return "The microphone sent audio VIVA could not read. Type instead.";
    default:
      return voiceMessage("NETWORK_DOWN");
  }
}

export function openVoiceSocket(opts: VoiceSocketOptions): VoiceSocket {
  const openSocket = opts.openSocket ?? ((url: string) => new WebSocket(url));
  const playAudio = opts.playAudio;
  const flushAudio = opts.flushAudio;

  let m: VoiceMachine = initialMachine();
  let socket: WebSocket | null = null;
  let pending: string[] = [];
  /**
   * True only between `session.ready` and the socket going away.
   *
   * The gate is this flag rather than `readyState === OPEN`, because a socket
   * can be open for the whole 700-950 ms handshake and the API rejects audio
   * sent in that window. Checking readyState alone is the bug this line
   * prevents, and it is a subtle one: the frames are not obviously early, they
   * just arrive before the session can accept them.
   */
  let sessionLive = false;
  let cancelled = false;
  let ending = false;
  let finished = false;
  let resumeId: string | null = null;
  let sawEnded = false;
  let resumeTimer: ReturnType<typeof setTimeout> | undefined;
  /** 0 = every optional field, 1 = VAD threshold only, 2 = none. See `sessionBody`. */
  let configLevel: 0 | 1 | 2 = 0;
  let everReady = false;

  const publish = () => opts.onState(m);

  /**
   * Audio leaves only after `session.ready`, never on open.
   *
   * The API is explicit: "Start sending input.audio only after this event."
   * A socket being open is not the same as a session being ready, and flushing
   * on `onopen` puts the first frames in a window the server rejects —
   * `invalid_format` at best, a dropped call at worst. The handshake measured
   * 700-950 ms on the streaming socket, so buffering across it is the cost of
   * being correct, and `sendAudio` bounds the buffer.
   */
  const flushPending = () => {
    const ws = socket;
    if (!ws || pending.length === 0) return;
    for (const audio of pending) {
      try {
        ws.send(JSON.stringify({ type: "input.audio", audio }));
      } catch {
        // A dead socket is onclose's problem; the rest of the buffer is the
        // resume's problem, not this connection's.
        break;
      }
    }
    pending = [];
  };

  /**
   * The `session.update` payload at the current degrade level.
   *
   * The optional input fields (turn-detection windows, keyterms, language,
   * transcription mode) are the ones whose exact accepted spellings the service
   * has surprised us on before. A refusal before `session.ready` therefore
   * retries with fewer of them rather than ending the review: level 1 keeps
   * only the VAD threshold and keyterms, level 2 sends none. Barge-in itself
   * does not depend on any of them: it is the service's default behaviour.
   */
  /**
   * Let go of the current socket on purpose. It is unhooked BEFORE it is
   * closed, so its own `onclose` sees a socket that is no longer ours and does
   * nothing. Closing first ran that handler against the live state and turned
   * a routine settings retry into a fatal error.
   */
  const retire = () => {
    const old = socket;
    socket = null;
    sessionLive = false;
    try {
      old?.close();
    } catch {
      // Already closing.
    }
  };

  const sessionBody = () => {
    const c = opts.config;
    const input: Record<string, unknown> = { format: { encoding: "audio/pcm" } };
    if (configLevel === 0) {
      if (c.keyterms?.length) input.keyterms = c.keyterms;
      if (c.turn_detection) input.turn_detection = c.turn_detection;
      if (c.transcription_mode) input.transcription_mode = c.transcription_mode;
      if (c.language_codes?.length) input.language_codes = c.language_codes;
    } else if (configLevel === 1) {
      if (c.keyterms?.length) input.keyterms = c.keyterms;
      const vad = c.turn_detection?.vad_threshold;
      if (typeof vad === "number") input.turn_detection = { vad_threshold: vad };
    }
    return {
      system_prompt: c.system_prompt,
      greeting: everReady && opts.reconnectGreeting ? opts.reconnectGreeting : c.greeting,
      input,
      output: { voice: "alba", format: { encoding: "audio/pcm" }, volume: 100 },
      tools: c.tools,
    };
  };

  const connect = async (mode: "fresh" | "resume") => {
    if (cancelled) return;
    // The docs are explicit that a fresh token is needed immediately before
    // each connection attempt, and that a resumed session can still come back
    // `session_forbidden`. Reusing the old token is how a reconnect turns into
    // a confusing 1008.
    let url: string;
    try {
      url = voiceAgentUrl(await opts.getToken());
    } catch {
      m = onError(m, "token", true);
      publish();
      opts.onError?.(voiceMessage("NO_API_KEY"));
      return;
    }
    if (cancelled) return;

    m = onConnecting(m);
    publish();

    let ws: WebSocket;
    try {
      ws = openSocket(url);
    } catch {
      // `new WebSocket` throws synchronously on a blocked origin. That throw
      // used to be the one failure with no message on screen at all.
      m = onRecovering(m, "socket refused");
      publish();
      opts.onError?.(errorSentence("network"));
      return;
    }
    socket = ws;

    ws.onopen = () => {
      if (mode === "resume" && resumeId) {
        // session.resume is the first message on a resumed connection, and
        // session.update is the first message on a fresh one. Never both.
        ws.send(JSON.stringify({ type: "session.resume", session_id: resumeId }));
        return;
      }
      ws.send(JSON.stringify({ type: "session.update", session: sessionBody() }));
    };

    ws.onmessage = (ev) => {
      // A socket we already replaced (config retry, resume) has no say.
      if (ws !== socket) return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String((ev as MessageEvent).data)) as Record<string, unknown>;
      } catch {
        return; // An unparseable frame is not worth killing an exam over.
      }
      handle(msg);
    };

    ws.onerror = () => {
      // Browsers give nothing useful here by design; onclose carries the code.
    };

    ws.onclose = (ev) => {
      if (ws !== socket) return;
      // A closed socket has no live session, whatever the state machine says.
      // Frames arriving now go to the buffer for the resume.
      sessionLive = false;
      if (cancelled || ending || m.state === "IDLE" || m.state === "ENDED") return;
      if (sawEnded) {
        finish();
        return;
      }
      // The 30-second grace window is the whole point of keeping resumeId.
      // Past it, the session is unrecoverable and a fresh one is the honest
      // outcome — the conversation is not silently "resumed" from nothing.
      if (resumeId) {
        m = onRecovering(m, `socket closed ${ev.code}`);
        publish();
        resumeTimer = setTimeout(() => {
          resumeId = null;
          m = onRecovering(m, "grace window expired");
          publish();
          void connect("fresh");
        }, 25_000);
        void connect("resume");
        return;
      }
      m = onError(m, `socket closed ${ev.code}`, true);
      publish();
      opts.onError?.(errorSentence("network"));
    };
  };

  const handle = (msg: Record<string, unknown>) => {
    switch (msg.type) {
      case "session.ready": {
        resumeId = typeof msg.session_id === "string" ? msg.session_id : null;
        everReady = true;
        if (resumeTimer) clearTimeout(resumeTimer);
        m = onSessionReady(m, { session_id: resumeId ?? undefined, resume_token: (msg.resume_token as string) ?? null });
        // Only now may audio go out; the API rejects input.audio before ready.
        sessionLive = true;
        m = onStartStreaming(m);
        publish();
        flushPending();
        return;
      }
      case "session.updated":
        return;
      case "input.speech.started":
        m = onSpeechStarted(m);
        publish();
        return;
      case "input.speech.stopped":
        return;
      case "transcript.user.delta":
        // The text is the FULL transcript so far for this item. It replaces
        // rather than appends; concatenating produces a garbled transcript
        // that looks like a recognition failure and is not one.
        m = onUserDelta(m, { item_id: msg.item_id as string, text: msg.text as string });
        publish();
        return;
      case "transcript.user": {
        m = onUserFinal(m, { item_id: msg.item_id as string, text: msg.text as string });
        publish();
        opts.onTranscript?.(String(msg.text ?? ""), "user");
        return;
      }
      case "reply.started":
        m = onReplyStarted(m);
        publish();
        return;
      case "reply.audio":
        m = onReplyAudio(m);
        publish();
        playAudio?.(String(msg.data ?? ""));
        return;
      case "transcript.agent.delta":
        return;
      case "transcript.agent": {
        const interrupted = msg.interrupted === true;
        opts.onTranscript?.(String(msg.text ?? ""), "agent", interrupted);
        return;
      }
      case "reply.done": {
        const status = msg.status === "interrupted" ? "interrupted" : "completed";
        if (status === "interrupted") {
          // The protocol is explicit: flush playback first, then drop anything
          // queued for the reply that just died.
          flushAudio?.();
        }
        const { machine, send } = onReplyDone(m, { status, reply_id: msg.reply_id as string });
        m = machine;
        publish();
        if (status === "interrupted") opts.onInterrupted?.();
        for (const r of send) deliver(r);
        return;
      }
      case "tool.call": {
        m = onToolCall(m, msg);
        m = onCheckingSource(m);
        publish();
        void runTool(msg);
        return;
      }
      case "session.ended": {
        sawEnded = true;
        finish();
        return;
      }
      case "session.error": {
        const code = String(msg.code ?? "session.error");
        // A refusal of our optional settings before the session ever came up:
        // retry with fewer of them instead of ending the review.
        if (!everReady && CONFIG_REFUSED.has(code) && configLevel < 2) {
          configLevel = (configLevel + 1) as 1 | 2;
          opts.onDegraded?.(configLevel, `${code}${typeof msg.param === "string" ? ` (${msg.param})` : ""}`);
          retire();
          void connect("fresh");
          return;
        }
        // A resume the service will not honour (expired, unknown, not ours)
        // becomes a fresh session, and the ledger on our server carries on.
        if (RESUME_REFUSED.has(code) && resumeId) {
          resumeId = null;
          if (resumeTimer) clearTimeout(resumeTimer);
          retire();
          void connect("fresh");
          return;
        }
        // The server closes after most of these, so the socket is left to
        // onclose; recording the reason here is what the diagnostics panel
        // shows and what decides fatal vs retryable.
        m = onError(m, code, !isRetryableCode(code));
        publish();
        if (!isRetryableCode(code)) opts.onError?.(errorSentence(code));
        return;
      }
      default:
        return;
    }
  };

  const deliver = (r: QueuedResult) => {
    const ws = socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ type: "tool.result", call_id: r.callId, result: r.result, is_error: r.isError }));
    } catch {
      // A result that cannot be sent is the end of that turn's tool work; the
      // machine has already dropped it from the queue.
    }
  };

  const runTool = async (msg: Record<string, unknown>) => {
    const callId = String(msg.call_id ?? "");
    const name = String(msg.name ?? "");
    const args = (msg.arguments ?? {}) as Record<string, unknown>;
    try {
      const result = await opts.runTool(name, args, callId);
      m = withToolResult(m, callId, result);
    } catch {
      m = withToolResult(m, callId, { error: "That check could not be run." }, true);
    }
    publish();
  };

  const finish = () => {
    if (cancelled || finished) return;
    // Idempotent on purpose. A clean teardown delivers `session.ended` and
    // then closes, so both the event handler and `onclose` reach here; without
    // the guard the report fired twice and the screen counted one exam as two.
    finished = true;
    const summary = {
      turns: m.turns,
      toolCalls: m.toolCalls,
      interruptions: m.interruptions,
      discards: m.discards,
    };
    m = onEnded(m);
    publish();
    opts.onEnded?.(summary);
  };

  void connect("fresh");

  return {
    machine: () => m,
    sendAudio(frame) {
      if (cancelled || ending) return;
      const audio = pcm16ToBase64(frame);
      const ws = socket;
      if (sessionLive && ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: "input.audio", audio }));
        } catch {
          // Dropped: better a dropped frame than a thrown exception inside the
          // audio callback, which browsers treat as a processor failure.
        }
        return;
      }
      pending.push(audio);
      // Bounded, so a socket that never opens cannot grow this without limit.
      while (pending.length > MAX_PENDING_FRAMES) pending.shift();
    },
    async end() {
      if (cancelled || ending) return;
      ending = true;
      if (resumeTimer) clearTimeout(resumeTimer);
      const ws = socket;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        finish();
        return;
      }
      // session.end short-circuits the 30-second grace window and stops billing.
      // Just closing would hold a billable session for every exam that ended.
      ws.send(JSON.stringify({ type: "session.end" }));
      await new Promise<void>((resolve) => {
        let done = false;
        const settle = () => {
          if (done) return;
          done = true;
          clearTimeout(guard);
          try {
            ws.close();
          } catch {
            // Already closed by the server.
          }
          finish();
          resolve();
        };
        const guard = setTimeout(settle, 2_500);
        ws.addEventListener("close", settle, { once: true });
      });
    },
    cancel() {
      cancelled = true;
      if (resumeTimer) clearTimeout(resumeTimer);
      const ws = socket;
      try {
        ws?.close();
      } catch {
        // Nothing to do.
      }
    },
  };
}
