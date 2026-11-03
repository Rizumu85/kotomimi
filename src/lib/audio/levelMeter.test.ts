import { describe, it, expect } from 'vitest';
import { SAMPLE_RATE } from '../contract/adapter';
import { createVirtualClock } from '../contract/clock';
import { createLevelMeter, HEARD_HOLD_MS, rmsOf } from './levelMeter';

/** `ms` of a sine at 440 Hz, its peak `dbfs` below full scale (32768), rounded to Int16. */
const sine = (dbfs: number, ms: number): Int16Array => {
  const amplitude = Math.min(32767, 32768 * 10 ** (dbfs / 20));
  return Int16Array.from({ length: (SAMPLE_RATE * ms) / 1000 }, (_, i) => Math.round(amplitude * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE)));
};
const silence = (ms: number): Int16Array => new Int16Array((SAMPLE_RATE * ms) / 1000);

describe('createLevelMeter', () => {
  it('hears nothing before any chunk, and nothing in silence', () => {
    const meter = createLevelMeter(createVirtualClock(0));
    expect(meter.heard()).toBe(false);
    meter.push(silence(100));
    expect(meter.heard()).toBe(false);
  });

  it('hears speech-loud sound, and not a quiet room', () => {
    const meter = createLevelMeter(createVirtualClock(0));
    // A sine's RMS is 3 dB under its peak: -40 dBFS peak is speech, -60 is the room under noise suppression.
    meter.push(sine(-60, 100));
    expect(meter.heard()).toBe(false);
    meter.push(sine(-40, 100));
    expect(meter.heard()).toBe(true);
  });

  it('stays heard over the gap between words, and stops after it', () => {
    const clock = createVirtualClock(0);
    const meter = createLevelMeter(clock);
    meter.push(sine(-30, 100));
    clock.advance(HEARD_HOLD_MS);
    meter.push(silence(100));
    expect(meter.heard()).toBe(true);
    clock.advance(1);
    expect(meter.heard()).toBe(false);
  });

  it('hears nothing once reset', () => {
    const meter = createLevelMeter(createVirtualClock(0));
    meter.push(sine(-30, 100));
    meter.reset();
    expect(meter.heard()).toBe(false);
  });

  it('measures a chunk by its RMS', () => {
    expect(rmsOf(new Int16Array(0))).toBe(0);
    expect(rmsOf(Int16Array.from([3, -3, 3, -3]))).toBe(3);
  });
});
