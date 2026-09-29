import { voiceMessage } from "@/lib/audio/messages";

/**
 * Microphone in, agent speech out, at the Voice Agent's 24 kHz.
 *
 * Two AnalyserNodes, one on each direction, are what the waveform on screen
 * reads. They are the actual signal — there is no animation loop that draws a
 * wave when nothing is playing, so a flat line means silence, and a line that
 * moves means sound is moving.
 */

export const AGENT_RATE = 24_000;

export type Playback = { play: (b64: string) => void; flush: () => void; close: () => void };

export type AudioHandle = {
  playback: Playback;
  /** Called with each ~100 ms Int16 frame from the worklet. */
  onFrame: (fn: (frame: Int16Array) => void) => void;
  /** Fill `out` with the current time-domain samples (0..255, 128 = silence). */
  readMic: (out: Uint8Array) => void;
  readAgent: (out: Uint8Array) => void;
  stop: () => Promise<void>;
};

function b64ToPcm(b64: string): Int16Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
}

/**
 * Playback that a barge-in can cut.
 *
 * Every chunk is scheduled against the audio clock and tracked, so `flush()`
 * stops all of it at once. A queue of already-decoded audio that keeps playing
 * after the user interrupts would be a barge-in in name only.
 */
function createPlayback(ctx: AudioContext, sink: AudioNode): Playback {
  let nextAt = 0;
  let scheduled: AudioBufferSourceNode[] = [];
  let closed = false;
  return {
    play(b64) {
      if (closed) return;
      try {
        const pcm = b64ToPcm(b64);
        if (pcm.length === 0) return;
        const buffer = ctx.createBuffer(1, pcm.length, AGENT_RATE);
        const ch = buffer.getChannelData(0);
        for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
        const node = ctx.createBufferSource();
        node.buffer = buffer;
        node.connect(sink);
        const at = Math.max(ctx.currentTime, nextAt);
        node.start(at);
        nextAt = at + buffer.duration;
        scheduled.push(node);
        node.onended = () => {
          scheduled = scheduled.filter((n) => n !== node);
        };
      } catch {
        // One malformed chunk costs a syllable, not the review.
      }
    },
    flush() {
      for (const n of scheduled) {
        try {
          n.stop();
          n.disconnect();
        } catch {
          // Already stopped.
        }
      }
      scheduled = [];
      nextAt = 0;
    },
    close() {
      closed = true;
      this.flush();
    },
  };
}

/**
 * Must be called from a user gesture: the AudioContext has to be created (or
 * resumed) inside the click, or the browser suspends it and the worklet never
 * runs.
 */
export async function openAudio(): Promise<AudioHandle> {
  if (typeof window === "undefined" || !navigator.mediaDevices?.getUserMedia) throw new Error(voiceMessage("NO_MIC"));

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch {
    throw new Error(voiceMessage("MIC_BLOCKED"));
  }

  const ctx = new AudioContext({ sampleRate: AGENT_RATE });
  let torn = false;
  let node: AudioWorkletNode | null = null;
  const teardown = () => {
    if (torn) return;
    torn = true;
    node?.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    playback.close();
    void ctx.close().catch(() => {});
  };

  const micAnalyser = ctx.createAnalyser();
  micAnalyser.fftSize = 1024;
  const agentAnalyser = ctx.createAnalyser();
  agentAnalyser.fftSize = 1024;
  agentAnalyser.connect(ctx.destination);
  const playback = createPlayback(ctx, agentAnalyser);

  try {
    await ctx.audioWorklet.addModule("/worklets/pcm16.js");
  } catch {
    teardown();
    throw new Error(voiceMessage("NO_WORKLET"));
  }
  if (ctx.state === "suspended") await ctx.resume().catch(() => {});

  let frameFn: (frame: Int16Array) => void = () => {};
  const source = ctx.createMediaStreamSource(stream);
  node = new AudioWorkletNode(ctx, "pcm16-24k", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  node.port.onmessage = (e: MessageEvent<{ type: string; frame?: Int16Array }>) => {
    if (e.data.type === "pcm" && e.data.frame) frameFn(e.data.frame);
  };
  // The worklet only runs while its output reaches the destination. The chain
  // ends in a muted gain so the user's own voice is not played back into the
  // room and heard again as an interruption.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  source.connect(micAnalyser);
  source.connect(node);
  node.connect(mute);
  mute.connect(ctx.destination);

  // Losing the microphone mid-review (unplugged headset, revoked permission)
  // is an error the user should hear about, not a silent dead session.
  return {
    playback,
    onFrame: (fn) => {
      frameFn = fn;
    },
    readMic: (out) => micAnalyser.getByteTimeDomainData(out as Uint8Array<ArrayBuffer>),
    readAgent: (out) => agentAnalyser.getByteTimeDomainData(out as Uint8Array<ArrayBuffer>),
    async stop() {
      try {
        node?.port.postMessage("flush");
        await new Promise((r) => setTimeout(r, 60));
      } catch {
        // A wedged worklet must not block the exit.
      }
      teardown();
    },
  };
}
