/**
 * WAV packaging (client) + WAV validation (server).
 * Sync STT accepts ONLY 16-bit WAV or raw PCM S16LE — never WebM/Opus.
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

export function pcm16ToWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const wstr = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  wstr(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
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
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

export type WavInfo = { ok: true; sampleRate: number; channels: number; durationMs: number } | { ok: false; code: string; message: string };

/** Server: validate WAV/PCM bytes BEFORE spending AssemblyAI credits. */
export function validateWavInput(buf: Buffer, contentType: string): WavInfo {
  if (buf.length === 0) return { ok: false, code: "EMPTY_AUDIO", message: "No audio received. Hold the mic and speak." };
  if (buf.length > MAX_BYTES) return { ok: false, code: "AUDIO_TOO_LARGE", message: "Clip exceeds 40 MB. Record a shorter clip." };
  const ct = contentType.split(";")[0].trim().toLowerCase();
  if (ct === "audio/pcm") {
    // Raw S16LE 16kHz mono assumed from our client; duration from byte count.
    const durationMs = Math.round(((buf.length / 2) / TARGET_RATE) * 1000);
    if (durationMs < MIN_MS) return { ok: false, code: "AUDIO_TOO_SHORT", message: "Clip is under 80 ms." };
    if (durationMs > MAX_MS) return { ok: false, code: "AUDIO_TOO_LONG", message: "Keep dictation clips under 2 minutes." };
    return { ok: true, sampleRate: TARGET_RATE, channels: 1, durationMs };
  }
  if (ct !== "audio/wav" && ct !== "audio/x-wav" && ct !== "audio/wave") {
    return { ok: false, code: "UNSUPPORTED_FORMAT", message: "Send WAV (audio/wav) or raw PCM (audio/pcm)." };
  }
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    return { ok: false, code: "BAD_AUDIO", message: "Bytes are not a valid WAV file." };
  }
  let off = 12;
  let fmt: { audioFormat: number; channels: number; sampleRate: number; bits: number } | null = null;
  let dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const len = buf.readUInt32LE(off + 4);
    if (id === "fmt " && len >= 16) {
      fmt = { audioFormat: buf.readUInt16LE(off + 8), channels: buf.readUInt16LE(off + 10), sampleRate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    } else if (id === "data") {
      dataLen = len;
    }
    off += 8 + len + (len % 2);
  }
  if (!fmt || dataLen === 0) return { ok: false, code: "BAD_AUDIO", message: "WAV header is incomplete." };
  if (fmt.audioFormat !== 1 || fmt.bits !== 16) return { ok: false, code: "UNSUPPORTED_FORMAT", message: "WAV must be 16-bit PCM." };
  if (!SYNC_RATES.has(fmt.sampleRate)) return { ok: false, code: "UNSUPPORTED_FORMAT", message: `Sample rate ${fmt.sampleRate} Hz is not accepted. Use 16000 Hz.` };
  if (fmt.channels < 1 || fmt.channels > 2) return { ok: false, code: "UNSUPPORTED_FORMAT", message: "WAV must be mono or stereo." };
  const durationMs = Math.round(((dataLen / (fmt.bits / 8)) / fmt.channels / fmt.sampleRate) * 1000);
  if (durationMs < MIN_MS) return { ok: false, code: "AUDIO_TOO_SHORT", message: "Clip is under 80 ms." };
  if (durationMs > MAX_MS) return { ok: false, code: "AUDIO_TOO_LONG", message: "Keep dictation clips under 2 minutes." };
  return { ok: true, sampleRate: fmt.sampleRate, channels: fmt.channels, durationMs };
}
