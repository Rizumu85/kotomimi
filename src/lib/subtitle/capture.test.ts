import { describe, expect, it } from 'vitest';
import fixture from './__fixtures__/capture.json';
import { createSubtitleRecorder, readSubtitleCapture, replaySubtitleCapture, type SubtitleCapture, type SubtitleCaptureState } from './capture';
import { CAPTURE_MAX_BYTES, CAPTURE_MAX_FRAMES } from './captureFormat';

const loadedFixture = readSubtitleCapture(JSON.stringify(fixture), fixture.appVersion);
if (!loadedFixture.ok) throw new Error(loadedFixture.error);
const capture = loadedFixture.capture;
const initial = capture.frames[0].state as SubtitleCaptureState;

describe('subtitle capture recorder', () => {
  it('retains the state at the minute boundary through hours of changes, with an owned snapshot', () => {
    let now = 0;
    const recorder = createSubtitleRecorder(() => now, () => 100_000);
    for (; now <= 3_600_000; now += 1000) recorder.record({ ...initial, lit: [['t', now]] });
    now = 3_600_000;
    const result = recorder.snapshot()!;
    expect(result.frames).toHaveLength(61);
    expect(result.startedAt).toBe(3_640_000);
    expect(result.durationMs).toBe(60_000);
    expect(result.frames[0]).toMatchObject({ at: 0, state: { lit: [['t', 3_540_000]] } });
    expect(result.truncated).toBe(false);
    expect(result.frames[0].state.entries).not.toBe(initial.entries);
    now += 120_000;
    expect(recorder.snapshot()).toMatchObject({ durationMs: 60_000, frames: [{ at: 0, state: { lit: [['t', 3_600_000]] } }] });
  });

  it('keeps the predecessor at an in-between boundary and ignores duplicate states', () => {
    let now = 0;
    const recorder = createSubtitleRecorder(() => now);
    recorder.record(initial);
    now = 10_000;
    recorder.record({ ...initial, lit: [] });
    now = 65_000;
    recorder.record({ ...initial, lit: [] });
    const saved = recorder.snapshot()!;
    expect(saved.frames.map((frame) => frame.at)).toEqual([0, 5000]);
    expect(saved.frames[0].state.lit).toEqual(initial.lit);
  });

  it('bounds event count even when the clock does not advance', () => {
    const recorder = createSubtitleRecorder(() => 0);
    for (let i = 0; i < CAPTURE_MAX_FRAMES + 20; i++) recorder.record({ ...initial, lit: [['t', i]] });
    const result = recorder.snapshot()!;
    expect(result.frames.length).toBeLessThanOrEqual(CAPTURE_MAX_FRAMES);
    expect(result.truncated).toBe(true);
    expect(result.frames[result.frames.length - 1].state.lit).toEqual([['t', CAPTURE_MAX_FRAMES + 19]]);
  });

  it('keeps a full minute of 60 Hz karaoke without repeating text and merges deltas at the boundary', () => {
    let now = 0;
    const recorder = createSubtitleRecorder(() => now);
    const text = { ...initial, entries: [{ kind: 'notice' as const, id: 'long', leg: 'speaker' as const, severity: 'info' as const, message: 'x'.repeat(100_000), at: 0 }] };
    recorder.record(text);
    for (let i = 1; i <= 4000; i++) { now = i * 16; recorder.record({ ...text, lit: [['t', i]] }); }
    const saved = recorder.snapshot()!;
    expect(saved.durationMs).toBe(60_000);
    expect(saved.truncated).toBe(false);
    expect(saved.frames[0].state.entries).toEqual(text.entries);
    expect(saved.frames[1].state.entries).toBeUndefined();
    expect(JSON.stringify(saved).length).toBeLessThan(400_000);
    const loaded = readSubtitleCapture(JSON.stringify({ ...capture, ...saved }), capture.appVersion);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(replaySubtitleCapture(loaded.capture, 60_000).model.lit.get('t')).toBe(4000);
  });

  it('bounds payload memory and does not silently keep stale text after an oversized frame', () => {
    let now = 0;
    const recorder = createSubtitleRecorder(() => now);
    for (let i = 0; i < 30; i++) {
      now += 100;
      recorder.record({ ...initial, entries: [{ kind: 'notice', id: String(i), leg: 'speaker', severity: 'info', message: 'x'.repeat(400_000), at: 0 }] });
    }
    const result = recorder.snapshot()!;
    expect(result.frames.reduce((n, f) => n + JSON.stringify(f.state).length * 2, 0)).toBeLessThanOrEqual(CAPTURE_MAX_BYTES);
    expect(result.truncated).toBe(true);
    recorder.record({ ...initial, entries: [{ kind: 'notice', id: 'huge', leg: 'speaker', severity: 'info', message: 'x'.repeat(CAPTURE_MAX_BYTES), at: 0 }] });
    expect(recorder.snapshot()).toBeNull();
    recorder.record(initial);
    expect(recorder.snapshot()!.truncated).toBe(true);
  });
});

describe('subtitle capture replay boundary', () => {
  it('seeks independently in either direction, restores karaoke and preserves all layout inputs', () => {
    const next = { ...initial, lit: [['t', 30]] as const, viewport: { width: 400, height: 300, dpr: 2 } };
    const recording: SubtitleCapture = { ...capture, frames: [...capture.frames, { at: 500, state: next }, { at: 500, state: { ...next, held: {} } }] };
    expect(replaySubtitleCapture(recording, 499).model.lit.get('t')).toBe(12);
    expect(replaySubtitleCapture(recording, 500)).toMatchObject({ held: {}, viewport: next.viewport, now: capture.startedAt + 500 });
    expect(replaySubtitleCapture(recording, 2000).model.lit.get('t')).toBe(30);
    expect(replaySubtitleCapture(recording, -10)).toMatchObject({ settings: initial.settings, look: initial.look, annotation: initial.annotation, held: initial.held });
    const replay = replaySubtitleCapture(recording, 0);
    replay.model.lit.clear();
    expect(initial.lit).toEqual([['t', 12]]);
    expect(replay.model.entries).toEqual(initial.entries);
  });

  it('accepts the fixture and reports a different app version without rejecting its data', () => {
    expect(readSubtitleCapture(JSON.stringify(capture), capture.appVersion)).toEqual({ ok: true, capture, warning: null });
    expect(readSubtitleCapture(JSON.stringify(capture), 'new-version')).toMatchObject({ ok: true, warning: expect.stringContaining(capture.appVersion) });
  });

  it('expires transient notices by capture time even when no new frame arrived', () => {
    const recording: SubtitleCapture = { ...capture, durationMs: 10_000, frames: [{ at: 0, state: { ...initial,
      entries: [{ kind: 'notice', id: 'switch', leg: 'speaker', severity: 'info', message: 'Microphone changed', lifetime: 'transient', at: capture.startedAt }] } }] };
    expect(replaySubtitleCapture(recording, 7999).model.entries).toHaveLength(1);
    expect(replaySubtitleCapture(recording, 8000).model.entries).toHaveLength(0);
  });

  it.each([
    '{', JSON.stringify({ ...capture, version: 999 }),
    JSON.stringify({ ...capture, frames: [] }),
    JSON.stringify({ ...capture, frames: [{ at: 20, state: initial }] }),
    JSON.stringify({ ...capture, frames: [{ at: 0, state: { ...initial, entries: [{ kind: 'exchange' }] } }] }),
    JSON.stringify({ ...capture, frames: [{ at: 0, state: { ...initial, lit: [['t', 'bad']] } }] }),
    JSON.stringify({ ...capture, frames: [{ at: 0, state: { ...initial, audio: [1, 2] } }] }),
    JSON.stringify({ ...capture, frames: [{ at: 0, state: { ...initial, viewport: { width: 1, height: 1, dpr: 0 } } }] }),
  ])('rejects malformed or incompatible files without throwing', (json) => {
    expect(readSubtitleCapture(json, capture.appVersion)).toMatchObject({ ok: false, error: expect.any(String) });
  });
});
