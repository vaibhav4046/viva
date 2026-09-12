"use client";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { logEvent } from "@/lib/analytics";
import { blobToWav16kMono } from "@/lib/audio/wav";

export type DictationResult = {
  transcript: string;
  confidence: number | null;
  latencyMs: number;
  provider: string;
  mode?: string;
  audioDurationMs?: number | null;
  requestTimeMs?: number | null;
  sessionId?: string | null;
  timings?: Record<string, number>;
};

/**
 * Push-to-talk: hold Space or hold the mic button. MediaRecorder captures
 * audio/webm; on release the blob goes to /api/dictation/transcribe.
 * Textarea fallback guarantees voice is never required to use VIVA.
 */
export function VoiceButton({
  onResult,
  onState,
  busy = false,
  label = "Hold SPACE and tell VIVA anything",
}: {
  onResult: (r: DictationResult) => void;
  onState?: (s: "idle" | "recording" | "working") => void;
  busy?: boolean;
  label?: string;
}) {
  const [state, setState] = useState<"idle" | "recording" | "working">("idle");
  const [level, setLevel] = useState(0);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const analyserRef = useRef<{ ctx: AudioContext; analyser: AnalyserNode; raf: number } | null>(null);
  const [fallback, setFallback] = useState("");
  const [error, setError] = useState<string | null>(null);

  const set = (s: "idle" | "recording" | "working") => {
    setState(s);
    onState?.(s);
  };

  function stopMeter() {
    const m = analyserRef.current;
    if (m) {
      cancelAnimationFrame(m.raf);
      m.ctx.close().catch(() => {});
      analyserRef.current = null;
    }
    setLevel(0);
  }

  async function start() {
    if (state !== "idle" || busy) return;
    setError(null);
    logEvent("dictation_started");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      // Live meter (UI only).
      try {
        const ctx = new AudioContext();
        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        src.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);
        const tick = () => {
          analyser.getByteFrequencyData(data);
          const avg = data.reduce((a, b) => a + b, 0) / data.length / 255;
          setLevel(Math.min(1, avg * 2.2));
          analyserRef.current!.raf = requestAnimationFrame(tick);
        };
        analyserRef.current = { ctx, analyser, raf: requestAnimationFrame(tick) };
      } catch { /* meter optional */ }
      const rec = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : undefined });
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      rec.onstop = async () => {
        stopMeter();
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
        if (blob.size < 800) { set("idle"); return; } // too short — silent recover
        set("working");
        try {
          // Sync STT accepts WAV/PCM only: encode client-side, no FFmpeg.
          const { wav, durationMs } = await blobToWav16kMono(blob);
          const res = await fetch("/api/dictation/transcribe", {
            method: "POST",
            headers: { "Content-Type": "audio/wav", "X-VIVA-Audio-Duration-Ms": String(durationMs) },
            body: wav,
          });
          const data = await res.json();
          if (!res.ok) throw codedError(res.status, data?.error);
          logEvent("dictation_completed", { latencyMs: data.latencyMs ?? 0 });
          onResult(data);
        } catch (e) {
          logEvent("dictation_failed");
          setError(e instanceof Error ? e.message : "We couldn't transcribe that clip. Your recording wasn't saved. Try again.");
        } finally {
          set("idle");
        }
      };
      recRef.current = rec;
      rec.start();
      set("recording");
    } catch {
      setError("Microphone blocked. Allow mic access in the browser bar, or type below instead — voice is never required.");
      set("idle");
    }
  }

  function stop() {
    const rec = recRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
  }

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.code === "Space" && !e.repeat) { e.preventDefault(); start(); }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") { e.preventDefault(); stop(); }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, busy]);

  function codedError(status: number, errBody?: { code?: string; message?: string }): Error {
    const code = errBody?.code ?? "";
    if (status === 429) return new Error("Too many dictations. Wait a few seconds and try again.");
    if (code === "NO_API_KEY") return new Error("Live voice isn't configured on this deployment. Type below instead — nothing is faked.");
    if (code === "AUDIO_TOO_SHORT") return new Error("That clip was too short — hold a little longer and speak.");
    if (code === "AUDIO_TOO_LONG" || code === "AUDIO_TOO_LARGE") return new Error("That clip was too long — keep dictations under 2 minutes.");
    if (code === "PROVIDER_BUSY") return new Error("Voice service is recovering. Your thought is safe — try again in a moment.");
    return new Error(errBody?.message ?? "We couldn't transcribe that clip. Your recording wasn't saved. Try again.");
  }

  // Typed fallback: hands raw text to the parent, which compiles it ONCE.
  // (Previously this POSTed compile itself AND the parent POSTed again —
  // two Thought Marks per thought. Single writer now: the parent.)
  function submitFallback() {
    if (!fallback.trim() || state !== "idle" || busy) return;
    onResult({ transcript: fallback.trim(), confidence: null, latencyMs: 0, provider: "typed" });
    setFallback("");
  }

  const bars = [0.35, 0.6, 0.9, 0.65, 0.4, 0.75, 0.5, 0.85, 0.55, 0.38, 0.7, 0.48];
  const working = state === "working" || busy;
  return (
    <div className="w-full">
      <div
        className="surface-card flex flex-col items-center gap-3 px-6 py-5"
        aria-live="polite"
        style={state === "recording" ? { borderColor: "var(--color-cognition)" } : undefined}
      >
        <div className="flex h-8 items-end gap-1" aria-hidden>
          {bars.map((b, i) => (
            <span
              key={i}
              className="waveform-bar w-1 rounded-full"
              style={{
                height: `${8 + (state === "recording" ? Math.min(1, b + level) : b * 0.35) * 24}px`,
                background: state === "recording" ? "var(--color-cognition)" : "var(--color-slate)",
                transition: "height 120ms ease",
              }}
            />
          ))}
        </div>
        <button
          type="button"
          onMouseDown={start}
          onMouseUp={stop}
          onMouseLeave={() => { if (state === "recording") stop(); }}
          onTouchStart={start}
          onTouchEnd={stop}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.repeat) { e.preventDefault(); start(); } }}
          onKeyUp={(e) => { if (e.key === "Enter") { e.preventDefault(); stop(); } }}
          disabled={working}
          aria-pressed={state === "recording"}
          aria-label={working ? "Compiling your thought" : state === "recording" ? "Release to stop recording" : "Hold to talk to VIVA"}
          className="btn-lime inline-flex select-none items-center justify-center gap-2"
          style={{ minHeight: 44, minWidth: 200 }}
        >
          <VoiceStateIcon state={working ? "working" : state} />
          {working ? "Compiling…" : state === "recording" ? "Listening — release" : "Hold to talk"}
        </button>
        <p className="text-sm" style={{ color: "var(--color-ash)" }}>{label}</p>        {state === "recording" && <p className="mono text-xs" style={{ color: "var(--color-cognition)" }}>recording · release to submit</p>}
        {working && <p className="mono text-xs" role="status" style={{ color: "var(--color-signal)" }}>transcript → intent → evidence → mastery…</p>}
        {error && (
          <p role="alert" className="w-full rounded-lg border px-3 py-2 text-sm" style={{ color: "var(--color-mist)", borderColor: "var(--color-coral)", background: "rgba(255,107,107,0.06)" }}>
            {error}
          </p>
        )}
      </div>
      <div className="mt-3 flex gap-2">
        <label htmlFor="viva-type" className="sr-only">Type instead of speaking</label>
        <input
          id="viva-type"
          value={fallback}
          disabled={busy}
          onChange={(e) => setFallback(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submitFallback(); }}
          placeholder={busy ? "Compiling…" : "Or type a thought — voice is never required"}
          className="w-full min-w-0 rounded-lg border hairline bg-transparent px-4 py-3 text-sm disabled:opacity-60"
          style={{ background: "var(--color-graphite)" }}
        />
        <button type="button" onClick={submitFallback} disabled={busy} className="btn-ghost shrink-0 !py-2">Send</button>
      </div>
    </div>
  );
}

/**
 * M11 — voice state morph: mic ↔ wave ↔ stop crossfade 220ms + scale
 * 0.96→1 160ms --ease-pop. Transform/opacity only; reduced motion is handled
 * by the surrounding MotionConfig("user") and the global reduced-motion CSS,
 * which collapse both to the final icon instantly.
 */
const MORPH_TRANSITION = {
  opacity: { duration: 0.22, ease: "easeOut" as const },
  scale: { duration: 0.16, ease: [0.34, 1.56, 0.64, 1] as [number, number, number, number] },
};

function VoiceStateIcon({ state }: { state: "idle" | "recording" | "working" }) {
  return (
    <span className="relative inline-flex h-4 w-4 items-center justify-center" aria-hidden>
      <AnimatePresence initial={false}>
        {state === "recording" ? (
          <motion.span
            key="wave"
            className="absolute inset-0 flex items-center justify-center"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={MORPH_TRANSITION}
          >
            <WaveIcon />
          </motion.span>
        ) : state === "working" ? (
          <motion.span
            key="stop"
            className="absolute inset-0 flex items-center justify-center"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={MORPH_TRANSITION}
          >
            <StopIcon />
          </motion.span>
        ) : (
          <motion.span
            key="mic"
            className="absolute inset-0 flex items-center justify-center"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={MORPH_TRANSITION}
          >
            <MicIcon active={false} />
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}

function WaveIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden focusable="false">
      <rect x="3" y="9" width="3" height="6" rx="1.5" fill="currentColor" />
      <rect x="10.5" y="5" width="3" height="14" rx="1.5" fill="currentColor" />
      <rect x="18" y="9" width="3" height="6" rx="1.5" fill="currentColor" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden focusable="false">
      <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" />
    </svg>
  );
}

function MicIcon({ active }: { active: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden focusable="false">
      <rect x="9" y="3" width="6" height="11" rx="3" stroke={active ? "var(--color-obsidian)" : "currentColor"} strokeWidth="2" />
      <path d="M5 11a7 7 0 0 0 14 0" stroke={active ? "var(--color-obsidian)" : "currentColor"} strokeWidth="2" strokeLinecap="round" />
      <path d="M12 18v3" stroke={active ? "var(--color-obsidian)" : "currentColor"} strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
