import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { int16ToWav, validateWavInput } from "@/lib/audio/wav";
import { BURST_CHARS, BURST_WINDOW_MS, emptyBurst, foldBurst } from "@/lib/audio/burst";

/**
 * The two pure pieces of the capture path: the WAV the AudioWorklet frames get
 * packed into, and the burst detector that tells a dictated paste from typing.
 * The worklet itself needs a browser and is covered by the live end-to-end run.
 */

describe("int16ToWav", () => {
  it("writes a header the server validator accepts", () => {
    const frames = [new Int16Array(8000), new Int16Array(8000)]; // 1 s at 16 kHz
    const buf = Buffer.from(int16ToWav(frames));
    const info = validateWavInput(buf, "audio/wav");
    expect(info.ok).toBe(true);
    if (!info.ok) return;
    expect(info.sampleRate).toBe(16000);
    expect(info.channels).toBe(1);
    expect(info.durationMs).toBe(1000);
  });

  it("concatenates frames in order and byte-for-byte", () => {
    const a = Int16Array.from([1, -1, 32767, -32768]);
    const b = Int16Array.from([7, 8]);
    const buf = Buffer.from(int16ToWav([a, b]));
    expect(buf.length).toBe(44 + (a.length + b.length) * 2);
    const body = new Int16Array(buf.buffer, buf.byteOffset + 44, a.length + b.length);
    expect(Array.from(body)).toEqual([1, -1, 32767, -32768, 7, 8]);
  });

  it("declares the real byte lengths in RIFF and data", () => {
    const buf = Buffer.from(int16ToWav([new Int16Array(1600)]));
    expect(buf.toString("ascii", 0, 4)).toBe("RIFF");
    expect(buf.readUInt32LE(4)).toBe(buf.length - 8);
    expect(buf.toString("ascii", 36, 40)).toBe("data");
    expect(buf.readUInt32LE(40)).toBe(buf.length - 44);
  });

  it("an empty capture produces a header-only WAV the validator rejects", () => {
    const buf = Buffer.from(int16ToWav([]));
    expect(buf.length).toBe(44);
    const info = validateWavInput(buf, "audio/wav");
    expect(info.ok).toBe(false);
  });
});

describe("external-dictation burst detection", () => {
  const type = (state = emptyBurst(), chars = 1, gap = 120, at = 1000) => foldBurst(state, chars, at + gap);

  it("typing at human speed stays typed", () => {
    let s = emptyBurst();
    let t = 0;
    for (let i = 0; i < 200; i++) {
      t += 90; // ~11 characters per second, faster than most people
      s = foldBurst(s, 1, t);
    }
    expect(s.origin).toBe("typed");
  });

  it("a dictation tool dropping a sentence in one event is external", () => {
    const s = foldBurst(emptyBurst(), 180, 5000);
    expect(s.origin).toBe("external-dictation");
  });

  it("a burst split across several events inside the window is external", () => {
    let s = emptyBurst();
    s = foldBurst(s, 20, 1000);
    s = foldBurst(s, 20, 1100);
    s = foldBurst(s, 20, 1200);
    expect(s.charsInWindow).toBe(60);
    expect(s.origin).toBe("external-dictation");
  });

  it("the same characters spread beyond the window are not a burst", () => {
    let s = emptyBurst();
    s = foldBurst(s, 20, 1000);
    s = foldBurst(s, 20, 1000 + BURST_WINDOW_MS + 1);
    expect(s.origin).toBe("typed");
  });

  it("exactly the threshold is not enough — it must be more than 40", () => {
    expect(foldBurst(emptyBurst(), BURST_CHARS, 1000).origin).toBe("typed");
    expect(foldBurst(emptyBurst(), BURST_CHARS + 1, 1000).origin).toBe("external-dictation");
  });

  it("editing a dictated sentence afterwards does not turn it back into typing", () => {
    let s = foldBurst(emptyBurst(), 200, 1000);
    for (let i = 0; i < 10; i++) s = foldBurst(s, 1, 2000 + i * 500);
    expect(s.origin).toBe("external-dictation");
  });

  it("deletions are ignored", () => {
    const s = type();
    expect(foldBurst(s, -50, 2000)).toBe(s);
  });
});

/**
 * The mic button carries its own typed box, so it inherits the invariant
 * tests/typed-input.test.ts guards on the standalone one: the field is
 * server-rendered and a student can type into it before React hydrates, so a
 * controlled `value` reconciles an empty string over the live DOM node and
 * silently wipes what they wrote.
 */
describe("MicButton's typed box is hydration-safe", () => {
  const SRC = readFileSync(fileURLToPath(new URL("../src/components/voice/MicButton.tsx", import.meta.url)), "utf8");

  function inputAttributes(): string {
    const match = SRC.match(/<input\b([\s\S]*?)\/>/);
    if (!match) throw new Error("MicButton no longer renders an <input>");
    return match[1];
  }

  it("is uncontrolled: no value binding for hydration to overwrite", () => {
    const attrs = inputAttributes();
    expect(attrs).not.toMatch(/\bvalue=\{/);
    expect(attrs).toMatch(/\bdefaultValue=""/);
  });

  it("keeps the id the rest of the app targets", () => {
    expect(inputAttributes()).toMatch(/id="viva-type"/);
  });

  it("reads the value off the DOM node when submitting", () => {
    expect(SRC).toMatch(/typedRef\.current[\s\S]{0,80}\.value/);
  });
});
