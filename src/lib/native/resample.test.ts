import { describe, expect, it } from 'vitest';
import { createResampler, lowPass, ratioFor, TARGET_RATE } from './resample';

/** A tone at a rate, as the app hears sound: 16-bit samples. */
function tone(frequency: number, rate: number, seconds: number, amplitude = 10000): Int16Array {
  const out = new Int16Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i += 1) out[i] = Math.round(amplitude * Math.sin((2 * Math.PI * frequency * i) / rate));
  return out;
}

/** How loud a stretch is, away from its two ends (where the filter is still filling). */
function loudness(samples: Int16Array): number {
  const edge = Math.min(400, Math.floor(samples.length / 4));
  let sum = 0;
  for (let i = edge; i < samples.length - edge; i += 1) sum += samples[i] * samples[i];
  return Math.sqrt(sum / (samples.length - 2 * edge));
}

/** How much of a stretch is a tone of this frequency: the amplitude of that tone in it. */
function amplitudeAt(samples: Int16Array, frequency: number, rate: number): number {
  const edge = 400;
  let re = 0;
  let im = 0;
  const n = samples.length - 2 * edge;
  for (let i = 0; i < n; i += 1) {
    const phase = (2 * Math.PI * frequency * (i + edge)) / rate;
    re += samples[i + edge] * Math.cos(phase);
    im += samples[i + edge] * Math.sin(phase);
  }
  return (2 * Math.hypot(re, im)) / n;
}

describe('the rates brought down to 16 kHz here', () => {
  it('are the ones a small ratio away: the app\'s own 24 kHz, 32 and 48', () => {
    expect(ratioFor(24000)).toEqual({ up: 2, down: 3 });
    expect(ratioFor(32000)).toEqual({ up: 1, down: 2 });
    expect(ratioFor(48000)).toEqual({ up: 1, down: 3 });
  });

  it('are no others: a rate at or under 16 kHz, or an awkward one, is the engine\'s to take as it is', () => {
    expect(ratioFor(16000)).toBeNull();
    expect(ratioFor(8000)).toBeNull();
    expect(ratioFor(44100)).toBeNull();
    expect(createResampler(44100)).toBeNull();
    expect(createResampler(16000)).toBeNull();
  });
});

describe('the low-pass filter', () => {
  it('is symmetric, and passes a steady level at the gain that makes up for the zeros', () => {
    const taps = lowPass(2, 3);
    expect(taps.length % 2).toBe(1);
    for (let k = 0; k < taps.length; k += 1) expect(taps[k]).toBeCloseTo(taps[taps.length - 1 - k], 6);
    expect(taps.reduce((a, b) => a + b, 0)).toBeCloseTo(2, 4);
  });
});

describe('sound brought down from 24 kHz', () => {
  it('has two samples for every three, and a voice\'s tones as loud as they were', () => {
    const resampler = createResampler(24000)!;
    const out = resampler.process(tone(1000, 24000, 1));
    expect(Math.abs(out.length - TARGET_RATE)).toBeLessThanOrEqual(2);
    expect(amplitudeAt(out, 1000, TARGET_RATE)).toBeGreaterThan(9900);
    expect(amplitudeAt(out, 1000, TARGET_RATE)).toBeLessThan(10100);
    // Still whole near the top of what speech uses.
    const high = createResampler(24000)!.process(tone(6000, 24000, 1));
    expect(amplitudeAt(high, 6000, TARGET_RATE)).toBeGreaterThan(9500);
  });

  it('holds nothing of what 16 kHz cannot: a tone above its half does not come back as another', () => {
    // 10 kHz would fold to 6 kHz; 9 kHz to 7 kHz.
    for (const frequency of [9000, 10000, 11000]) {
      const out = createResampler(24000)!.process(tone(frequency, 24000, 1));
      expect(loudness(out)).toBeLessThan(10000 * 0.01);
    }
  });

  it('joins pieces without a seam: given a piece at a time, it writes what it writes given the whole', () => {
    const whole = tone(440, 24000, 1);
    const once = createResampler(24000)!.process(whole);
    const piecewise = createResampler(24000)!;
    const parts: number[] = [];
    // Pieces of awkward lengths, as a recorder gives them.
    for (let at = 0, size = 1; at < whole.length; at += size, size = (size * 7 + 13) % 4099 || 1) parts.push(...piecewise.process(whole.subarray(at, Math.min(whole.length, at + size))));
    expect(parts).toEqual(Array.from(once));
  });

  it('keeps a loud sound within 16 bits', () => {
    const out = createResampler(24000)!.process(new Int16Array(24000).map((_, i) => (i % 2 ? 32767 : -32768)));
    for (const sample of out) {
      expect(sample).toBeLessThanOrEqual(32767);
      expect(sample).toBeGreaterThanOrEqual(-32768);
    }
  });
});

describe('sound brought down from 48 kHz', () => {
  it('has one sample for every three, the tones as loud as they were', () => {
    const out = createResampler(48000)!.process(tone(1000, 48000, 1));
    expect(Math.abs(out.length - TARGET_RATE)).toBeLessThanOrEqual(2);
    expect(amplitudeAt(out, 1000, TARGET_RATE)).toBeGreaterThan(9900);
    expect(loudness(createResampler(48000)!.process(tone(12000, 48000, 1)))).toBeLessThan(100);
  });
});
