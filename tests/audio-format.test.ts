import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/voice/transcribe/route";
import { AssemblyAIProvider } from "@/lib/assemblyai";
import { TARGET_RATE, toPcm16kMono, validateWavInput } from "@/lib/audio/wav";
import { assemblyAIBreaker } from "@/lib/circuit";

/**
 * The declaration must match the bytes.
 *
 * Dictation's `config` says `sample_rate: 16000, channels: 1`, and AssemblyAI
 * reads the raw PCM stream at exactly that rate. The build used to hardcode the
 * declaration while forwarding whatever the caller sent, so a 48 kHz stereo
 * clip — what a desktop mic actually records — was consumed at one sixth speed:
 * a 3 s clip billed and reported as 18 s, transcript empty, HTTP 200, no
 * warning anywhere. These tests fail if that ever comes back.
 */

const DICTATION_URL = "https://dictation.assemblyai.com/v1/transcribe/live";
const savedFetch = globalThis.fetch;
const savedEnv = { ...process.env };

beforeEach(() => {
  process.env.ASSEMBLYAI_API_KEY = "test-key";
  process.env.ASSEMBLYAI_DICTATION_URL = DICTATION_URL;
  process.env.ASSEMBLYAI_TRANSCRIPTION_MODE = "dictation";
  assemblyAIBreaker.success();
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  process.env = { ...savedEnv };
  assemblyAIBreaker.success();
});

/**
 * A real WAV at any rate/channel count. `fmtLen` 18 reproduces the cbSize
 * extension the repo's own `.viva/audio/*.wav` fixtures carry, which puts the
 * sample data at byte 46 rather than 44.
 */
function wav(opts: { sampleRate: number; channels: number; ms: number; hz?: number; fmtLen?: 16 | 18 }): Buffer {
  const { sampleRate, channels, ms, hz = 180, fmtLen = 16 } = opts;
  const frames = Math.round((sampleRate * ms) / 1000);
  const data = Buffer.alloc(frames * channels * 2);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(0.6 * Math.sin((2 * Math.PI * hz * i) / sampleRate) * 0x7000);
    for (let c = 0; c < channels; c++) data.writeInt16LE(v, (i * channels + c) * 2);
  }
  const header = Buffer.alloc(20 + fmtLen + 8);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(header.length - 8 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(fmtLen, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 20 + fmtLen, "ascii");
  header.writeUInt32LE(data.length, 24 + fmtLen);
  return Buffer.concat([header, data]);
}

/** Milliseconds the bytes represent when read as 16 kHz mono S16LE. */
const asDeclaredMs = (bytes: number) => Math.round((bytes / 2 / TARGET_RATE) * 1000);

describe("toPcm16kMono", () => {
  it("downmixes and resamples 48 kHz stereo so the bytes mean what the config says", () => {
    const out = toPcm16kMono(wav({ sampleRate: 48000, channels: 2, ms: 3000 }), "audio/wav");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.sourceRate).toBe(48000);
    expect(out.sourceChannels).toBe(2);
    // 3 s of 48 kHz stereo is 576,000 bytes. Sent raw and declared as 16 kHz
    // mono it reads as 18,000 ms — the exact 6x inflation the judge measured.
    expect(asDeclaredMs(out.pcm.length)).toBe(3000);
  });

  it("reads the data chunk at its parsed offset, not a hardcoded byte 44", () => {
    // An 18-byte `fmt ` chunk puts sample data at 46. Stripping 44 blindly
    // prepends two header bytes as a phantom sample — and any chunk layout
    // with an odd byte count would misalign every sample after it.
    const ms = 500;
    const bytes = wav({ sampleRate: TARGET_RATE, channels: 1, ms, fmtLen: 18 });
    const out = toPcm16kMono(bytes, "audio/wav");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.pcm.length).toBe(TARGET_RATE * (ms / 1000) * 2);
    expect(out.pcm[0]).toBe(bytes[46]);
  });

  it("passes 16 kHz mono through untouched — the worklet path pays nothing", () => {
    const bytes = wav({ sampleRate: TARGET_RATE, channels: 1, ms: 1000 });
    const out = toPcm16kMono(bytes, "audio/wav");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.pcm.equals(bytes.subarray(44))).toBe(true);
  });

  it("folds two channels to their mean rather than dropping one", () => {
    // L at +8000, R at -8000: a channel-dropping downmix leaves a loud tone,
    // a correct average leaves silence.
    const frames = TARGET_RATE / 2;
    const data = Buffer.alloc(frames * 4);
    for (let i = 0; i < frames; i++) {
      data.writeInt16LE(8000, i * 4);
      data.writeInt16LE(-8000, i * 4 + 2);
    }
    const base = wav({ sampleRate: TARGET_RATE, channels: 2, ms: 500 });
    data.copy(base, 44);
    const out = toPcm16kMono(base, "audio/wav");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const peak = Math.max(...Array.from({ length: out.pcm.length / 2 }, (_, i) => Math.abs(out.pcm.readInt16LE(i * 2))));
    expect(peak).toBe(0);
  });

  it("upsamples 8 kHz to 16 kHz instead of halving the clip", () => {
    const out = toPcm16kMono(wav({ sampleRate: 8000, channels: 1, ms: 1000 }), "audio/wav");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(asDeclaredMs(out.pcm.length)).toBe(1000);
  });

  it("every rate the validator accepts converts to the declared duration", () => {
    for (const sampleRate of [8000, 16000, 22050, 24000, 32000, 44100, 48000]) {
      for (const channels of [1, 2]) {
        const bytes = wav({ sampleRate, channels, ms: 1000 });
        expect(validateWavInput(bytes, "audio/wav").ok).toBe(true);
        const out = toPcm16kMono(bytes, "audio/wav");
        expect(out.ok, `${sampleRate}/${channels}`).toBe(true);
        if (!out.ok) continue;
        expect(asDeclaredMs(out.pcm.length), `${sampleRate}/${channels}`).toBeCloseTo(1000, -1);
      }
    }
  });

  it("bytes that are not a WAV are a coded refusal, never a guess", () => {
    const out = toPcm16kMono(Buffer.from("GIF89a".padEnd(200, "x")), "audio/wav");
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("BAD_AUDIO");
  });
});

describe("POST /api/voice/transcribe with a 48 kHz stereo clip", () => {
  function post(audio: Buffer): Request {
    const form = new FormData();
    form.append("audio", new Blob([new Uint8Array(audio)], { type: "audio/wav" }), "clip.wav");
    form.append("subjectId", "course_transformers_w4");
    form.append("mode", "study");
    const ip = `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    return new Request("http://localhost/api/voice/transcribe", { method: "POST", body: form, headers: { "x-forwarded-for": ip } });
  }

  it("ships audio whose real duration matches the sample_rate it declares", async () => {
    let sent: { config: Record<string, unknown>; audioBytes: number } | null = null;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const body = init?.body as unknown as FormData;
      sent = {
        config: JSON.parse(await (body.get("config") as File).text()) as Record<string, unknown>,
        audioBytes: (body.get("audio") as File).size,
      };
      return new Response(
        JSON.stringify({ text: "declared and actual agree", llm_response: null, llm_error: null, confidence: 0.9, audio_duration_ms: 3000, session_id: "s" }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const res = await POST(post(wav({ sampleRate: 48000, channels: 2, ms: 3000 })));
    expect(res.status).toBe(200);
    const sentCall = sent as unknown as { config: Record<string, unknown>; audioBytes: number };
    expect(sentCall).not.toBeNull();
    expect(sentCall.config.sample_rate).toBe(16000);
    expect(sentCall.config.channels).toBe(1);
    // The regression: 576,000 raw bytes under a 16 kHz mono declaration is
    // 18,000 ms of audio for a 3,000 ms clip. Never a mislabelled request.
    expect(sentCall.audioBytes).not.toBe(576_000);
    expect(asDeclaredMs(sentCall.audioBytes)).toBe(3000);
  });

  it("a real user on a 48 kHz stereo mic gets a transcript, not a rejection", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ text: "attention needs positions", llm_response: "Attention needs positions.", llm_error: null, confidence: 0.98, audio_duration_ms: 3000, session_id: "s", request_time_ms: 400 }),
        { status: 200 }
      )) as unknown as typeof fetch;

    const res = await POST(post(wav({ sampleRate: 48000, channels: 2, ms: 3000 })));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verbatim).toBe("attention needs positions");
    expect(body.audioMs).toBe(3000);
  });
});

/**
 * The other door.
 *
 * The WAV door was fixed and the same clip posted as `audio/pcm` still went
 * through at six times its real length: raw PCM carries no format metadata, so
 * accepting it meant believing the caller's content type about rate and channel
 * count, and then declaring `sample_rate: 16000, channels: 1` upstream anyway.
 * The judge's repro — ffmpeg -ar 48000 -ac 2 -f s16le, posted as audio/pcm —
 * came back HTTP 200, audioMs 57330, transcript "". There is no way to verify a
 * declaration that is not in the bytes, so the door is closed: WAV only.
 */
describe("the audio/pcm door", () => {
  /** Exactly the judge's bytes: 9.55 s of 48 kHz stereo with the header cut off. */
  const REAL_MS = 9555;
  const raw = wav({ sampleRate: 48000, channels: 2, ms: REAL_MS }).subarray(44);

  it("is what the bug looked like: those bytes read as 57 s under the declaration", () => {
    // Not an assertion about our code — it is the arithmetic that made the
    // failure silent and the bill six times too big. 9,555 ms of 48 kHz stereo
    // is 1,834,560 bytes, which is 57,330 ms of 16 kHz mono.
    expect(asDeclaredMs(raw.length)).toBe(57_330);
    expect(asDeclaredMs(raw.length)).toBeCloseTo(REAL_MS * 6, -2);
  });

  it("the validator refuses audio/pcm instead of guessing 16 kHz mono", () => {
    const info = validateWavInput(raw, "audio/pcm");
    expect(info.ok).toBe(false);
    if (info.ok) return;
    expect(info.code).toBe("UNSUPPORTED_FORMAT");
  });

  it("the converter refuses it too, rather than handing the bytes back untouched", () => {
    const out = toPcm16kMono(raw, "audio/pcm");
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("UNSUPPORTED_FORMAT");
  });

  it("neither function trusts a content type it has not verified", () => {
    // A 16 kHz mono raw clip is refused as well: correct bytes behind an
    // unverifiable declaration is still an unverifiable declaration.
    for (const ct of ["audio/pcm", "audio/x-pcm", "application/octet-stream", "audio/webm", ""]) {
      expect(validateWavInput(wav({ sampleRate: TARGET_RATE, channels: 1, ms: 1000 }).subarray(44), ct).ok, ct).toBe(false);
      expect(toPcm16kMono(wav({ sampleRate: TARGET_RATE, channels: 1, ms: 1000 }), ct).ok, ct).toBe(false);
    }
  });

  it("the endpoint spends nothing on it: 415 before a single upstream call", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const form = new FormData();
    form.append("audio", new Blob([new Uint8Array(raw)], { type: "audio/pcm" }), "clip.raw");
    form.append("subjectId", "course_transformers_w4");
    const res = await POST(
      new Request("http://localhost/api/voice/transcribe", {
        method: "POST",
        body: form,
        headers: { "x-forwarded-for": "10.8.1.1" },
      })
    );

    expect(calls).toHaveLength(0);
    expect(res.status).toBe(415);
    const body = await res.json();
    expect(body.error.code).toBe("UNSUPPORTED_FORMAT");
    expect(body).not.toHaveProperty("audioMs");
    expect(body).not.toHaveProperty("verbatim");
  });

  it("the same recording as a WAV still transcribes, at its real length", async () => {
    let audioBytes = 0;
    let declared: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const body = init?.body as unknown as FormData;
      declared = JSON.parse(await (body.get("config") as File).text()) as Record<string, unknown>;
      audioBytes = (body.get("audio") as File).size;
      return new Response(
        JSON.stringify({ text: "attention needs positions", llm_response: null, llm_error: null, confidence: 0.99, audio_duration_ms: REAL_MS, session_id: "s" }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const form = new FormData();
    form.append("audio", new Blob([new Uint8Array(wav({ sampleRate: 48000, channels: 2, ms: REAL_MS }))], { type: "audio/wav" }), "clip.wav");
    form.append("subjectId", "course_transformers_w4");
    const res = await POST(
      new Request("http://localhost/api/voice/transcribe", {
        method: "POST",
        body: form,
        headers: { "x-forwarded-for": "10.8.1.2" },
      })
    );

    expect(res.status).toBe(200);
    expect((await res.json()).verbatim).toBe("attention needs positions");
    expect(declared.sample_rate).toBe(TARGET_RATE);
    expect(declared.channels).toBe(1);
    expect(asDeclaredMs(audioBytes)).toBe(REAL_MS);
    expect(audioBytes).not.toBe(raw.length);
  });

  it("the Sync fallback cannot re-send headerless bytes as a WAV either", async () => {
    // Second order from the same finding: the fallback wraps req.audio in a Blob
    // typed audio/wav, so a non-WAV reaching it is the same mislabelling one
    // layer down. It refuses before the request is built.
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await expect(
      new AssemblyAIProvider("sync").transcribe({ audio: raw, contentType: "audio/pcm" })
    ).rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT" });
    expect(calls).toHaveLength(0);
  });
});

/**
 * The gates themselves, not just the happy path.
 *
 * Mutation testing walked these three and every mutant lived: the rate gate
 * could be deleted, `channels > 2` widened to `> 3`, and the channel average
 * replaced by a bare sum — and the whole suite still went green. The reason was
 * symmetry: every existing case fed identical samples to both channels (so
 * dropping one is indistinguishable from averaging) or used L/R at +8000/-8000
 * (so the SUM is also zero). These assert the arithmetic and the refusals.
 */
describe("the validator gates", () => {
  it("refuses a rate AssemblyAI does not read, instead of forwarding it", () => {
    // 11,025 Hz is a real thing a phone can record and is not in SYNC_RATES.
    // Delete the gate and this comes back ok with a duration nobody can use.
    for (const sampleRate of [11025, 12000, 96000, 192000]) {
      const info = validateWavInput(wav({ sampleRate, channels: 1, ms: 1000 }), "audio/wav");
      expect(info.ok, `${sampleRate}`).toBe(false);
      if (info.ok) continue;
      expect(info.code).toBe("UNSUPPORTED_FORMAT");
    }
  });

  it("accepts exactly mono and stereo — three channels is a coded refusal", () => {
    // `> 2` widened to `> 3` leaves 3-channel audio going upstream, where
    // downmix reads it as interleaved anything and the transcript is noise.
    for (const channels of [3, 4, 6]) {
      const info = validateWavInput(wav({ sampleRate: TARGET_RATE, channels, ms: 500 }), "audio/wav");
      expect(info.ok, `${channels}ch`).toBe(false);
      if (info.ok) continue;
      expect(info.code).toBe("UNSUPPORTED_FORMAT");
    }
    for (const channels of [1, 2]) {
      const info = validateWavInput(wav({ sampleRate: TARGET_RATE, channels, ms: 500 }), "audio/wav");
      expect(info.ok, `${channels}ch`).toBe(true);
      if (!info.ok) continue;
      expect(info.channels).toBe(channels);
    }
  });

  it("a zero-channel header is refused by the channel gate, not by a divide by zero", () => {
    // `channels < 1` relaxed to `< 0` lets this through, and the duration
    // becomes Infinity — which then trips AUDIO_TOO_LONG and blames the
    // learner for a header the file wrote. The code is what pins this.
    const bytes = wav({ sampleRate: TARGET_RATE, channels: 1, ms: 500 });
    bytes.writeUInt16LE(0, 22); // fmt.channels
    const info = validateWavInput(bytes, "audio/wav");
    expect(info.ok).toBe(false);
    if (info.ok) return;
    expect(info.code).toBe("UNSUPPORTED_FORMAT");
  });

  it("counts stereo duration per frame, not per sample", () => {
    // Drop the `/ fmt.channels` and a 1 s stereo clip reports 500 ms, which is
    // the figure the review panel and the telemetry line both quote.
    const info = validateWavInput(wav({ sampleRate: 48000, channels: 2, ms: 1000 }), "audio/wav");
    expect(info.ok).toBe(true);
    if (!info.ok) return;
    expect(info.durationMs).toBe(1000);
  });

  it("the converter refuses the same channel counts the validator does", () => {
    for (const channels of [3, 6]) {
      const out = toPcm16kMono(wav({ sampleRate: TARGET_RATE, channels, ms: 500 }), "audio/wav");
      expect(out.ok, `${channels}ch`).toBe(false);
      if (out.ok) continue;
      expect(out.code).toBe("UNSUPPORTED_FORMAT");
    }
  });
});

describe("downmix arithmetic", () => {
  /** A stereo WAV with the two channels held at different constant levels. */
  function stereo(left: number, right: number, frames: number): Buffer {
    const base = wav({ sampleRate: TARGET_RATE, channels: 2, ms: Math.round((frames / TARGET_RATE) * 1000) });
    const data = parsedData(base);
    for (let i = 0; i < frames; i++) {
      base.writeInt16LE(left, data + i * 4);
      base.writeInt16LE(right, data + i * 4 + 2);
    }
    return base;
  }

  /** Byte offset of the `data` chunk payload in a WAV the helper above built. */
  function parsedData(buf: Buffer): number {
    let off = 12;
    while (off + 8 <= buf.length) {
      const id = buf.toString("ascii", off, off + 4);
      const len = buf.readUInt32LE(off + 4);
      if (id === "data") return off + 8;
      off += 8 + len + (len % 2);
    }
    throw new Error("no data chunk");
  }

  const samples = (out: Buffer) => Array.from({ length: out.length / 2 }, (_, i) => out.readInt16LE(i * 2));

  it("averages asymmetric channels rather than summing or dropping one", () => {
    // The existing +8000/-8000 case cannot tell these apart: mean, sum and
    // "L+R with no divide" are all 0 there. Here they are 4000, 8000 and 6000.
    const out = toPcm16kMono(stereo(6000, 2000, 400), "audio/wav");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const values = new Set(samples(out.pcm));
    expect(values).toEqual(new Set([4000]));
  });

  it("keeps the left channel's own value when only the left is loud", () => {
    // Drop channel 1 and this reads 0; drop channel 0 and it reads 0 too.
    const out = toPcm16kMono(stereo(10000, 0, 400), "audio/wav");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(new Set(samples(out.pcm))).toEqual(new Set([5000]));
  });

  it("rounds the mean rather than truncating it", () => {
    // (6001 + 2000) / 2 = 4000.5. Int16Array truncation gives 4000.
    const out = toPcm16kMono(stereo(6001, 2000, 400), "audio/wav");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(new Set(samples(out.pcm))).toEqual(new Set([4001]));
  });

  it("does not overflow when both channels are at full scale", () => {
    // A sum-instead-of-mean mutant writes 65534 into an Int16, which wraps to
    // -2 — silence where the loudest possible clip was.
    const out = toPcm16kMono(stereo(32767, 32767, 400), "audio/wav");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(new Set(samples(out.pcm))).toEqual(new Set([32767]));
  });

  it("mono is passed through sample for sample", () => {
    const bytes = wav({ sampleRate: TARGET_RATE, channels: 1, ms: 50 });
    const out = toPcm16kMono(bytes, "audio/wav");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(samples(out.pcm)).toEqual(samples(bytes.subarray(44)));
  });
});
