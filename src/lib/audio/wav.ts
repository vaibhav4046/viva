/**
 * WAV packaging (client) + WAV validation (server).
 *
 * The server accepts 16-bit PCM WAV and nothing else — never WebM/Opus, and no
 * longer raw `audio/pcm`. Raw PCM carries no format metadata, so accepting it
 * meant believing the caller's content type about rate and channel count, and
 * that belief is exactly the mislabelling bug: 48 kHz stereo bytes posted as
 * `audio/pcm` were forwarded under a `sample_rate: 16000, channels: 1`
 * declaration and consumed at one sixth speed (9.55 s read as 57.33 s, empty
 * transcript, six times the bill). A RIFF header states the rate and channels
 * in the bytes themselves, which is the only version of this that can be
 * verified, so WAV is the one door. The worklet already produces WAV.
 *
 * No FFmpeg anywhere in the hot path: pure byte ops + WebAudio decode.
 */

export const SYNC_RATES = new Set([8000, 16000, 22050, 24000, 32000, 44100, 48000]);
export const TARGET_RATE = 16000;
export const MIN_MS = 80;
export const MAX_MS = 120_000;
export const MAX_BYTES = 40_000_000;

/** Client: decode any browser-captured blob → 16 kHz mono 16-bit WAV. */
export async function blobToWav16kMono(blob: Blob): Promise<{ wav: ArrayBuffer; durationMs: number }> {
  const raw = await blob.arrayBuffer();
  const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AC();
  try {
    const decoded = await ctx.decodeAudioData(raw.slice(0));
    const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil((decoded.duration * TARGET_RATE) / 1)), TARGET_RATE);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start(0);
    const rendered = await offline.startRendering();
    const ch = rendered.getChannelData(0);
    const durationMs = Math.round((ch.length / TARGET_RATE) * 1000);
    if (durationMs < MIN_MS) throw wavError("AUDIO_TOO_SHORT", "Clip is under 80 ms — hold a little longer and speak.");
    if (durationMs > MAX_MS) throw wavError("AUDIO_TOO_LONG", "Keep dictation clips under 2 minutes.");
    return { wav: pcm16ToWav(ch, TARGET_RATE), durationMs };
  } finally {
    void ctx.close().catch(() => {});
  }
}

function wavError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

/** 44-byte canonical RIFF/WAVE header for mono 16-bit PCM. */
function writeWavHeader(v: DataView, sampleCount: number, sampleRate: number): void {
  const wstr = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  wstr(0, "RIFF");
  v.setUint32(4, 36 + sampleCount * 2, true);
  wstr(8, "WAVE");
  wstr(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  wstr(36, "data");
  v.setUint32(40, sampleCount * 2, true);
}

export function pcm16ToWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  writeWavHeader(v, samples.length, sampleRate);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

/**
 * Wrap Int16 frames straight from the AudioWorklet. No float round-trip: the
 * worklet already quantised, and re-scaling would only add error.
 */
export function int16ToWav(frames: readonly Int16Array[], sampleRate = TARGET_RATE): ArrayBuffer {
  let total = 0;
  for (const f of frames) total += f.length;
  const buf = new ArrayBuffer(44 + total * 2);
  writeWavHeader(new DataView(buf), total, sampleRate);
  const body = new Int16Array(buf, 44, total);
  let at = 0;
  for (const f of frames) {
    body.set(f, at);
    at += f.length;
  }
  return buf;
}

export type WavInfo = { ok: true; sampleRate: number; channels: number; durationMs: number } | { ok: false; code: string; message: string };

type WavParse = {
  fmt: { audioFormat: number; channels: number; sampleRate: number; bits: number };
  /** Byte offset of the sample data — NOT always 44: a `fmt ` chunk carrying
   *  the cbSize extension is 18 bytes, and LIST/fact chunks push it further. */
  dataOff: number;
  dataLen: number;
};

/** Walk the RIFF chunk list. `dataLen` is clamped to the bytes actually present
 *  so a truncated upload cannot claim a duration it does not have. */
function parseWav(buf: Buffer): WavParse | null {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return null;
  let off = 12;
  let fmt: WavParse["fmt"] | null = null;
  let dataOff = 0;
  let dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const len = buf.readUInt32LE(off + 4);
    if (id === "fmt " && len >= 16) {
      fmt = { audioFormat: buf.readUInt16LE(off + 8), channels: buf.readUInt16LE(off + 10), sampleRate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    } else if (id === "data") {
      dataOff = off + 8;
      dataLen = Math.max(0, Math.min(len, buf.length - dataOff));
    }
    off += 8 + len + (len % 2);
  }
  return fmt && dataLen > 0 ? { fmt, dataOff, dataLen } : null;
}

/** The only content types that carry their own format. See the file header. */
const WAV_TYPES = new Set(["audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"]);

/** True for a content type whose bytes declare their own rate and channels. */
export function isWavType(contentType: string): boolean {
  return WAV_TYPES.has(contentType.split(";")[0].trim().toLowerCase());
}

/** Server: validate WAV bytes BEFORE spending AssemblyAI credits. */
export function validateWavInput(buf: Buffer, contentType: string): WavInfo {
  if (buf.length === 0) return { ok: false, code: "EMPTY_AUDIO", message: "No audio received. Hold the mic and speak." };
  if (buf.length > MAX_BYTES) return { ok: false, code: "AUDIO_TOO_LARGE", message: "Clip exceeds 40 MB. Record a shorter clip." };
  if (!isWavType(contentType)) {
    return { ok: false, code: "UNSUPPORTED_FORMAT", message: "Send a 16-bit PCM WAV (audio/wav). Raw audio/pcm cannot declare its own rate." };
  }
  const parsed = parseWav(buf);
  if (!parsed) return { ok: false, code: "BAD_AUDIO", message: "Bytes are not a valid WAV file." };
  const { fmt, dataLen } = parsed;
  if (fmt.audioFormat !== 1 || fmt.bits !== 16) return { ok: false, code: "UNSUPPORTED_FORMAT", message: "WAV must be 16-bit PCM." };
  // 44.1 and 48 kHz are what a desktop mic actually records at, so they are
  // accepted and downmixed/resampled to 16 kHz mono by `toPcm16kMono` before
  // anything is sent. The message must not promise a rejection that never
  // happens for those rates.
  if (!SYNC_RATES.has(fmt.sampleRate)) return { ok: false, code: "UNSUPPORTED_FORMAT", message: `Sample rate ${fmt.sampleRate} Hz cannot be read. Record at 16000 Hz.` };
  if (fmt.channels < 1 || fmt.channels > 2) return { ok: false, code: "UNSUPPORTED_FORMAT", message: "WAV must be mono or stereo." };
  const durationMs = Math.round(((dataLen / (fmt.bits / 8)) / fmt.channels / fmt.sampleRate) * 1000);
  if (durationMs < MIN_MS) return { ok: false, code: "AUDIO_TOO_SHORT", message: "Clip is under 80 ms." };
  if (durationMs > MAX_MS) return { ok: false, code: "AUDIO_TOO_LONG", message: "Keep dictation clips under 2 minutes." };
  return { ok: true, sampleRate: fmt.sampleRate, channels: fmt.channels, durationMs };
}

/** Interleaved S16LE → one mono track, channels averaged. */
function downmix(buf: Buffer, at: number, len: number, channels: number): Int16Array {
  const frames = Math.floor(len / 2 / channels);
  const out = new Int16Array(frames);
  if (channels === 1) {
    for (let i = 0; i < frames; i++) out[i] = buf.readInt16LE(at + i * 2);
    return out;
  }
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += buf.readInt16LE(at + (i * channels + c) * 2);
    out[i] = Math.round(sum / channels);
  }
  return out;
}

/**
 * Rate conversion. Downsampling averages the whole input window rather than
 * picking every Nth sample: the mean is a crude low-pass, and without one
 * everything above 8 kHz folds back into the speech band as aliasing hiss.
 */
function resample(src: Int16Array, srcRate: number, dstRate: number): Int16Array {
  if (srcRate === dstRate || src.length === 0) return src;
  const ratio = srcRate / dstRate;
  const outLen = Math.max(1, Math.round(src.length / ratio));
  const out = new Int16Array(outLen);
  if (ratio < 1) {
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio;
      const j = Math.min(Math.floor(pos), src.length - 1);
      const next = Math.min(j + 1, src.length - 1);
      out[i] = Math.round(src[j] + (src[next] - src[j]) * (pos - j));
    }
    return out;
  }
  for (let i = 0; i < outLen; i++) {
    const from = Math.min(Math.floor(i * ratio), src.length - 1);
    const to = Math.min(src.length, Math.max(from + 1, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = from; j < to; j++) sum += src[j];
    out[i] = Math.round(sum / (to - from));
  }
  return out;
}

export type PcmResult = { ok: true; pcm: Buffer; sourceRate: number; sourceChannels: number } | { ok: false; code: string; message: string };

/**
 * Server: accepted WAV bytes → raw 16 kHz mono S16LE, which is what the
 * Dictation `config` declares.
 *
 * The declaration is not a hint: AssemblyAI reads the byte stream at the rate
 * it is told, so 48 kHz stereo posted as 16 kHz mono is consumed at one sixth
 * speed — a 9.5 s clip arrives as 57 s of nothing, billed six times over, with
 * a 200 and an empty transcript. Every entry point that is not the AudioWorklet
 * (a direct API caller, a browser with no worklet) can hand us exactly that, so
 * the conversion belongs here rather than in a caller.
 *
 * The content type is re-checked rather than trusted to have been checked: this
 * is the last place before the bytes go on the wire under a declaration, and
 * anything that cannot state its own rate in its own bytes is refused here even
 * if a caller let it through.
 */
export function toPcm16kMono(buf: Buffer, contentType: string): PcmResult {
  if (!isWavType(contentType)) {
    return { ok: false, code: "UNSUPPORTED_FORMAT", message: "Send a 16-bit PCM WAV (audio/wav). Raw audio/pcm cannot declare its own rate." };
  }
  const parsed = parseWav(buf);
  if (!parsed) return { ok: false, code: "BAD_AUDIO", message: "Bytes are not a valid WAV file." };
  const { fmt, dataOff, dataLen } = parsed;
  if (fmt.audioFormat !== 1 || fmt.bits !== 16) return { ok: false, code: "UNSUPPORTED_FORMAT", message: "WAV must be 16-bit PCM." };
  if (fmt.channels < 1 || fmt.channels > 2) return { ok: false, code: "UNSUPPORTED_FORMAT", message: "WAV must be mono or stereo." };
  // Already the target format: hand back the data chunk with no copy and no
  // arithmetic. Note this is a parsed offset, not a hardcoded 44 — the repo's
  // own fixtures carry an 18-byte `fmt ` chunk and start at byte 46.
  if (fmt.sampleRate === TARGET_RATE && fmt.channels === 1) {
    return { ok: true, pcm: buf.subarray(dataOff, dataOff + dataLen), sourceRate: fmt.sampleRate, sourceChannels: 1 };
  }
  const mono = resample(downmix(buf, dataOff, dataLen, fmt.channels), fmt.sampleRate, TARGET_RATE);
  const pcm = Buffer.allocUnsafe(mono.length * 2);
  for (let i = 0; i < mono.length; i++) pcm.writeInt16LE(mono[i], i * 2);
  return { ok: true, pcm, sourceRate: fmt.sampleRate, sourceChannels: fmt.channels };
}
