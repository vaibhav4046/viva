/**
 * Level maths for the two meters. Pure, so the numbers can be asserted without
 * an AudioContext. The meters are driven by these functions applied to real
 * analyser samples; nothing here invents motion.
 */

/** Root mean square of a block of samples in the range -1..1. */
export function rmsOf(samples: ArrayLike<number>): number {
  const n = samples.length;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = samples[i];
    sum += v * v;
  }
  return Math.sqrt(sum / n);
}

/**
 * Speech sits around 0.02 to 0.2 RMS. Scaling by 5 puts ordinary speech in the
 * middle of the bar, and the clamp keeps a clipped signal at full.
 */
const METER_GAIN = 5;

export function meterLevel(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 0) return 0;
  return Math.min(1, rms * METER_GAIN);
}

/** Fast attack, slow release, so a syllable is visible and the bar does not flicker. */
export function smoothLevel(previous: number, next: number, attack = 0.6, release = 0.18): number {
  const k = next > previous ? attack : release;
  return previous + (next - previous) * k;
}
