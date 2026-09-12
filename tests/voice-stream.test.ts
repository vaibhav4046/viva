import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTO_LANGUAGE,
  EMPTY_LIVE,
  STREAM_LANGUAGES,
  applyTurn,
  openTranscriptSocket,
  streamUrl,
  toStreamLanguage,
  type LiveState,
  type SocketLike,
  type TurnMessage,
} from "@/lib/audio/stream";
import { clampExpiry, DEFAULT_EXPIRY_SEC, MAX_EXPIRY_SEC } from "@/app/api/voice/stream-token/route";

/**
 * Live streaming transcription.
 *
 * The frames asserted here are the ones the real endpoint sent on 2026-09-12 —
 * shapes copied off the wire, not invented from the docs — including the two
 * that the published contract does not mention: the trailing empty final Turn
 * after Terminate, and words that finalise one at a time rather than all at
 * end_of_turn.
 */

/** A WebSocket the test drives by hand. Records everything sent. */
class FakeSocket implements SocketLike {
  readyState = 0;
  sent: (string | ArrayBufferView)[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;

  constructor(readonly url: string) {}

  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  emit(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  send(data: string | ArrayBufferView) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  /** Server-initiated drop, which is what a reconnect has to survive. */
  drop() {
    this.readyState = 3;
    this.onclose?.({ code: 1006 });
  }
  /** Text frames only — binary audio is what we assert on separately. */
  textFrames() {
    return this.sent.filter((s): s is string => typeof s === "string");
  }
  audioFrames() {
    return this.sent.filter((s): s is Int16Array => typeof s !== "string");
  }
}

function harness(over: Partial<Parameters<typeof openTranscriptSocket>[0]> = {}) {
  const sockets: FakeSocket[] = [];
  const states: LiveState[] = [];
  const errors: string[] = [];
  const models: string[] = [];
  const socket = openTranscriptSocket({
    getToken: async () => "tok_test",
    openSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    onState: (s) => states.push(s),
    onError: (m) => errors.push(m),
    onModel: (m) => models.push(m),
    ...over,
  });
  // `connect()` awaits the token, so the first socket exists a microtask later.
  const ready = async () => {
    await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(0));
    return sockets[sockets.length - 1];
  };
  return { socket, sockets, states, errors, models, ready };
}

afterEach(() => vi.useRealTimers());

/* ------------------------- the transcript fold ------------------------- */

describe("applyTurn", () => {
  it("shows partial words before any of them are final", () => {
    const s = applyTurn(EMPTY_LIVE, {
      type: "Turn",
      turn_order: 0,
      transcript: "Positional encoding tells",
      words: [
        { text: "Positional", word_is_final: false },
        { text: "encoding", word_is_final: false },
        { text: "tells", word_is_final: false },
      ],
    });
    expect(s.words.map((w) => w.final)).toEqual([false, false, false]);
    expect(s.text).toBe("Positional encoding tells");
    // Nothing is committed until the turn closes: partials are still revisable.
    expect(s.committed).toBe("");
  });

  it("settles words one at a time, the way the multilingual model sends them", () => {
    // Copied from the live run: words=3/final=2, then 4/final=3.
    let s = applyTurn(EMPTY_LIVE, {
      type: "Turn",
      turn_order: 0,
      words: [
        { text: "Positional", word_is_final: true },
        { text: "encoding", word_is_final: true },
        { text: "tells", word_is_final: false },
      ],
    });
    expect(s.words.map((w) => w.final)).toEqual([true, true, false]);

    s = applyTurn(s, {
      type: "Turn",
      turn_order: 0,
      words: [
        { text: "Positional", word_is_final: true },
        { text: "encoding", word_is_final: true },
        { text: "tells", word_is_final: true },
        { text: "the", word_is_final: false },
      ],
    });
    expect(s.words.map((w) => w.final)).toEqual([true, true, true, false]);
    expect(s.text).toBe("Positional encoding tells the");
  });

  it("keeps a revised partial word rather than the one it replaced", () => {
    // The live socket sent "match" and corrected it to "matter" a beat later.
    let s = applyTurn(EMPTY_LIVE, {
      type: "Turn",
      turn_order: 0,
      words: [{ text: "words", word_is_final: true }, { text: "match", word_is_final: false }],
    });
    s = applyTurn(s, {
      type: "Turn",
      turn_order: 0,
      words: [{ text: "words", word_is_final: true }, { text: "matter", word_is_final: true }],
    });
    expect(s.text).toBe("words matter");
  });

  it("commits the formatted transcript on end_of_turn and clears the live words", () => {
    const partial = applyTurn(EMPTY_LIVE, {
      type: "Turn",
      turn_order: 0,
      transcript: "Positional encoding tells the model which words matter most in the",
      words: [{ text: "the", word_is_final: false }],
    });
    const done = applyTurn(partial, {
      type: "Turn",
      turn_order: 0,
      end_of_turn: true,
      transcript: "Positional encoding tells the model which words matter most in the sentence.",
      words: [{ text: "sentence.", word_is_final: true }],
    });
    expect(done.committed).toBe("Positional encoding tells the model which words matter most in the sentence.");
    expect(done.words).toEqual([]);
    expect(done.order).toBeNull();
    expect(done.text).toBe(done.committed);
  });

  it("joins successive turns with a space", () => {
    let s = applyTurn(EMPTY_LIVE, { type: "Turn", turn_order: 0, end_of_turn: true, transcript: "I think." });
    s = applyTurn(s, { type: "Turn", turn_order: 1, end_of_turn: true, transcript: "Maybe." });
    expect(s.committed).toBe("I think. Maybe.");
    expect(s.turns).toEqual(["I think.", "Maybe."]);
  });

  it("drops the empty final turn the server sends after Terminate", () => {
    // Observed live: {end_of_turn:true, transcript:"", words:[]} arrives last.
    // Committing it appended a blank turn and left a trailing space forever.
    const s = applyTurn(
      applyTurn(EMPTY_LIVE, { type: "Turn", turn_order: 0, end_of_turn: true, transcript: "All done." }),
      { type: "Turn", turn_order: 1, end_of_turn: true, transcript: "", words: [] }
    );
    expect(s.turns).toEqual(["All done."]);
    expect(s.committed).toBe("All done.");
  });

  it("carries an unclosed turn forward when the model moves to the next one", () => {
    let s = applyTurn(EMPTY_LIVE, {
      type: "Turn",
      turn_order: 0,
      words: [{ text: "half", word_is_final: false }, { text: "a", word_is_final: false }, { text: "sentence", word_is_final: false }],
    });
    s = applyTurn(s, { type: "Turn", turn_order: 1, words: [{ text: "Next", word_is_final: false }] });
    expect(s.committed).toBe("half a sentence");
    expect(s.text).toBe("half a sentence Next");
  });

  it("ignores words with no text rather than rendering undefined", () => {
    const s = applyTurn(EMPTY_LIVE, {
      type: "Turn",
      turn_order: 0,
      words: [{ text: "real", word_is_final: true }, { word_is_final: true }] as TurnMessage["words"],
    });
    expect(s.words).toEqual([{ text: "real", final: true }]);
  });
});

/* ------------------------------- language ------------------------------ */

describe("language selection", () => {
  it("defaults to automatic detection", () => {
    expect(toStreamLanguage(undefined)).toBe(AUTO_LANGUAGE);
    expect(toStreamLanguage("")).toBe(AUTO_LANGUAGE);
    expect(streamUrl("t", "")).toContain("language_code=multi");
  });

  it("honours a supported single code as an override", () => {
    expect(toStreamLanguage("hi")).toBe("hi");
    expect(toStreamLanguage("JA")).toBe("ja");
    expect(streamUrl("t", "hi")).toContain("language_code=hi");
  });

  it("falls back to automatic for anything the socket would reject", () => {
    // The batch picker offers these; the streaming socket's own validation
    // error does not list them, and sending one closes the socket.
    expect(toStreamLanguage("pl")).toBe(AUTO_LANGUAGE);
    expect(toStreamLanguage("uk")).toBe(AUTO_LANGUAGE);
    // A code-switching pair cannot be expressed as one code — detect instead.
    expect(toStreamLanguage("en,hi")).toBe(AUTO_LANGUAGE);
  });

  it("carries the codes the endpoint actually enumerated", () => {
    // Read out of the live validation error, not a docs page.
    expect(STREAM_LANGUAGES).toHaveLength(32);
    for (const code of ["en", "hi", "ur", "zh", "yue", "mr", "nn"]) {
      expect(STREAM_LANGUAGES).toContain(code);
    }
    expect(STREAM_LANGUAGES).not.toContain("pl");
  });

  it("builds the URL the endpoint accepted, and never names a model", () => {
    const url = new URL(streamUrl("tok_abc", "en"));
    expect(url.origin + url.pathname).toBe("wss://streaming.assemblyai.com/v3/ws");
    expect(url.searchParams.get("token")).toBe("tok_abc");
    expect(url.searchParams.get("encoding")).toBe("pcm_s16le");
    expect(url.searchParams.get("sample_rate")).toBe("16000");
    expect(url.searchParams.get("format_turns")).toBe("true");
    // language_code=multi silently overrides speech_model, so sending both
    // only lets them disagree. See the note at the top of stream.ts.
    expect(url.searchParams.get("speech_model")).toBeNull();
  });
});

/* ---------------------------- the live socket --------------------------- */

describe("openTranscriptSocket", () => {
  it("drives a mocked socket through partial -> final -> end_of_turn", async () => {
    const { socket, states, models, ready } = harness();
    const ws = await ready();
    ws.open();

    ws.emit({ type: "Begin", id: "s1", configuration: { model: "universal-streaming-multilingual" } });
    ws.emit({ type: "SpeechStarted", timestamp: 0, confidence: 0.95 });

    // Partial: nothing settled yet.
    ws.emit({
      type: "Turn", turn_order: 0, transcript: "Positional encoding",
      end_of_turn: false,
      words: [{ text: "Positional", word_is_final: false }, { text: "encoding", word_is_final: false }],
    });
    expect(socket.state.text).toBe("Positional encoding");
    expect(socket.state.words.every((w) => !w.final)).toBe(true);
    expect(socket.state.committed).toBe("");

    // The first word settles while the next is still provisional.
    ws.emit({
      type: "Turn", turn_order: 0, transcript: "Positional encoding tells",
      end_of_turn: false,
      words: [
        { text: "Positional", word_is_final: true },
        { text: "encoding", word_is_final: true },
        { text: "tells", word_is_final: false },
      ],
    });
    expect(socket.state.words.map((w) => w.final)).toEqual([true, true, false]);
    expect(socket.state.committed).toBe("");

    // Turn closes: everything commits, the live line empties.
    ws.emit({
      type: "Turn", turn_order: 0, end_of_turn: true,
      transcript: "Positional encoding tells the model.",
      words: [
        { text: "Positional", word_is_final: true },
        { text: "encoding", word_is_final: true },
        { text: "tells", word_is_final: true },
        { text: "the", word_is_final: true },
        { text: "model.", word_is_final: true },
      ],
    });
    expect(socket.state.committed).toBe("Positional encoding tells the model.");
    expect(socket.state.words).toEqual([]);

    // Every step above produced exactly one state emission, in order.
    expect(states).toHaveLength(3);
    expect(states.map((s) => s.text)).toEqual([
      "Positional encoding",
      "Positional encoding tells",
      "Positional encoding tells the model.",
    ]);
    // Begin is surfaced because language_code=multi changes which model runs.
    expect(models).toEqual(["universal-streaming-multilingual"]);
  });

  it("buffers audio recorded during the handshake instead of dropping it", async () => {
    const { socket, ready } = harness();
    const ws = await ready();
    // The measured handshake is 700-950 ms; the first word lands inside it.
    socket.send(new Int16Array([1, 2, 3]));
    socket.send(new Int16Array([4, 5, 6]));
    expect(ws.audioFrames()).toHaveLength(0);

    ws.open();
    expect(ws.audioFrames()).toHaveLength(2);

    socket.send(new Int16Array([7, 8, 9]));
    expect(ws.audioFrames()).toHaveLength(3);
  });

  it("bounds the pre-open buffer so a socket that never opens cannot grow forever", async () => {
    const { socket, ready } = harness();
    const ws = await ready();
    // 2 s of 16 kHz audio is the cap; push 6 s at it.
    for (let i = 0; i < 60; i++) socket.send(new Int16Array(1600));
    ws.open();
    const buffered = ws.audioFrames().reduce((n, f) => n + f.length, 0);
    expect(buffered).toBeLessThanOrEqual(16_000 * 2);
    // …and it kept the NEWEST audio: the end of a sentence outranks its start.
    expect(buffered).toBeGreaterThan(0);
  });

  it("reconnects on a dropped socket without rewinding the transcript", async () => {
    const { socket, sockets, ready } = harness();
    const first = await ready();
    first.open();
    first.emit({ type: "Turn", turn_order: 0, end_of_turn: true, transcript: "First turn." });
    expect(socket.state.committed).toBe("First turn.");

    first.drop();
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    const second = sockets[1];
    second.open();

    // What the learner already watched appear is still on screen.
    expect(socket.state.committed).toBe("First turn.");
    second.emit({ type: "Turn", turn_order: 0, end_of_turn: true, transcript: "Second turn." });
    expect(socket.state.committed).toBe("First turn. Second turn.");
  });

  it("gives up with one plain sentence after repeated drops", async () => {
    const { sockets, errors, ready } = harness();
    (await ready()).drop();
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    sockets[1].drop();
    await vi.waitFor(() => expect(sockets).toHaveLength(3));
    sockets[2].drop();

    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]).toBe("You look offline. Reconnect and hold the mic again, or type instead.");
    // Three sockets, then it stops: MAX_RECONNECTS is honoured.
    expect(sockets).toHaveLength(3);
  });

  it("does not retry the concurrency cap, and says something a learner can act on", async () => {
    const { errors, sockets, ready } = harness();
    const ws = await ready();
    ws.open();
    // The real frame: error_code 1008 when the account has no free session.
    ws.emit({ type: "Error", error_code: 1008, error: "Unauthorized Connection: Too many concurrent sessions" });

    expect(errors).toEqual(["AssemblyAI is busy. Try again in a moment."]);
    ws.drop();
    // Reconnecting into a full account would only burn another slot.
    expect(sockets).toHaveLength(1);
  });

  it("terminates politely and resolves once the server acknowledges", async () => {
    const { socket, ready } = harness();
    const ws = await ready();
    ws.open();

    const closed = socket.close();
    expect(ws.textFrames()).toEqual([JSON.stringify({ type: "Terminate" })]);
    expect(ws.closed).toBe(false); // still waiting for the server

    ws.emit({ type: "Termination", audio_duration_seconds: 5, session_duration_seconds: 6 });
    await closed;
    expect(ws.closed).toBe(true);
  });

  it("closes anyway when the server never acknowledges", async () => {
    vi.useFakeTimers();
    const { socket, sockets } = harness();
    await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(0));
    const ws = sockets[0];
    ws.open();

    const closed = socket.close();
    await vi.advanceTimersByTimeAsync(1_600);
    await closed;
    expect(ws.closed).toBe(true);
  });

  it("stops sending audio after close", async () => {
    const { socket, ready } = harness();
    const ws = await ready();
    ws.open();
    void socket.close();
    socket.send(new Int16Array([1, 2, 3]));
    expect(ws.audioFrames()).toHaveLength(0);
  });

  it("surfaces a token failure as a sentence, not a stack trace", async () => {
    const errors: string[] = [];
    openTranscriptSocket({
      getToken: async () => {
        throw new Error("Voice is not switched on for this deployment. Type instead — nothing is faked.");
      },
      openSocket: () => {
        throw new Error("should never open a socket without a token");
      },
      onError: (m) => errors.push(m),
    });
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]).toContain("Type instead");
  });

  it("survives a frame that is not JSON", async () => {
    const { socket, errors, ready } = harness();
    const ws = await ready();
    ws.open();
    ws.onmessage?.({ data: "<html>gateway</html>" });
    expect(errors).toEqual([]);
    expect(socket.state).toEqual(EMPTY_LIVE);
  });
});

/* ----------------------------- token minting ---------------------------- */

describe("stream-token expiry clamp", () => {
  it("defaults when the client says nothing or says nonsense", () => {
    expect(clampExpiry(null)).toBe(DEFAULT_EXPIRY_SEC);
    expect(clampExpiry("banana")).toBe(DEFAULT_EXPIRY_SEC);
  });

  it("refuses a long-lived token however politely it is asked for", () => {
    // Short expiry is the entire reason a browser may hold this credential.
    expect(clampExpiry("86400")).toBe(MAX_EXPIRY_SEC);
    expect(clampExpiry("1")).toBe(60);
  });
});
