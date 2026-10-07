import { describe, expect, it } from 'vitest';
import { createMicGate, GATE_FLOOR_DB, levelOf } from './micGate';

/** A chunk at a constant amplitude (its RMS), as a fraction of full scale. */
const tone = (length: number, amplitude: number): Int16Array => new Int16Array(length).fill(Math.round(amplitude * 32767));
const silent = (pcm: Int16Array) => pcm.every((s) => s === 0);
/** Silenced: zeros past the ramp a closing chunk begins with. */
const silenced = (pcm: Int16Array) => pcm.subarray(96).every((s) => s === 0);
const same = (a: Int16Array, b: Int16Array) => a.length === b.length && a.every((s, i) => s === b[i]);

// 10 ms chunks at 24 kHz; a lookahead of two chunks and a hold of four.
const RATE = 24_000;
const CHUNK = 240;
const LOOKAHEAD_MS = 20;
const HOLD_MS = 40;
const LOUD = 0.1; // −20 dBFS: level 66.7
const QUIET = 0.01; // −40 dBFS: level 33.3

function gateAt(threshold: number, over: { onLevel?: (level: number) => void } = {}) {
  const out: Int16Array[] = [];
  let level = threshold;
  const gate = createMicGate({
    threshold: () => level,
    deliver: (pcm) => out.push(pcm),
    onLevel: over.onLevel,
    sampleRate: RATE,
    lookaheadMs: LOOKAHEAD_MS,
    holdMs: HOLD_MS,
  });
  return { gate, out, setThreshold: (next: number) => { level = next; } };
}

describe('levelOf', () => {
  it('reads silence as 0, full scale as 100, and spreads the decibels between', () => {
    expect(levelOf(new Int16Array(CHUNK))).toBe(0);
    expect(levelOf(tone(CHUNK, 1))).toBeCloseTo(100, 0);
    // −20 dBFS over a floor of −60: two thirds of the way.
    expect(levelOf(tone(CHUNK, LOUD))).toBeCloseTo(((-20 - GATE_FLOOR_DB) / -GATE_FLOOR_DB) * 100, 0);
    expect(levelOf(tone(CHUNK, QUIET))).toBeCloseTo(33.3, 0);
    expect(levelOf(new Int16Array(0))).toBe(0);
  });
});

describe('createMicGate', () => {
  it('off, hands every chunk on at once and untouched', () => {
    const { gate, out } = gateAt(0);
    const a = tone(CHUNK, QUIET);
    const b = tone(CHUNK, LOUD);
    gate.push(a);
    gate.push(b);
    expect(out).toHaveLength(2);
    expect(same(out[0], a)).toBe(true);
    expect(same(out[1], b)).toBe(true);
    expect(gate.open).toBe(true);
  });

  it('tells the level of every chunk, gate on or off', () => {
    const levels: number[] = [];
    const { gate, setThreshold } = gateAt(0, { onLevel: (level) => levels.push(level) });
    gate.push(tone(CHUNK, LOUD));
    setThreshold(50);
    gate.push(tone(CHUNK, QUIET));
    expect(levels.map((level) => Math.round(level))).toEqual([67, 33]);
  });

  it('on, decides a chunk only once the lookahead after it has arrived', () => {
    const { gate, out } = gateAt(50);
    gate.push(tone(CHUNK, QUIET));
    gate.push(tone(CHUNK, QUIET));
    expect(out).toHaveLength(0);
    gate.push(tone(CHUNK, QUIET));
    expect(out).toHaveLength(1);
  });

  it('silences what stays under the threshold — zeros of the chunk’s length, never a dropped chunk', () => {
    const { gate, out } = gateAt(50);
    for (let i = 0; i < 6; i++) gate.push(tone(CHUNK, QUIET));
    expect(out).toHaveLength(4);
    for (const pcm of out) {
      expect(pcm.length).toBe(CHUNK);
      expect(silent(pcm)).toBe(true);
    }
    expect(gate.open).toBe(false);
  });

  it('hears the chunks before a loud one, as far back as the lookahead reaches', () => {
    const { gate, out } = gateAt(50);
    const before = [tone(CHUNK, QUIET), tone(CHUNK, QUIET), tone(CHUNK, QUIET)];
    for (const pcm of before) gate.push(pcm);
    // One decided quiet, before any loud chunk came.
    expect(out).toHaveLength(1);
    expect(silent(out[0])).toBe(true);
    gate.push(tone(CHUNK, LOUD));
    // The two within the lookahead of the loud chunk are heard: the second one whole, the first faded in.
    expect(out).toHaveLength(2);
    expect(silent(out[1])).toBe(false);
    expect(out[1][0]).toBe(0);
    expect(out[1][CHUNK - 1]).toBe(before[1][CHUNK - 1]);
    gate.push(tone(CHUNK, QUIET));
    expect(same(out[2], before[2])).toBe(true);
  });

  it('stays open for the hold after the last loud chunk, then closes', () => {
    const { gate, out } = gateAt(50);
    gate.push(tone(CHUNK, LOUD));
    // Eight quiet chunks after it: the four within the hold are heard, the rest silenced.
    for (let i = 0; i < 8; i++) gate.push(tone(CHUNK, QUIET));
    // Nine pushed, the last two still waiting on their lookahead.
    expect(out).toHaveLength(7);
    expect(out.slice(0, 5).map(silenced)).toEqual([false, false, false, false, false]);
    expect(out.slice(5).map(silenced)).toEqual([true, true]);
    // The first silenced chunk ramps down; the one after it is zeros throughout.
    expect(silent(out[5])).toBe(false);
    expect(silent(out[6])).toBe(true);
    expect(gate.open).toBe(false);
  });

  it('fades the edges: the chunk that opens ramps up from zero, the one that closes ramps down to it', () => {
    const { gate, out } = gateAt(50);
    const opener = tone(CHUNK, LOUD);
    gate.push(opener);
    for (let i = 0; i < 7; i++) gate.push(tone(CHUNK, QUIET));
    const first = out[0];
    expect(first[0]).toBe(0);
    expect(first[48]).toBeGreaterThan(0);
    expect(first[48]).toBeLessThan(opener[48]);
    expect(first[96]).toBe(opener[96]);
    // The fifth after the loud one is the first silenced: it begins at full and is zero by the end of the ramp.
    const closer = out[5];
    expect(closer[0]).toBe(tone(CHUNK, QUIET)[0]);
    expect(closer[95]).toBeGreaterThanOrEqual(0);
    expect(closer[96]).toBe(0);
    expect(closer[CHUNK - 1]).toBe(0);
  });

  it('switched off mid-stream, hears what was waiting, then everything, at once', () => {
    const { gate, out, setThreshold } = gateAt(50);
    const waiting = [tone(CHUNK, QUIET), tone(CHUNK, QUIET), tone(CHUNK, QUIET)];
    for (const pcm of waiting) gate.push(pcm);
    expect(out).toHaveLength(1);
    setThreshold(0);
    const next = tone(CHUNK, QUIET);
    gate.push(next);
    expect(out).toHaveLength(4);
    // The first of the two that waited opens the gate, so it is faded in; the rest are as they were.
    expect(out[1][CHUNK - 1]).toBe(waiting[1][CHUNK - 1]);
    expect(same(out[2], waiting[2])).toBe(true);
    expect(same(out[3], next)).toBe(true);
  });

  it('reset forgets what waited and closes the gate', () => {
    const { gate, out } = gateAt(50);
    gate.push(tone(CHUNK, LOUD));
    gate.push(tone(CHUNK, LOUD));
    expect(out).toHaveLength(0);
    gate.reset();
    expect(gate.open).toBe(false);
    // Nothing of the two is ever delivered; the next chunks wait their own lookahead.
    gate.push(tone(CHUNK, QUIET));
    gate.push(tone(CHUNK, QUIET));
    expect(out).toHaveLength(0);
    gate.push(tone(CHUNK, QUIET));
    expect(out).toHaveLength(1);
    expect(silent(out[0])).toBe(true);
  });

  it('takes the threshold live: a chunk over a lowered threshold opens the gate', () => {
    const { gate, out, setThreshold } = gateAt(80);
    gate.push(tone(CHUNK, LOUD));
    gate.push(tone(CHUNK, LOUD));
    gate.push(tone(CHUNK, LOUD));
    expect(silent(out[0])).toBe(true);
    setThreshold(50);
    gate.push(tone(CHUNK, LOUD));
    expect(silent(out[1])).toBe(false);
  });
});
