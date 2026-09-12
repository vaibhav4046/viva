/**
 * Microphone capture for VIVA. Browser-only.
 *
 * getUserMedia -> AudioWorklet ("/worklets/pcm16.js") -> Int16 frames at 16 kHz
 * -> a WAV on release. MediaRecorder is deliberately not used: it produces
 * WebM/Opus, and the Dictation endpoint answers 415 to anything compressed.
 *
 * The AudioContext is only ever constructed inside `start()`, which callers
 * invoke from a pointer or key event, so it is never created outside a user
 * gesture (browsers suspend one that is).
 */

import { int16ToWav, MAX_MS, MIN_MS, TARGET_RATE } from "./wav";

export type CaptureError = { code: string; message: string };

export type Capture = {
  /** Latest RMS level, 0..1, for the waveform and the orb. */
  onLevel?: (level: number) => void;
  /** Elapsed milliseconds, ~10 Hz, for the ring timer. */
  onElapsed?: (ms: number) => void;
  /** Fired when the 120 s cap stops the recording on its own. */
  onCapReached?: () => void;
};

export type CaptureHandle = {
  /** Resolves with the finished clip, or rejects with a CaptureError. */
  stop(): Promise<{ wav: ArrayBuffer; durationMs: number }>;
  /** Tear down without producing a clip (navigation, cancel, error). */
  cancel(): void;
  readonly startedAt: number;
};

export const MAX_CLIP_MS = MAX_MS;

function captureError(code: string, message: string): CaptureError {
  return { code, message };
}

/** Worklet frames arrive as `{type:"pcm", frame}`; the last one after "flush". */
type WorkletMessage = { type: "pcm"; frame: Int16Array } | { type: "done" };

/**
 * Ask the dictation service to spin up before the audio arrives. Fire and
 * forget on pointer-down: a cold start costs more than this request does.
 */
export function warmDictation(): void {
  void fetch("/api/voice/warm", { method: "GET", cache: "no-store" }).catch(() => {});
}

export async function startCapture(opts: Capture = {}): Promise<CaptureHandle> {
  if (typeof window === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw captureError("NO_MIC", "This browser will not give VIVA a microphone. Type instead.");
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch {
    throw captureError("MIC_BLOCKED", "Microphone access is blocked. Allow it in the browser bar, or type instead.");
  }

  const ctx = new AudioContext();
  const frames: Int16Array[] = [];
  let closed = false;
  let raf = 0;
  let capTimer: ReturnType<typeof setTimeout> | undefined;
  let tickTimer: ReturnType<typeof setInterval> | undefined;
  let node: AudioWorkletNode | null = null;

  const teardown = () => {
    if (closed) return;
    closed = true;
    if (raf) cancelAnimationFrame(raf);
    if (capTimer) clearTimeout(capTimer);
    if (tickTimer) clearInterval(tickTimer);
    node?.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close().catch(() => {});
  };

  try {
    await ctx.audioWorklet.addModule("/worklets/pcm16.js");
  } catch {
    teardown();
    throw captureError("NO_WORKLET", "This browser could not start the microphone. Type instead.");
  }

  const source = ctx.createMediaStreamSource(stream);
  node = new AudioWorkletNode(ctx, "pcm16", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  node.port.onmessage = (e: MessageEvent<WorkletMessage>) => {
    if (e.data.type === "pcm") frames.push(e.data.frame);
  };

  // A worklet is only pulled while its output reaches the destination, so the
  // chain has to terminate there — through a muted gain, or the microphone
  // would be played back into the room.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  source.connect(node);
  node.connect(mute);
  mute.connect(ctx.destination);

  // Level metering is a separate branch: an AnalyserNode is cheaper and
  // smoother for the UI than deriving RMS from the PCM frames.
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const meter = new Float32Array(analyser.fftSize);
  if (opts.onLevel) {
    const tick = () => {
      if (closed) return;
      analyser.getFloatTimeDomainData(meter);
      let sum = 0;
      for (let i = 0; i < meter.length; i++) sum += meter[i] * meter[i];
      const rms = Math.sqrt(sum / meter.length);
      // Speech RMS sits around 0.02-0.2; scale so a normal voice fills the bars.
      opts.onLevel?.(Math.min(1, rms * 4));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }

  const startedAt = Date.now();
  if (opts.onElapsed) {
    tickTimer = setInterval(() => opts.onElapsed?.(Date.now() - startedAt), 100);
  }

  let stopped: Promise<{ wav: ArrayBuffer; durationMs: number }> | null = null;

  const stop = (): Promise<{ wav: ArrayBuffer; durationMs: number }> => {
    if (stopped) return stopped;
    stopped = new Promise((resolve, reject) => {
      if (closed || !node) {
        reject(captureError("NO_AUDIO", "Nothing was recorded. Hold the mic and speak."));
        return;
      }
      const port = node.port;
      // The worklet answers "done" once it has posted the partial final frame;
      // a timeout keeps a wedged worklet from hanging the button forever.
      let settled = false;
      const finish = () => {
        if (settled) return; // the guard and the "done" reply race by design
        settled = true;
        clearTimeout(guard);
        teardown();
        const samples = frames.reduce((n, f) => n + f.length, 0);
        const durationMs = Math.round((samples / TARGET_RATE) * 1000);
        if (durationMs < MIN_MS) {
          reject(captureError("AUDIO_TOO_SHORT", "That was too short. Hold a little longer and speak."));
          return;
        }
        resolve({ wav: int16ToWav(frames, TARGET_RATE), durationMs });
      };
      const guard = setTimeout(finish, 250);
      port.onmessage = (e: MessageEvent<WorkletMessage>) => {
        if (e.data.type === "pcm") frames.push(e.data.frame);
        else finish();
      };
      port.postMessage("flush");
    });
    return stopped;
  };

  // 120 s is the endpoint's hard ceiling; stopping ourselves turns a 413 into
  // a finished clip the learner still gets to send.
  capTimer = setTimeout(() => opts.onCapReached?.(), MAX_CLIP_MS);

  return { startedAt, stop, cancel: teardown };
}
