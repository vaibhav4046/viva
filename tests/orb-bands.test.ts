import { describe, expect, test } from "vitest";
import { createBandEngine } from "@/components/orb/orbState";

/**
 * The orb's band engine. This is the only non-obvious logic behind the voice
 * orb: everything else is a shader or a transform. If these four properties
 * hold, the surface tracks speech; if they stop holding, the orb goes back to
 * being a ball that inflates with volume.
 */

const FRAME = 1 / 60;

function run(engine: ReturnType<typeof createBandEngine>, level: number, seconds: number) {
  for (let t = 0; t < seconds; t += FRAME) engine.pushLevel(level, FRAME);
  return engine.read();
}

describe("band engine", () => {
  test("decays to silence when the microphone goes quiet", () => {
    const engine = createBandEngine();
    run(engine, 0.8, 1.5);
    const quiet = run(engine, 0, 3);
    expect(quiet.level).toBe(0);
    expect(quiet.low).toBeLessThan(0.01);
    expect(quiet.mid).toBeLessThan(0.01);
    expect(quiet.high).toBeLessThan(0.01);
  });

  test("a sustained voice settles the low band on the level", () => {
    const engine = createBandEngine();
    const held = run(engine, 0.6, 4);
    expect(held.low).toBeGreaterThan(0.55);
    expect(held.low).toBeLessThanOrEqual(0.6);
    // Nothing is modulating, so the syllable and onset bands fall away.
    expect(held.mid).toBeLessThan(0.1);
    expect(held.high).toBeLessThan(0.1);
  });

  test("an onset reaches the high band before it reaches the low band", () => {
    const engine = createBandEngine();
    run(engine, 0, 1);
    engine.pushLevel(0.7, FRAME);
    const firstFrame = engine.read();
    expect(firstFrame.high).toBeGreaterThan(firstFrame.low);
    expect(firstFrame.high).toBeGreaterThan(0.1);
  });

  test("the FFT path puts a bass-heavy spectrum in the low band", () => {
    const engine = createBandEngine();
    // 1024 bins over 24 kHz => ~23.4 Hz per bin. Fill only 60-350 Hz.
    const sampleRate = 48_000;
    const freq = new Uint8Array(1024);
    for (let i = 3; i < 15; i++) freq[i] = 220;
    for (let t = 0; t < 2; t += FRAME) engine.pushSpectrum(freq, sampleRate, FRAME);
    const bands = engine.read();
    expect(bands.low).toBeGreaterThan(0.5);
    expect(bands.high).toBeLessThan(0.05);
    expect(bands.level).toBeGreaterThan(0);
  });
});
