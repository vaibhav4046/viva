/**
 * The orb's audio state. Framework-free on purpose so it can be unit tested in
 * node (tests/orb-bands.test.ts) and read from inside a render loop without a
 * React re-render.
 *
 * VIVA opens exactly one microphone, in src/lib/audio/worklet.ts, and that
 * capture already runs an AnalyserNode. Nothing here opens a second stream:
 * the band engine is fed either
 *
 *   - the scalar RMS the capture publishes through `MicButton.onLevel`
 *     (`setOrbLevel`), which is what ships today, or
 *   - a real AnalyserNode handed in by whoever owns the capture
 *     (`setOrbAnalyser`), which switches the same engine onto a true FFT
 *     three-band split with no other change.
 *
 * Both paths end in the same attack/release followers, so the orb looks the
 * same either way — the FFT path just separates a plosive from a vowel more
 * honestly than a derivative of one number can.
 */

export type Bands = {
  /** Overall loudness, 0..1. Drives the core glow. */
  level: number;
  /** Phrase energy. Slow. Drives the broad lobes. */
  low: number;
  /** Syllable modulation. Drives the medium ripples. */
  mid: number;
  /** Onsets and consonants. Fast. Drives the fine chop. */
  high: number;
};

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : Number.isFinite(n) ? n : 0);

/** One-pole follower. `tau` is the time in seconds to cover ~63% of the gap. */
function follow(current: number, target: number, dt: number, tau: number): number {
  return current + (target - current) * (1 - Math.exp(-dt / tau));
}

/* Attack is always far shorter than release: a voice should hit the surface
 * instantly and let go slowly, which is what reads as speech rather than as a
 * meter. These are seconds. */
const ATTACK = { low: 0.1, mid: 0.04, high: 0.012 };
const RELEASE = { low: 0.5, mid: 0.18, high: 0.09 };
/** Running-mean window used to find the modulation around a steady voice. */
const FLOOR_TAU = 0.7;

/** Hz edges for the FFT split. Speech: pitch, formants, fricatives. */
const BAND_HZ = [60, 350, 2000, 7000] as const;

export type BandEngine = {
  /** Scalar RMS path. `level` is 0..1 as published by the capture. */
  pushLevel(level: number, dt: number): void;
  /** True FFT path. `freq` is getByteFrequencyData output. */
  pushSpectrum(freq: Uint8Array, sampleRate: number, dt: number): void;
  read(): Bands;
};

export function createBandEngine(): BandEngine {
  let level = 0;
  let prev = 0;
  let floor = 0;
  let low = 0;
  let mid = 0;
  let high = 0;

  function settle(tLow: number, tMid: number, tHigh: number, dt: number): void {
    low = follow(low, tLow, dt, tLow > low ? ATTACK.low : RELEASE.low);
    mid = follow(mid, tMid, dt, tMid > mid ? ATTACK.mid : RELEASE.mid);
    high = follow(high, tHigh, dt, tHigh > high ? ATTACK.high : RELEASE.high);
  }

  return {
    pushLevel(next, dt) {
      if (dt <= 0) return;
      level = clamp01(next);
      floor = follow(floor, level, dt, FLOOR_TAU);
      // Deviation from the running mean is the syllable rate; the positive
      // slope is the onset. Neither is a real band, but together they move
      // with speech instead of with volume.
      //
      // The gate matters: the running mean lags the microphone by ~0.7 s, so
      // without it the deviation stays non-zero for seconds after the learner
      // stops talking and the surface keeps rippling at nothing. Modulation
      // only means something while there is something to modulate.
      const gate = clamp01(Math.max(level, floor) * 8);
      const tMid = clamp01(Math.abs(level - floor) * 2.2) * gate;
      const tHigh = clamp01((Math.max(0, level - prev) / dt) * 0.05);
      prev = level;
      settle(level, tMid, tHigh, dt);
    },

    pushSpectrum(freq, sampleRate, dt) {
      if (dt <= 0 || freq.length === 0 || sampleRate <= 0) return;
      const hzPerBin = sampleRate / 2 / freq.length;
      const mean = (fromHz: number, toHz: number) => {
        const a = Math.max(0, Math.floor(fromHz / hzPerBin));
        const b = Math.min(freq.length, Math.ceil(toHz / hzPerBin));
        if (b <= a) return 0;
        let sum = 0;
        for (let i = a; i < b; i++) sum += freq[i];
        return sum / (b - a) / 255;
      };
      const tLow = clamp01(mean(BAND_HZ[0], BAND_HZ[1]) * 1.35);
      const tMid = clamp01(mean(BAND_HZ[1], BAND_HZ[2]) * 1.7);
      const tHigh = clamp01(mean(BAND_HZ[2], BAND_HZ[3]) * 2.4);
      level = clamp01(tLow * 0.55 + tMid * 0.35 + tHigh * 0.1);
      prev = level;
      floor = follow(floor, level, dt, FLOOR_TAU);
      settle(tLow, tMid, tHigh, dt);
    },

    read() {
      return { level, low, mid, high };
    },
  };
}

/* ------------------------------------------------------------------ module
 * One engine for the app. `orbBands` is mutated in place and read from inside
 * the render loop — deliberately not React state, because a 60 Hz setState
 * would re-render the tree sixty times a second to move one uniform.
 */

const engine = createBandEngine();
let pendingLevel = 0;
let analyser: AnalyserNode | null = null;
let spectrum: Uint8Array<ArrayBuffer> | null = null;

export const orbBands: Bands = { level: 0, low: 0, mid: 0, high: 0 };

/** Publish the live microphone RMS. Wire to `MicButton.onLevel`. */
export function setOrbLevel(level: number): void {
  pendingLevel = clamp01(level);
}

/**
 * Hand the orb the capture's existing AnalyserNode to switch on the real FFT
 * split. Pass null on teardown. Never creates a stream of its own.
 */
export function setOrbAnalyser(node: AnalyserNode | null): void {
  analyser = node;
  spectrum = node ? new Uint8Array(node.frequencyBinCount) : null;
}

/** Advance the followers by `dt` seconds. Called once per frame by OrbHost. */
export function advanceBands(dt: number): void {
  if (analyser && spectrum) {
    analyser.getByteFrequencyData(spectrum);
    engine.pushSpectrum(spectrum, analyser.context.sampleRate, dt);
  } else {
    engine.pushLevel(pendingLevel, dt);
  }
  const next = engine.read();
  orbBands.level = next.level;
  orbBands.low = next.low;
  orbBands.mid = next.mid;
  orbBands.high = next.high;
}
