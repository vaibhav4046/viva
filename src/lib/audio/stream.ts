/**
 * Live streaming transcription over AssemblyAI Universal-Streaming v3.
 *
 * The hold-to-talk path in ./worklet.ts buffers the whole clip and posts it on
 * release, so nothing appears until the learner stops speaking. This module is
 * the other half: the same AudioWorklet, but every frame goes straight out over
 * a WebSocket and words come back while the sentence is still being said. The
 * two run side by side — the socket paints the words, the buffered POST still
 * produces the authoritative cleaned transcript — so a socket that fails costs
 * the animation and nothing else.
 *
 * ── The contract, as measured against the live endpoint on 2026-09-12 ──
 *
 * Token:  GET /api/voice/stream-token -> { token, expiresInSeconds }.
 *         The API key stays on the server; the token is a streaming-only
 *         bearer good for one socket.
 *
 * Socket: wss://streaming.assemblyai.com/v3/ws
 *           ?token=…&encoding=pcm_s16le&sample_rate=16000&format_turns=true
 *           &language_code=…
 *         Audio frames go out as raw binary Int16 LE. Everything received is a
 *         JSON text frame.
 *
 * Messages actually observed, in order:
 *   Begin         { id, expires_at, configuration:{ model, mode, … } }
 *                 `configuration.model` is the server's last word on which
 *                 model you got — see LANGUAGE below, it is not always the one
 *                 you asked for.
 *   SpeechStarted { timestamp, confidence }        (informational)
 *   Turn          { turn_order, transcript, end_of_turn, turn_is_formatted,
 *                   end_of_turn_confidence, utterance,
 *                   words:[{ text, start, end, confidence, word_is_final }] }
 *   Termination   { audio_duration_seconds, session_duration_seconds }
 *   Error         { error_code, error }            (then the socket closes)
 *
 * Three things the published contract does not tell you, all of which this
 * module is shaped around:
 *
 * 1. WORD FINALISATION DEPENDS ON THE MODEL. On `universal-3-5-pro` every word
 *    carries `word_is_final:false` for the whole turn and all of them flip to
 *    true in one step at `end_of_turn` — there is no progressive settle to
 *    animate. On the multilingual model words finalise one at a time
 *    (words=3/final=2, then 4/final=3, …), which is the behaviour the UI wants.
 *    Measured partial cadence: ~1.3 s on universal-3-5-pro, ~250-400 ms on
 *    multilingual. Hence the default below.
 *
 * 2. `language_code=multi` SILENTLY SWITCHES THE MODEL. Asking for
 *    `speech_model=universal-3-5-pro&language_code=multi` returns a Begin whose
 *    `configuration.model` is `universal-streaming-multilingual`. That is the
 *    automatic-language-detection path, and it is also (1)'s good behaviour, so
 *    one choice buys both. `speech_model` is therefore not sent at all: naming
 *    a model that `language_code` would override only invites the two to
 *    disagree.
 *
 * 3. A TERMINATED SESSION EMITS ONE LAST EMPTY FINAL TURN.
 *    `{ end_of_turn:true, transcript:"", words:[] }` arrives after Terminate.
 *    Committing it appends a blank turn and, if you read the last word without
 *    checking, throws. `applyTurn` drops it.
 *
 * The account also allows only a small number of concurrent sessions
 * (`error_code 1008, "Too many concurrent sessions"`), and a closed socket
 * takes a few seconds to free its slot. One handle owns one socket, and
 * `close()` waits for Termination rather than yanking the connection.
 */

import { voiceMessage } from "./messages";

/** Must match TARGET_RATE in ./wav and the worklet's own resampling target. */
const SAMPLE_RATE = 16_000;
const WS_BASE = "wss://streaming.assemblyai.com/v3/ws";

// ─────────────────────────────── language ───────────────────────────────

/**
 * The languages the streaming socket accepts, read out of its own validation
 * error rather than a docs page:
 *   "Invalid 'language_code.0': Input should be 'en', 'es', … or 'multi'"
 * Enumerated live 2026-09-12. `multi` is automatic detection / code-switching.
 *
 * Note what is NOT here: `pl` and `uk` are offered by the batch Dictation
 * picker and are not accepted by streaming. `toStreamLanguage` maps them to
 * automatic rather than sending a code the socket will reject.
 */
export const STREAM_LANGUAGES = [
  "en", "es", "de", "fr", "it", "pt", "tr", "nl", "sv", "no", "da", "fi",
  "hi", "vi", "ar", "he", "ja", "ur", "zh", "ru", "ko", "ca", "gl", "ro",
  "et", "fa", "yue", "af", "mr", "zu", "xh", "nn",
] as const;

/** Automatic detection. The default, so a student can just talk. */
export const AUTO_LANGUAGE = "multi";

/**
 * Translate the picker's value into something the socket accepts.
 *
 * The picker is an override, not a requirement: anything it cannot express as
 * a single supported code — a comma pair like "en,hi", a language streaming
 * does not serve, an empty value — becomes automatic detection. Guessing one
 * half of "en,hi" would be worse than detecting, and sending "en,hi" verbatim
 * is a validation error that closes the socket before a word is heard.
 */
export function toStreamLanguage(preset: string | null | undefined): string {
  const value = (preset ?? "").trim().toLowerCase();
  if (!value || value === AUTO_LANGUAGE) return AUTO_LANGUAGE;
  return (STREAM_LANGUAGES as readonly string[]).includes(value) ? value : AUTO_LANGUAGE;
}

export function streamUrl(token: string, language: string): string {
  const q = new URLSearchParams({
    token,
    encoding: "pcm_s16le",
    sample_rate: String(SAMPLE_RATE),
    format_turns: "true",
    language_code: toStreamLanguage(language),
  });
  return `${WS_BASE}?${q}`;
}

// ──────────────────────────── transcript state ───────────────────────────

export type LiveWord = {
  text: string;
  /** `word_is_final`: the model will not revise this one again. */
  final: boolean;
};

export type LiveState = {
  /** Turns the model has closed, oldest first. */
  turns: string[];
  /** `turn_order` of the turn in `words`, or null when between turns. */
  order: number | null;
  /** The turn being spoken right now, partial words included. */
  words: LiveWord[];
  /** Closed turns joined — the part that will not change. */
  committed: string;
  /** Everything, closed and in-flight. What you would send if it stopped now. */
  text: string;
};

export const EMPTY_LIVE: LiveState = Object.freeze({
  turns: [], order: null, words: [], committed: "", text: "",
});

/** A Turn frame, narrowed to the fields this module reads. */
export type TurnMessage = {
  type: "Turn";
  turn_order?: number;
  transcript?: string;
  end_of_turn?: boolean;
  words?: { text?: unknown; word_is_final?: unknown }[];
};

function derive(turns: string[], order: number | null, words: LiveWord[]): LiveState {
  const committed = turns.join(" ");
  const live = words.map((w) => w.text).join(" ");
  return { turns, order, words, committed, text: [committed, live].filter(Boolean).join(" ") };
}

/**
 * Fold one Turn frame into the transcript. Pure — the socket layer and the
 * tests drive the same function, so what the tests prove is what runs.
 */
export function applyTurn(state: LiveState, msg: TurnMessage): LiveState {
  const words: LiveWord[] = (msg.words ?? [])
    .filter((w): w is { text: string; word_is_final?: unknown } => typeof w?.text === "string")
    .map((w) => ({ text: w.text, final: w.word_is_final === true }));

  const transcript = (msg.transcript ?? "").trim();

  if (msg.end_of_turn) {
    const closed = transcript || words.map((w) => w.text).join(" ");
    // The empty final turn that follows Terminate. Committing it would append a
    // blank entry and leave a stray space in `committed` forever.
    if (!closed) return derive(state.turns, null, []);
    return derive([...state.turns, closed], null, []);
  }

  // A new turn_order while one is still open means the model moved on without
  // closing the last one. Keep the words already shown rather than dropping
  // them on the floor: a learner watching their sentence vanish mid-flow reads
  // as a bug, and the buffered POST is the source of truth regardless.
  if (state.order !== null && msg.turn_order !== undefined && msg.turn_order !== state.order) {
    const carried = state.words.map((w) => w.text).join(" ");
    const turns = carried ? [...state.turns, carried] : state.turns;
    return derive(turns, msg.turn_order, words);
  }

  return derive(state.turns, msg.turn_order ?? state.order, words);
}

// ────────────────────────────── the socket ──────────────────────────────

/** The slice of WebSocket this module uses, so a test can supply a fake. */
export type SocketLike = {
  readyState: number;
  send(data: string | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
};

const OPEN = 1;

export type StreamOptions = {
  /** Picker value, or omit for automatic detection. */
  language?: string;
  /** Fires on every transcript change. */
  onState?: (state: LiveState) => void;
  /** One plain sentence, already mapped through voiceMessage. Terminal. */
  onError?: (message: string) => void;
  /** Which model the server actually gave us, from Begin. See note 2 up top. */
  onModel?: (model: string) => void;
  /** Test seams. Both default to the real thing. */
  getToken?: () => Promise<string>;
  openSocket?: (url: string) => SocketLike;
};

export type TranscriptSocket = {
  /** Queue or send one Int16 frame. Safe to call before the socket is open. */
  send(frame: Int16Array): void;
  /** Terminate politely, wait for the server's Termination, then close. */
  close(): Promise<void>;
  readonly state: LiveState;
};

/** Mint a streaming token from our own origin. The key never comes with it. */
export async function mintToken(): Promise<string> {
  let res: Response;
  try {
    res = await fetch("/api/voice/stream-token", { cache: "no-store" });
  } catch {
    throw new Error(voiceMessage("NETWORK_DOWN"));
  }
  const body = (await res.json().catch(() => null)) as
    | { token?: string; error?: { code?: string } }
    | null;
  if (!res.ok || typeof body?.token !== "string") {
    throw new Error(voiceMessage(body?.error?.code));
  }
  return body.token;
}

/**
 * Audio buffered while the socket is still opening.
 *
 * The handshake measured 700-950 ms, which is most of a first word. Dropping
 * those frames means the sentence starts mid-syllable; keeping them unbounded
 * means a socket that never opens grows a buffer for as long as someone talks.
 * Two seconds is the compromise: it covers every handshake measured, and past
 * that the connection is not coming back anyway.
 */
const MAX_PENDING_SAMPLES = SAMPLE_RATE * 2;

/** Give up after this many reconnects; each one costs a token and a handshake. */
const MAX_RECONNECTS = 2;

/**
 * Open the transcript socket. No microphone — audio is whatever the caller
 * sends. `openLiveStream` below wires the mic to it; the tests drive it with a
 * fake socket and hand-written frames.
 */
export function openTranscriptSocket(opts: StreamOptions = {}): TranscriptSocket {
  const getToken = opts.getToken ?? mintToken;
  const openSocket = opts.openSocket ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);

  let state: LiveState = EMPTY_LIVE;
  let socket: SocketLike | null = null;
  let pending: Int16Array[] = [];
  let pendingSamples = 0;
  let reconnects = 0;
  let closing = false;
  let terminated: (() => void) | null = null;

  const emit = (next: LiveState) => {
    state = next;
    opts.onState?.(state);
  };

  const fail = (code: string) => {
    if (closing) return;
    closing = true;
    opts.onError?.(voiceMessage(code));
    terminated?.();
  };

  const flush = () => {
    if (!socket || socket.readyState !== OPEN) return;
    for (const frame of pending) socket.send(frame);
    pending = [];
    pendingSamples = 0;
  };

  const connect = async () => {
    let url: string;
    try {
      url = streamUrl(await getToken(), opts.language ?? AUTO_LANGUAGE);
    } catch (e) {
      if (!closing) {
        closing = true;
        opts.onError?.(e instanceof Error ? e.message : voiceMessage(undefined));
        terminated?.();
      }
      return;
    }
    if (closing) return;

    const ws = openSocket(url);
    socket = ws;

    ws.onopen = () => flush();

    ws.onmessage = (ev) => {
      // `& TurnMessage` narrowed `type` to the literal "Turn", so the switch
      // arms for Begin / Termination / Error were unreachable to the compiler
      // and the file did not typecheck. The frame type is whatever the socket
      // sent; the Turn shape is folded in only on the arm that needs it.
      let msg: Omit<TurnMessage, "type"> & { type?: string; error?: string; configuration?: { model?: string } };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return; // A frame we cannot parse is not worth killing the session over.
      }
      switch (msg.type) {
        case "Begin":
          // Which model answered is worth surfacing: `language_code=multi`
          // swaps it out from under you, and word-settle behaviour follows it.
          if (msg.configuration?.model) opts.onModel?.(msg.configuration.model);
          return;
        case "Turn":
          emit(applyTurn(state, { ...msg, type: "Turn" }));
          return;
        case "Termination":
          terminated?.();
          return;
        case "Error":
          // 1008 is the concurrency cap, and reconnecting only makes it worse.
          fail(String(msg.error ?? "").includes("concurrent") ? "PROVIDER_BUSY" : "TRANSCRIPTION_FAILED");
          return;
        default:
          return; // SpeechStarted, and anything added upstream later.
      }
    };

    ws.onerror = () => {
      // Browsers give no detail here on purpose; onclose carries the code.
    };

    ws.onclose = () => {
      if (closing) {
        terminated?.();
        return;
      }
      // An unasked-for close is a dropped connection or an expired token, and
      // both have the same remedy: a fresh token and a new socket. The
      // transcript so far is kept — a reconnect must not rewind what the
      // learner already watched appear.
      if (reconnects < MAX_RECONNECTS) {
        reconnects += 1;
        socket = null;
        void connect();
        return;
      }
      fail("NETWORK_DOWN");
    };
  };

  void connect();

  return {
    get state() {
      return state;
    },
    send(frame: Int16Array) {
      if (closing) return;
      if (socket && socket.readyState === OPEN) {
        socket.send(frame);
        return;
      }
      // Still connecting, or between sockets on a reconnect.
      pending.push(frame);
      pendingSamples += frame.length;
      while (pendingSamples > MAX_PENDING_SAMPLES && pending.length > 1) {
        pendingSamples -= pending.shift()!.length;
      }
    },
    close() {
      if (closing) return Promise.resolve();
      closing = true;
      const ws = socket;
      if (!ws) return Promise.resolve();
      return new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(guard);
          try {
            ws.close();
          } catch {
            // Already closed by the server; nothing left to do.
          }
          resolve();
        };
        terminated = finish;
        // A session slot on this account is scarce, so the socket is given a
        // moment to shut down cleanly rather than being yanked; if the server
        // does not answer, close anyway rather than hang the mic button.
        const guard = setTimeout(finish, 1_500);
        try {
          if (ws.readyState === OPEN) ws.send(JSON.stringify({ type: "Terminate" }));
          else finish();
        } catch {
          finish();
        }
      });
    },
  };
}

// ─────────────────────────── microphone + socket ─────────────────────────

export type LiveStreamHandle = {
  /** Stop capture, close the socket, resolve with the final transcript. */
  stop(): Promise<LiveState>;
  /** Tear down without waiting (navigation, error, the other path failing). */
  cancel(): void;
};

/**
 * Microphone straight into the transcript socket.
 *
 * This opens its own AudioContext against the SAME worklet module
 * (`/worklets/pcm16.js`) that ./worklet.ts uses — the resampler, the one piece
 * that is genuinely hard to get right, is shared. It is not shared any further
 * than that because `startCapture` buffers frames privately and exposes no
 * per-frame hook; the honest fix is an `onFrame` callback there, at which point
 * this function collapses into a socket plus one line. Until then the two paths
 * run side by side on one microphone, which is deliberate: the buffered POST
 * still produces the authoritative cleaned transcript, so this failing costs
 * the live words and nothing else.
 */
export async function openLiveStream(opts: StreamOptions = {}): Promise<LiveStreamHandle> {
  if (typeof window === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new Error(voiceMessage("NO_MIC"));
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch {
    throw new Error(voiceMessage("MIC_BLOCKED"));
  }

  const ctx = new AudioContext();
  let torn = false;
  let node: AudioWorkletNode | null = null;
  let socket: TranscriptSocket | null = null;

  const teardown = () => {
    if (torn) return;
    torn = true;
    node?.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close().catch(() => {});
  };

  try {
    await ctx.audioWorklet.addModule("/worklets/pcm16.js");
  } catch {
    teardown();
    throw new Error(voiceMessage("NO_WORKLET"));
  }

  socket = openTranscriptSocket(opts);

  const source = ctx.createMediaStreamSource(stream);
  node = new AudioWorkletNode(ctx, "pcm16", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  node.port.onmessage = (e: MessageEvent<{ type: string; frame?: Int16Array }>) => {
    if (e.data.type === "pcm" && e.data.frame) socket?.send(e.data.frame);
  };

  // The worklet is only pulled while its output reaches the destination, so the
  // chain has to terminate there — through a muted gain, or the microphone
  // would be played back into the room. Same reason as in ./worklet.ts.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  source.connect(node);
  node.connect(mute);
  mute.connect(ctx.destination);

  return {
    async stop() {
      // Flush the worklet's partial frame before closing: the last word of a
      // sentence lives in it, and that is the word the learner is watching for.
      try {
        node?.port.postMessage("flush");
        await new Promise((r) => setTimeout(r, 60));
      } catch {
        // A wedged worklet must not block the close.
      }
      teardown();
      const s = socket;
      if (!s) return EMPTY_LIVE;
      await s.close();
      return s.state;
    },
    cancel() {
      teardown();
      void socket?.close();
    },
  };
}
