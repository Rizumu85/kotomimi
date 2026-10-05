/**
 * Fork: sound brought down to the 16 kHz a recognizer reads, for the native
 * engine (`src/providers/openai/nativeAsr.ts`). The engine takes any rate
 * and brings it down itself, but less carefully: the same seven clips read
 * 0.8 points worse given at 24 kHz than given at 16 (2026-10-05). So the app
 * does it, the textbook way: a low-pass filter that removes what 16 kHz
 * cannot hold, then every sample that is kept.
 *
 * Only the rates that are a small ratio away from 16 kHz — 24 kHz, which is
 * what the app hears at, 32 and 48 — are handled; any other is left to the
 * engine.
 */

export const TARGET_RATE = 16000;

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** A rate → 16 kHz as "up by `up`, down by `down`"; null for a rate this does not handle. */
export function ratioFor(rate: number): { up: number; down: number } | null {
  if (!Number.isInteger(rate) || rate <= TARGET_RATE) return null;
  const g = gcd(TARGET_RATE, rate);
  const up = TARGET_RATE / g;
  const down = rate / g;
  return up <= 4 && down <= 6 ? { up, down } : null;
}

/**
 * The low-pass filter, at the rate the sound has once `up` zeros stand
 * between its samples: a windowed sinc, cut a little under half the lower of
 * the two rates, with a Blackman window. Its gain at rest is `up`, which
 * makes up for the zeros.
 */
export function lowPass(up: number, down: number): Float32Array {
  const widest = Math.max(up, down);
  const half = 16 * widest;
  const taps = new Float32Array(2 * half + 1);
  // In cycles per sample: half the lower rate is 0.5 / widest; 0.94 of it leaves the filter room to fall.
  const cutoff = (0.5 / widest) * 0.94;
  let sum = 0;
  for (let k = 0; k <= 2 * half; k += 1) {
    const x = k - half;
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
    const window = 0.42 - 0.5 * Math.cos((2 * Math.PI * k) / (2 * half)) + 0.08 * Math.cos((4 * Math.PI * k) / (2 * half));
    taps[k] = sinc * window;
    sum += taps[k];
  }
  for (let k = 0; k < taps.length; k += 1) taps[k] = (taps[k] / sum) * up;
  return taps;
}

/** One stretch of sound, brought down piece by piece: the pieces join without a seam. */
export interface Resampler {
  process(samples: Int16Array): Int16Array;
}

export function createResampler(rate: number): Resampler | null {
  const ratio = ratioFor(rate);
  if (!ratio) return null;
  const { up, down } = ratio;
  const taps = lowPass(up, down);
  const length = taps.length;
  /** The samples still needed: the newest ones, as many as the filter reaches back over. */
  let kept = new Float32Array(0);
  /** Where the next sample out stands, counted in the raised rate from `kept[0]`. */
  let at = 0;
  return {
    process(samples) {
      const input = new Float32Array(kept.length + samples.length);
      input.set(kept);
      for (let i = 0; i < samples.length; i += 1) input[kept.length + i] = samples[i];
      const out: number[] = [];
      // A sample out at `at` is the filter laid over the raised sound ending there: of the input, only every `up`-th place holds a sample.
      for (; Math.floor(at / up) < input.length; at += down) {
        let sum = 0;
        const newest = Math.floor(at / up);
        const oldest = Math.max(0, Math.ceil((at - length + 1) / up));
        for (let i = oldest; i <= newest; i += 1) sum += input[i] * taps[at - i * up];
        out.push(sum > 32767 ? 32767 : sum < -32768 ? -32768 : Math.round(sum));
      }
      // What the next sample out still reaches back over is kept; the count restarts from there.
      const drop = Math.max(0, Math.min(input.length, Math.ceil((at - length + 1) / up)));
      kept = input.slice(drop);
      at -= drop * up;
      return Int16Array.from(out);
    },
  };
}
