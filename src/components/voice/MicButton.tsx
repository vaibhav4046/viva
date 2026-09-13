"use client";

import { useCallback, useEffect, useId, useImperativeHandle, useRef, useState, type Ref } from "react";
import { AnimatePresence, m, useReducedMotion } from "motion/react";
import { AlertCircle, Mic, Send, Square } from "lucide-react";
import { logEvent } from "@/lib/analytics";
import { EXIT, GENTLE, SNAPPY, SPRING } from "@/lib/motion";
import { MAX_CLIP_MS, startCapture, warmDictation, type CaptureHandle } from "@/lib/audio/worklet";
import { cleanupNote, voiceMessage } from "@/lib/audio/messages";
import { ownsSpace } from "@/lib/audio/shortcut";
import { emptyBurst, foldBurst, type BurstState, type TextOrigin } from "@/lib/audio/burst";
import { keytermsFor } from "@/components/mirror";
import { EMPTY_LIVE, LIVE_ASR_MODE, openTranscriptSocket, type LiveState, type TranscriptSocket } from "@/lib/audio/stream";
import { LiveTranscript } from "@/components/voice/LiveTranscript";

/**
 * The mic. Hold Space or hold the button on a pointer device, tap to toggle on
 * a touch one (holding is unreliable on phones). Release transcribes, and the
 * transcript comes back editable rather than committed, because a study note
 * you cannot correct is worse than no note.
 *
 * States: idle -> listening -> transcribing -> review -> thinking -> idle.
 * `thinking` is owned by the parent through `busy`, since it is the tutor's
 * turn, not the mic's.
 *
 * Typed input sits underneath and always works: voice is the hero here, never
 * a requirement. That box also watches for text arriving in one burst, which
 * is how a system dictation app pastes, and tags the turn accordingly.
 */

/** Same shape `TypedInput` exposed, so the "Try saying…" chips keep working. */
export type TypedHandle = {
  prefill: (text: string) => void;
};

export type VoiceTurn = {
  /** What the learner sends: the edited text if they touched it. */
  text: string;
  /** Exactly what was said, before any tidying. */
  verbatim: string;
  /** The tidied version, or the same string when there was nothing to tidy. */
  clean: string;
  origin: "voice" | "typed" | "external-dictation";
  confidence: number | null;
  requestTimeMs: number | null;
  audioMs: number | null;
  sessionId: string | null;
  /** Whether the words came back from Dictation or the Sync fallback. */
  asrMode: string | null;
  /** The Dictation error code that forced the Sync fallback, when one did.
   *  Carried on the turn so the conversation footer can say "backup path"
   *  rather than the vendor name alone, long after the review panel is gone.
   *  Optional so a synthetic turn (a suggestion chip) need not spell it out. */
  fellBackFrom?: string | null;
  /** Why no tidied version came back, when none did. Carried so the footer can
   *  say which of the three reasons it was, long after the panel is gone. */
  llmError?: string | null;
  edited: boolean;
};

type Phase = "idle" | "listening" | "transcribing" | "review";

type TranscribeResponse = {
  verbatim: string;
  clean: string;
  confidence: number | null;
  requestTimeMs: number | null;
  audioMs: number | null;
  sessionId: string | null;
  /** "dictation" or "sync" — which endpoint actually answered. */
  mode: string;
  /** Set when Dictation failed and Sync answered instead, so a downgrade is
   *  visible on screen rather than only in the JSON. */
  fellBackFrom: string | null;
  llmError: string | null;
};

/**
 * How long the review box waits before committing on its own.
 *
 * 1.5 s flat was a bet that the learner had already read the box, and on a long
 * clip it is not one: a 115 s hold came back as 1495 characters, which nobody
 * reads in a second and a half. The window is now the time it takes to skim
 * what is actually in the box — 50 ms a character, about 20 characters a second
 * or 240 words a minute — floored at the old 1.5 s so a one-line answer still
 * feels immediate, and past a point abandoned entirely: a clip that needs more
 * than twelve seconds of reading is one the learner should send themselves.
 */
const AUTOSEND_MS = 1500;
const READ_MS_PER_CHAR = 50;
const AUTOSEND_MAX_MS = 12_000;

/** The delay for this much text, or null when it must not send itself at all. */
export function autosendDelay(chars: number): number | null {
  const needed = chars * READ_MS_PER_CHAR;
  if (needed > AUTOSEND_MAX_MS) return null;
  return Math.max(AUTOSEND_MS, needed);
}

/** What the chip says: which path answered, and how long it took upstream. */
type PathFacts = { fellBackFrom: string | null; requestTimeMs: number | null };

/**
 * Automatic is first and is the default on purpose.
 *
 * Naming a single language pins the streaming model: `language_code=en` runs
 * `universal-3-5-pro`, which holds every word unsettled until the end of the
 * turn, so the live transcript arrives in ~1.2 s lumps and its settle
 * animation never fires per word. `multi` runs the multilingual model, which
 * finalises words one at a time about every 250-400 ms. A student who never
 * opens this menu should get the better of the two, and anyone who wants their
 * language pinned can still say so.
 */
export const LANGUAGE_PRESETS: { value: string; label: string }[] = [
  { value: "multi", label: "Automatic" },
  { value: "en", label: "English" },
  { value: "en,hi", label: "English + Hindi" },
  { value: "hi", label: "Hindi" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "pt", label: "Portuguese" },
  { value: "it", label: "Italian" },
  { value: "nl", label: "Dutch" },
  { value: "ja", label: "Japanese" },
  { value: "zh", label: "Chinese" },
  { value: "ko", label: "Korean" },
  { value: "ar", label: "Arabic" },
  { value: "ur", label: "Urdu" },
  { value: "ru", label: "Russian" },
  { value: "tr", label: "Turkish" },
  { value: "pl", label: "Polish" },
  { value: "uk", label: "Ukrainian" },
  { value: "vi", label: "Vietnamese" },
];

function langKey(subjectId: string): string {
  return `viva.lang.${subjectId}`;
}

export function MicButton({
  subjectId,
  onSubmit,
  busy = false,
  context = [],
  onPhaseChange,
  onLevel,
  onAnalyser,
  typedHandleRef,
}: {
  subjectId: string;
  onSubmit: (turn: VoiceTurn) => void;
  /** True while the tutor is answering: the mic shows "Thinking…" and locks. */
  busy?: boolean;
  /** Recent turns, newest last. Sent as recognition context, capped server-side. */
  context?: string[];
  onPhaseChange?: (phase: Phase | "thinking") => void;
  /** Live RMS 0..1 while listening — for the orb on the page behind this. */
  onLevel?: (level: number) => void;
  /**
   * The AnalyserNode this capture already runs for its own level meter, so a
   * visualiser can read real frequency bands instead of a single scalar. Null
   * on teardown. Nothing opens a second microphone for it.
   */
  onAnalyser?: (node: AnalyserNode | null) => void;
  /** Lets a page drop a suggestion into the typed box. */
  typedHandleRef?: Ref<TypedHandle>;
}) {
  const reduced = useReducedMotion() ?? false;
  const fieldId = useId();

  const [phase, setPhase] = useState<Phase>("idle");
  const [level, setLevel] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TranscribeResponse | null>(null);
  const [lastPath, setLastPath] = useState<PathFacts | null>(null);
  const [tab, setTab] = useState<"clean" | "verbatim">("clean");
  const [draft, setDraft] = useState("");
  const [edited, setEdited] = useState(false);
  // "multi", not "en": naming a language pins the streaming model, and the
  // English one holds every word unsettled until the end of the turn. See
  // LANGUAGE_PRESETS. A saved choice below still overrides this.
  const [languages, setLanguages] = useState(LANGUAGE_PRESETS[0].value);
  const [holdToTalk, setHoldToTalk] = useState(true);

  const typedRef = useRef<HTMLInputElement>(null);
  const typedLenRef = useRef(0);
  const [live, setLive] = useState<LiveState>(EMPTY_LIVE);
  /**
   * Why the live words stopped, when they do.
   *
   * Separate from `error` on purpose. `error` means the turn failed; this
   * means only the live picture failed while the recording carries on to the
   * buffered path, which is the transcript that actually counts. Showing
   * VOICE_MESSAGES' "Try again in a moment" here would tell a learner to
   * abandon a clip that is about to succeed.
   */
  const [liveNote, setLiveNote] = useState<string | null>(null);
  /**
   * The streamed words, offered back after the buffered clip failed.
   *
   * Not the same transcript and never presented as one — see LIVE_ASR_MODE.
   * But the learner watched these words appear, and dropping them on the floor
   * because the POST died means re-saying a sentence that is already in hand.
   */
  const [recovered, setRecovered] = useState<string | null>(null);
  /**
   * The same live state as `live`, readable synchronously. `transcribe` is a
   * callback that must not re-create itself every time a word lands, so it
   * cannot close over the state variable.
   */
  const liveRef = useRef<LiveState>(EMPTY_LIVE);
  const captureRef = useRef<CaptureHandle | null>(null);
  const socketRef = useRef<TranscriptSocket | null>(null);
  const startingRef = useRef(false);
  const burstRef = useRef<BurstState>(emptyBurst());
  const typedOriginRef = useRef<TextOrigin>("typed");
  const autosendRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    onPhaseChange?.(busy ? "thinking" : phase);
  }, [phase, busy, onPhaseChange]);

  useImperativeHandle(typedHandleRef, () => ({
    prefill(text: string) {
      const el = typedRef.current;
      if (!el) return;
      el.value = text;
      typedLenRef.current = text.length;
      burstRef.current = emptyBurst();
      el.focus();
    },
  }), []);

  // Hold-to-talk needs a pointer that can be held down. A phone cannot reliably
  // deliver pointerup after a long press, so touch gets tap-to-toggle instead.
  useEffect(() => {
    setHoldToTalk(window.matchMedia("(hover: hover) and (pointer: fine)").matches);
  }, []);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(langKey(subjectId));
      if (saved && LANGUAGE_PRESETS.some((p) => p.value === saved)) setLanguages(saved);
    } catch {
      // Private mode or blocked storage: automatic detection is a fine default.
    }
  }, [subjectId]);

  const cancelAutosend = useCallback(() => {
    if (autosendRef.current) {
      clearTimeout(autosendRef.current);
      autosendRef.current = null;
    }
  }, []);

  useEffect(() => () => {
    cancelAutosend();
    captureRef.current?.cancel();
    void socketRef.current?.close();
  }, [cancelAutosend]);

  const send = useCallback(
    (turn: VoiceTurn) => {
      cancelAutosend();
      setPhase("idle");
      setResult(null);
      setDraft("");
      setEdited(false);
      onSubmit(turn);
    },
    [cancelAutosend, onSubmit]
  );

  const transcribe = useCallback(
    async (wav: ArrayBuffer, durationMs: number) => {
      setPhase("transcribing");
      const body = new FormData();
      body.append("audio", new Blob([wav], { type: "audio/wav" }), "clip.wav");
      body.append("subjectId", subjectId);
      body.append("mode", "study");
      body.append("languageCodes", languages);
      // Only for a subject the student built: the server resolves its own, and
      // a resolved subject always wins over this hint.
      const hinted = keytermsFor(subjectId);
      if (hinted.length) body.append("keyterms", JSON.stringify(hinted));
      if (context.length) body.append("context", context.slice(-6).join("\n"));
      const startedAt = performance.now();
      try {
        // Every step here can throw something that is NOT ours: fetch rejects
        // with "Failed to fetch" offline, res.json() rejects with a SyntaxError
        // on a platform gateway page or an empty body. The old code let those
        // Error messages reach setError, which put a JavaScript parse error
        // inside the learner's mic alert. Nothing leaves this function except a
        // code, and voiceMessage owns every sentence on screen.
        let res: Response;
        try {
          res = await fetch("/api/voice/transcribe", { method: "POST", body });
        } catch {
          throw { code: "NETWORK_DOWN" };
        }
        const data = (await res.json().catch(() => null)) as (TranscribeResponse & { error?: { code?: string } }) | null;
        if (!res.ok) throw { code: data?.error?.code };
        // A 200 whose body never parsed is a truncated response, not a result.
        if (!data || typeof data.verbatim !== "string") throw { code: "BAD_RESPONSE" };
        // An empty transcript is a dead end, not a result: the review box would
        // show nothing, disable Send and promise to send anyway. The route codes
        // this as NO_SPEECH; this guard keeps a future provider that answers
        // 200-with-nothing from re-opening the same trap.
        if (!data.verbatim.trim()) throw { code: "NO_SPEECH" };
        // The round trip, not the clip length. This event is what any latency
        // claim is derived from, so it has to measure release-to-transcript;
        // it used to log durationMs, which is the length of whatever the
        // learner said — 5 to 30 seconds of pure error in every figure.
        const facts = {
          latencyMs: Math.round(performance.now() - startedAt),
          audioMs: data.audioMs ?? durationMs,
          requestTimeMs: data.requestTimeMs ?? 0,
          mode: data.mode,
          fellBackFrom: data.fellBackFrom ?? "",
        };
        logEvent("dictation_completed", facts);
        // …and it goes somewhere readable. The in-tab counters die with the tab,
        // which made the whole event unverifiable: metrics only, no transcript,
        // fire and forget.
        void fetch("/api/voice/telemetry", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(facts),
          keepalive: true,
        }).catch(() => {});
        setResult(data);
        // Which path served the clip outlives the review panel on purpose: the
        // panel is gone ~1.5 s after the transcript lands, and a downgrade to
        // the backup path is the one fact about a turn that nothing else on
        // screen says.
        setLastPath({ fellBackFrom: data.fellBackFrom ?? null, requestTimeMs: data.requestTimeMs ?? null });
        setDraft(data.clean || data.verbatim);
        setTab(data.clean && data.clean !== data.verbatim ? "clean" : "verbatim");
        setEdited(false);
        setPhase("review");
      } catch (e) {
        logEvent("dictation_failed");
        setError(voiceMessage((e as { code?: string })?.code));
        // The clip is lost; the words the socket already painted are not. They
        // were on screen a second ago, so throwing them away costs the learner
        // the whole sentence over a failure that did not touch them.
        const streamed = liveRef.current.text.trim();
        if (streamed) {
          setRecovered(streamed);
          setEdited(false);
        }
        setPhase("idle");
      }
    },
    [context, languages, subjectId]
  );

  const stop = useCallback(async () => {
    const capture = captureRef.current;
    if (!capture) return;
    // The close is not awaited: it waits for the server's own Termination to
    // release the session slot politely, and the button must not hold the
    // learner there. The buffered POST below is the transcript that counts;
    // the streamed words were only ever the live picture.
    void socketRef.current?.close();
    socketRef.current = null;
    captureRef.current = null;
    try {
      const { wav, durationMs } = await capture.stop();
      await transcribe(wav, durationMs);
    } catch (e) {
      const code = (e as { code?: string })?.code;
      setError(voiceMessage(code));
      setPhase("idle");
    } finally {
      setLevel(0);
      onLevel?.(0);
      setElapsed(0);
    }
  }, [onLevel, transcribe]);

  const start = useCallback(async () => {
    if (busy || startingRef.current || captureRef.current || phase === "transcribing") return;
    startingRef.current = true;
    setError(null);
    setResult(null);
    logEvent("dictation_started");
    try {
      // One microphone feeds both paths. The socket takes each frame as the
      // worklet produces it; the same frames are buffered into the clip the
      // POST sends. Opening a second capture for the socket meant two
      // getUserMedia calls and two AudioWorklets on one device, which crashed
      // the renderer. Started from the gesture, never an effect, so
      // StrictMode cannot open two sockets on one mic.
      setLive(EMPTY_LIVE);
      setLiveNote(null);
      setRecovered(null);
      liveRef.current = EMPTY_LIVE;
      const socket = openTranscriptSocket({
        language: languages,
        onState: (next) => {
          liveRef.current = next;
          setLive(next);
        },
        // Without this the entire error path in stream.ts was unreachable from
        // the UI: PROVIDER_BUSY, the terminal-not-retried policy for 1008, all
        // of VOICE_MESSAGES. Verified against the deployment by filling the
        // account's concurrency cap — the socket got a real 1008 and the
        // screen said nothing at all.
        onError: (message) => setLiveNote(message),
      });
      socketRef.current = socket;
      const capture = await startCapture({
        onLevel: (l) => {
          setLevel(l);
          onLevel?.(l);
        },
        onElapsed: setElapsed,
        onCapReached: () => void stop(),
        onFrame: (frame) => socket.send(frame),
        onAnalyser,
      });
      captureRef.current = capture;
      setPhase("listening");
    } catch (e) {
      const code = (e as { code?: string })?.code;
      // The mic failed, so the socket has nothing to carry.
      void socketRef.current?.close();
      socketRef.current = null;
      setError(voiceMessage(code));
      setPhase("idle");
    } finally {
      startingRef.current = false;
    }
  }, [busy, languages, onAnalyser, onLevel, phase, stop]);

  // Hold Space anywhere on the page, as long as nothing focusable owns it.
  useEffect(() => {
    // Hold-Space belongs to the page, not to whatever happens to be focused:
    // see src/lib/audio/shortcut.ts for what this used to break.
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat || ownsSpace(e.target, document.body)) return;
      e.preventDefault();
      warmDictation();
      void start();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space" || ownsSpace(e.target, document.body)) return;
      e.preventDefault();
      void stop();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [start, stop]);

  // Auto-send once the learner stops editing. Any keystroke restarts the clock,
  // and Send is always there for someone who does not want to wait.
  useEffect(() => {
    if (phase !== "review" || busy) return;
    cancelAutosend();
    const delay = autosendDelay(draft.trim().length);
    // Too much to have read: the box stays until the learner presses Send.
    if (delay === null) return cancelAutosend;
    autosendRef.current = setTimeout(() => {
      if (draft.trim()) submitReview();
    }, delay);
    return cancelAutosend;
    // submitReview is stable enough for this: it only reads current render state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, draft, busy, cancelAutosend]);

  function submitReview() {
    if (!result || !draft.trim()) return;
    send({
      text: draft.trim(),
      verbatim: result.verbatim,
      clean: result.clean,
      origin: "voice",
      confidence: result.confidence,
      requestTimeMs: result.requestTimeMs,
      audioMs: result.audioMs,
      sessionId: result.sessionId,
      asrMode: result.mode,
      fellBackFrom: result.fellBackFrom,
      llmError: result.llmError,
      edited,
    });
  }

  /**
   * Send the streamed words after the buffered clip failed.
   *
   * `asrMode` is LIVE_ASR_MODE, not "dictation": these words never went through
   * the Dictation path, carry no cleanup, no `request_time_ms` and no
   * confidence, and the turn footer says so. Offering them mislabelled would be
   * worse than losing them; offering them labelled is better than either.
   */
  function sendRecovered() {
    const text = recovered?.trim();
    if (!text || busy) return;
    setRecovered(null);
    setError(null);
    send({
      text,
      verbatim: text,
      clean: text,
      origin: "voice",
      confidence: null,
      requestTimeMs: null,
      audioMs: null,
      sessionId: null,
      asrMode: LIVE_ASR_MODE,
      fellBackFrom: null,
      llmError: null,
      edited,
    });
  }

  function submitTyped() {
    const el = typedRef.current;
    const text = el?.value.trim() ?? "";
    if (!text || busy) return;
    send({
      text,
      verbatim: text,
      clean: text,
      origin: typedOriginRef.current,
      confidence: null,
      requestTimeMs: null,
      audioMs: null,
      sessionId: null,
      asrMode: null,
      fellBackFrom: null,
      edited: false,
    });
    if (el) el.value = "";
    typedLenRef.current = 0;
    burstRef.current = emptyBurst();
    typedOriginRef.current = "typed";
  }

  /** §4.5: text that lands in one lump was dictated by another tool, not typed. */
  function onTypedInput(value: string) {
    burstRef.current = foldBurst(burstRef.current, value.length - typedLenRef.current, Date.now());
    typedLenRef.current = value.length;
    typedOriginRef.current = burstRef.current.origin;
  }

  const listening = phase === "listening";
  const locked = busy || phase === "transcribing";
  const remaining = Math.max(0, MAX_CLIP_MS - elapsed);
  const showTimer = listening && elapsed > 1000;

  const label = busy
    ? "Thinking…"
    : phase === "transcribing"
      ? "Cleaned by AssemblyAI…"
      : listening
        ? holdToTalk ? "Listening — release" : "Listening — tap to stop"
        : holdToTalk ? "Hold to talk" : "Tap to talk";

  const holdProps = holdToTalk
    ? {
        onPointerDown: (e: React.PointerEvent) => {
          if (e.button !== 0) return;
          warmDictation();
          void start();
        },
        onPointerUp: () => void stop(),
        onPointerLeave: () => { if (listening) void stop(); },
      }
    : {
        onPointerDown: () => {
          if (listening) void stop();
          else {
            warmDictation();
            void start();
          }
        },
      };

  return (
    <div className="w-full">
      <div className="surface-card flex flex-col items-center gap-3 px-6 py-5" aria-live="polite">
        <Waveform level={listening ? level : 0} active={listening} reduced={reduced} />

        <div className="relative">
          {listening && !reduced && (
            <m.span
              aria-hidden
              className="pointer-events-none absolute inset-0 rounded-full"
              style={{ border: "1px solid var(--color-cognition)" }}
              animate={{ scale: [1, 1.35], opacity: [0.5, 0] }}
              transition={{ duration: 1.1, repeat: Infinity, ease: "easeOut" }}
            />
          )}
          <m.button
            type="button"
            {...holdProps}
            disabled={locked}
            aria-pressed={listening}
            aria-label={label}
            className="btn-lime relative select-none"
            style={{ minWidth: 208, touchAction: "none" }}
            whileTap={reduced ? undefined : { scale: 0.94 }}
            whileHover={reduced ? undefined : { scale: 1.03 }}
            transition={SNAPPY}
          >
            {listening ? <Square size={15} aria-hidden /> : <Mic size={15} aria-hidden />}
            {label}
          </m.button>
        </div>

        {/* Below the button, never above it. Above, a growing transcript slid
            the control 114 px down and out from under a held pointer, which
            fires onPointerLeave and stops the capture mid-sentence. */}
        {listening && (
          <div className="w-full space-y-1">
            <LiveTranscript committed={live.committed} words={live.words} listening className="w-full" />
            {liveNote ? (
              <p className="mono text-xs leading-relaxed" style={{ color: "var(--color-band-getting)" }}>
                {liveNote}
              </p>
            ) : null}
          </div>
        )}

        <p className="mono" style={{ color: "var(--color-ash)" }}>
          {showTimer
            ? `${Math.ceil(remaining / 1000)}s left`
            : holdToTalk
              ? "Hold SPACE or the button and think out loud"
              : "Tap and think out loud"}
        </p>

        {/* Name the path at rest, not only after a clip lands.
            Measured across the deployed app: "AssemblyAI" appeared on the
            landing page and on no other screen, so anyone who declines the
            microphone and types — which is most first-time visitors, and
            every judge without a headset — never saw what transcribes them.
            Before a clip it states what will handle the audio; after one it
            states what did, with the time the provider actually spent. */}
        {phase !== "review" && (
          <div className="flex items-center gap-2">
            <span className="mono" style={{ color: "var(--color-ash)" }}>
              {lastPath ? "Last clip" : "Your voice goes to"}
            </span>
            {lastPath ? (
              <PathChip fellBackFrom={lastPath.fellBackFrom} requestTimeMs={lastPath.requestTimeMs} />
            ) : (
              <span className="chip" title="Speech is transcribed by the AssemblyAI Dictation API, server-side">
                AssemblyAI Dictation
              </span>
            )}
          </div>
        )}

        <label className="sr-only" htmlFor={`${fieldId}-lang`}>Spoken language</label>
        <select
          id={`${fieldId}-lang`}
          value={languages}
          disabled={listening}
          onChange={(e) => {
            setLanguages(e.target.value);
            try {
              window.localStorage.setItem(langKey(subjectId), e.target.value);
            } catch {
              // Nothing to do: the choice just will not survive a reload.
            }
          }}
          className="chip"
          style={{ background: "var(--color-graphite)", color: "var(--color-paper)", minHeight: 32 }}
        >
          {LANGUAGE_PRESETS.map((p) => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
        </select>

        <AnimatePresence initial={false}>
          {phase === "review" && result && (
            <m.div
              key="review"
              className="w-full"
              initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8 }}
              animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0 }}
              exit={{ opacity: 0, transition: EXIT }}
              transition={SPRING}
            >
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="inline-flex rounded-full p-0.5" style={{ background: "var(--color-panel)" }} role="group" aria-label="Transcript version">
                  {(["clean", "verbatim"] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      aria-pressed={tab === t}
                      onClick={() => {
                        setTab(t);
                        setDraft(t === "clean" ? result.clean : result.verbatim);
                        setEdited(false);
                      }}
                      className="mono rounded-full px-3 py-1"
                      style={{
                        minHeight: 32,
                        background: tab === t ? "var(--color-cognition)" : "transparent",
                        color: tab === t ? "var(--color-obsidian)" : "var(--color-ash)",
                      }}
                    >
                      {t === "clean" ? "Clean" : "Verbatim"}
                    </button>
                  ))}
                </div>
                <PathChip fellBackFrom={result.fellBackFrom} requestTimeMs={result.requestTimeMs} />
              </div>

              <label className="sr-only" htmlFor={`${fieldId}-draft`}>Your words, editable before sending</label>
              <textarea
                id={`${fieldId}-draft`}
                value={draft}
                rows={3}
                autoFocus
                onChange={(e) => {
                  setDraft(e.target.value);
                  setEdited(true);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    submitReview();
                  }
                }}
                className="w-full resize-none rounded-lg border hairline px-3 py-2 text-sm"
                style={{ background: "var(--color-obsidian)", color: "var(--color-paper)" }}
              />
              <div className="mt-2 flex items-center justify-between gap-2">
                {/* Two facts, and the second one is the one that changed:
                    a box that will not send itself has to say so, or the
                    learner sits waiting for a commit that is never coming. */}
                <span className="mono" style={{ color: "var(--color-ash)" }}>
                  {[
                    cleanupNote(result.llmError),
                    autosendDelay(draft.trim().length) === null
                      ? "Read it over and press Send."
                      : "Sends on its own in a moment.",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                </span>
                <button type="button" className="btn-lime !py-2" onClick={submitReview} disabled={!draft.trim() || busy}>
                  <Send size={14} aria-hidden />
                  Send
                </button>
              </div>
            </m.div>
          )}
        </AnimatePresence>

        <AnimatePresence initial={false}>
          {error && (
            <m.p
              key={error}
              role="alert"
              className="w-full rounded-lg border px-3 py-2 text-sm"
              style={{ borderColor: "var(--color-cognition)", color: "var(--color-paper)" }}
              initial={reduced ? { opacity: 0 } : { opacity: 0, y: 4 }}
              animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0 }}
              exit={{ opacity: 0, transition: EXIT }}
              transition={GENTLE}
            >
              <AlertCircle size={14} aria-hidden className="mr-1 inline align-[-2px]" />
              {error}{" "}
              <button type="button" className="underline" onClick={() => { setError(null); void start(); }}>
                Try again
              </button>
            </m.p>
          )}
        </AnimatePresence>

        {/* The clip died; the words did not.
            Measured: killing /api/voice/** at t+3 s of a hold gave the right
            sentence and full recovery, and threw away a complete streamed
            transcript that was on screen at that moment. It is offered back
            here — labelled as the live words, never as the Dictation
            transcript, and never auto-sent: this is a salvage, so the learner
            decides. */}
        <AnimatePresence initial={false}>
          {recovered !== null && (
            <m.div
              key="recovered"
              className="w-full rounded-lg border hairline px-3 py-3"
              style={{ background: "var(--color-panel)" }}
              initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8 }}
              animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0 }}
              exit={{ opacity: 0, transition: EXIT }}
              transition={SPRING}
            >
              <p className="mono text-xs leading-relaxed" style={{ color: "var(--color-mist)" }}>
                These are the live words from while you spoke, not the cleaned
                transcript. Send them as they are, edit them, or hold the mic
                again.
              </p>
              <label className="sr-only" htmlFor={`${fieldId}-recovered`}>
                The live words, editable before sending
              </label>
              <textarea
                id={`${fieldId}-recovered`}
                value={recovered}
                rows={3}
                onChange={(e) => {
                  setRecovered(e.target.value);
                  setEdited(true);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    sendRecovered();
                  }
                }}
                className="mt-2 w-full resize-none rounded-lg border hairline px-3 py-2 text-sm"
                style={{ background: "var(--color-obsidian)", color: "var(--color-paper)" }}
              />
              <div className="mt-2 flex items-center justify-end gap-2">
                <button
                  type="button"
                  className="btn-ghost !py-2"
                  onClick={() => setRecovered(null)}
                >
                  Discard
                </button>
                <button
                  type="button"
                  className="btn-lime !py-2"
                  onClick={sendRecovered}
                  disabled={!recovered.trim() || busy}
                >
                  <Send size={14} aria-hidden />
                  Send these words
                </button>
              </div>
            </m.div>
          )}
        </AnimatePresence>
      </div>

      {/* HYDRATION INVARIANT — uncontrolled on purpose. This box is
          server-rendered, so a student can type into it before React hydrates;
          a controlled `value` reconciles an empty string over the live DOM node
          and silently wipes what they wrote. The DOM owns the value and submit
          reads it off the ref. See tests/typed-input.test.ts for the same
          guarantee on the standalone TypedInput. */}
      <div className="mt-3 flex gap-2">
        <label htmlFor="viva-type" className="sr-only">Type instead of speaking</label>
        {/* The long placeholder needed 241 px in a 224 px box and rendered as
            "Or type — voice is never requir". The reassurance is the one line a
            student in a library actually needs, so the full sentence moved under
            the row where it has room to be read; the font stays at 16 px. */}
        <input
          id="viva-type"
          ref={typedRef}
          type="text"
          autoComplete="off"
          defaultValue=""
          disabled={busy}
          onInput={(e) => onTypedInput(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submitTyped(); } }}
          placeholder={busy ? "Thinking…" : "Or type instead"}
          className="min-h-11 w-full min-w-0 rounded-lg border hairline px-4 py-3 text-base disabled:opacity-60"
          style={{ background: "var(--color-panel)", color: "var(--color-paper)" }}
        />
        <button type="button" onClick={submitTyped} disabled={busy} aria-label="Send what you typed" className="btn-ghost shrink-0 !px-4">
          <Send size={16} aria-hidden />
          Send
        </button>
      </div>
      <p className="mono mt-2 text-xs" style={{ color: "var(--color-ash)" }}>
        Voice is never required — typing works on every screen.
      </p>
    </div>
  );
}

/**
 * Which path transcribed the clip.
 *
 * Not gated on the request time any more: a Sync answer that carries no
 * `request_time_ms` is exactly the case a downgrade label exists for, and
 * gating on the number meant that case rendered nothing at all. The ms are
 * shown when they exist and left out when they do not.
 */
function PathChip({ fellBackFrom, requestTimeMs }: PathFacts) {
  if (!fellBackFrom && requestTimeMs === null) return null;
  return (
    <span className="chip" title="Which path transcribed this clip, and the time AssemblyAI spent on it">
      {fellBackFrom ? "AssemblyAI · backup path" : "AssemblyAI"}
      {requestTimeMs === null ? "" : ` · ${Math.round(requestTimeMs)} ms`}
    </span>
  );
}

/** 24 bars, scaleY only, so the whole thing stays on the compositor. */
function Waveform({ level, active, reduced }: { level: number; active: boolean; reduced: boolean }) {
  const bars = 24;
  return (
    <div className="flex h-8 items-end gap-[3px]" aria-hidden>
      {Array.from({ length: bars }, (_, i) => {
        // A fixed profile scaled by the live level: taller in the middle, so a
        // quiet room still reads as a waveform rather than a flat line.
        const shape = 0.35 + 0.65 * Math.sin((Math.PI * (i + 1)) / (bars + 1));
        const target = active ? Math.max(0.08, Math.min(1, shape * (0.25 + level * 1.6))) : 0.12;
        return (
          <m.span
            key={i}
            className="w-[3px] rounded-full"
            style={{
              height: 26,
              transformOrigin: "50% 100%",
              background: active ? "var(--color-cognition)" : "var(--color-slate)",
            }}
            animate={{ scaleY: reduced ? (active ? 0.5 : 0.12) : target }}
            transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 300, damping: 24, mass: 0.5 }}
          />
        );
      })}
    </div>
  );
}
