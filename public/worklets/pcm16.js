/**
 * pcm16 — AudioWorklet that turns the microphone into what AssemblyAI wants.
 *
 * The Dictation endpoint takes raw 16 kHz mono S16LE PCM and returns 415 for
 * anything compressed, so the browser has to produce PCM itself. MediaRecorder
 * cannot: it only emits WebM/Opus. This processor resamples every render quantum
 * from the AudioContext rate (44.1 or 48 kHz on most machines) down to 16 kHz and
 * posts Int16 frames to the main thread as they are produced. The frames are
 * buffered on the main thread and the whole clip is posted on release;
 * /v1/transcribe/live would allow streaming and this build does not do it, so
 * the upload leg still grows with clip length.
 *
 * Resampling is linear interpolation with the fractional read position carried
 * across quanta and the previous block's final sample kept as `tail` — without
 * both, every 128-sample boundary would put a click in the audio.
 *
 * ponytail: linear interpolation, not a windowed-sinc resampler. Speech through
 * a 48 kHz -> 16 kHz decimation aliases a little above ~7 kHz; measured word
 * confidence stays above 0.95, so a polyphase filter is not worth the code.
 * Revisit only if confidence drops on sibilant-heavy speech.
 */

const TARGET_RATE = 16000;
/** ~64 ms at 16 kHz: big enough that postMessage is not the bottleneck, small
 *  enough that releasing the key feels instant. */
const FRAME_SAMPLES = 1024;

class Pcm16Processor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE;
    /** Fractional read index into the current quantum. -1 means "between the
     *  previous quantum's last sample and this one's first". */
    this.readPos = 0;
    this.tail = 0;
    this.out = new Int16Array(FRAME_SAMPLES);
    this.outLen = 0;
    this.running = true;
    this.port.onmessage = (e) => {
      if (e.data === "flush") {
        this.emit();
        this.running = false;
        this.port.postMessage({ type: "done" });
      }
    };
  }

  emit() {
    if (this.outLen === 0) return;
    const frame = this.out.slice(0, this.outLen);
    this.port.postMessage({ type: "pcm", frame }, [frame.buffer]);
    this.outLen = 0;
  }

  push(sample) {
    const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample;
    this.out[this.outLen++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    if (this.outLen === FRAME_SAMPLES) this.emit();
  }

  process(inputs) {
    if (!this.running) return false;
    const channel = inputs[0] && inputs[0][0];
    const n = channel ? channel.length : 0;
    // A disconnected or silent-but-unrendered input yields an empty quantum;
    // returning true keeps the node alive without corrupting the read position.
    if (n < 2) return true;

    let pos = this.readPos;
    // Stop one sample short: interpolating the last position needs channel[i+1],
    // which only the next quantum has.
    while (pos < n - 1) {
      const i = Math.floor(pos);
      const a = i < 0 ? this.tail : channel[i];
      const b = channel[i + 1];
      this.push(a + (b - a) * (pos - i));
      pos += this.ratio;
    }
    // Re-base onto the next quantum, where index -1 is this quantum's last sample.
    this.readPos = pos - n;
    this.tail = channel[n - 1];
    return true;
  }
}

registerProcessor("pcm16", Pcm16Processor);
