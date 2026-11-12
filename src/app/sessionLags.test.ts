import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { Entry, Row } from '../lib/projection/types';
import type { RunState } from '../lib/session/types';
import { realClock } from '../lib/contract/clock';
import { createSessionLags, driveSessionLags, type LagModels } from './sessionLags';

const row = (text: string): Row => ({ key: text, segmentId: text, side: 'source', text, start: 0, end: text.length, final: true });
const entry = (id: string, leg: 'speaker' | 'participant' = 'speaker', translated = false): Entry => ({ kind: 'exchange', id, leg, t: 0, languages: { source: 'ja', target: 'en' }, pairing: 'stated', source: [row('hello')], translation: translated ? [{ ...row('world'), side: 'translation' }] : [] });
const models: LagModels = { speaker: 'mine', participant: 'theirs', translation: 'translator' };
afterEach(() => vi.useRealTimers());

describe('session lag measurement', () => {
  it('requires five samples strictly above the threshold and reports only once for the session', () => {
    const lags = createSessionLags();
    lags.begin();
    for (let i = 0; i < 4; i++) lags.sample('speaker', 'mine', 2200);
    expect(lags.state.getState().notice).toBeNull();
    lags.sample('speaker', 'mine', 2200);
    const first = lags.state.getState().notice;
    expect(first).toEqual({ stage: 'speaker', model: 'mine', averageMS: 2200 });
    for (let i = 0; i < 5; i++) lags.sample('translation', 'translator', 4000);
    expect(lags.state.getState().notice).toBe(first);
    expect(lags.state.getState().fallingBehind.translation?.model).toBe('translator');
    for (let i = 0; i < 5; i++) lags.sample('speaker', 'new', 8000);
    expect(lags.state.getState().fallingBehind.speaker).toBe(first);
  });
  it('uses exactly the latest five, isolated by side and model', () => {
    const lags = createSessionLags(); lags.begin();
    for (let i = 0; i < 5; i++) lags.sample('participant', 'same', 2000);
    expect(lags.state.getState().notice).toBeNull();
    lags.sample('speaker', 'same', 10000);
    lags.sample('participant', 'different', 10000);
    expect(lags.state.getState().notice).toBeNull();
    lags.sample('participant', 'same', 3000);
    expect(lags.average('participant', 'same')).toBe(2200);
    expect(lags.state.getState().notice?.stage).toBe('participant');
    expect(lags.average('speaker', 'missing')).toBeUndefined();
  });
  it('measures both recognizers from the end of sound and translation from final source, once per entry', () => {
    const lags = createSessionLags(); lags.begin();
    lags.sound('speaker', true, 0); lags.sound('speaker', false, 500);
    lags.sound('participant', true, 0); lags.sound('participant', false, 700);
    lags.measure([entry('a'), entry('a', 'participant')], models, 1500);
    expect(lags.average('speaker', 'mine')).toBe(1000);
    expect(lags.average('participant', 'theirs')).toBe(800);
    lags.measure([entry('a', 'speaker', true), entry('a', 'participant', true)], models, 5100);
    expect(lags.average('translation', 'translator')).toBe(3600);
    lags.measure([entry('a', 'speaker', true)], models, 20000);
    expect(lags.average('speaker', 'mine')).toBe(1000);
    expect(lags.average('translation', 'translator')).toBe(3600);
  });
  it('does not discard severe lag, and leaves unknown/unsounded stages unmeasured', () => {
    const lags = createSessionLags(); lags.begin();
    lags.sound('speaker', true, 0); lags.sound('speaker', false, 500);
    lags.measure([entry('a')], models, 15000);
    expect(lags.average('speaker', 'mine')).toBe(14500);
    lags.measure([entry('b', 'participant')], models, 15000);
    expect(lags.average('participant', 'theirs')).toBeUndefined();
    lags.measure([entry('c')], { speaker: null, participant: null, translation: null }, 18000);
    expect(lags.average('speaker', 'mine')).toBe(14500);
  });
  it('excludes video, unfinished and empty sources, and feedback without translation', () => {
    const lags = createSessionLags(); lags.begin();
    lags.sound('speaker', true, 0); lags.sound('speaker', false, 100);
    const e = entry('a');
    if (e.kind !== 'exchange') throw new Error('fixture');
    lags.measure([{ ...e, lane: 'video' }, { ...e, id: 'b', source: [{ ...row('x'), final: false }] }, { ...e, id: 'c', source: [] }], models, 500);
    expect(lags.state.getState().averages).toEqual({});
    lags.measure([{ ...e, feedback: [row('feedback')] }], models, 500);
    expect(lags.average('translation', 'translator')).toBeUndefined();
  });
  it('ignores invalid samples and resets all state at both session boundaries', () => {
    const lags = createSessionLags();
    lags.sample('speaker', 'mine', 8000);
    expect(lags.state.getState().averages).toEqual({});
    lags.begin();
    for (const value of [-1, NaN, Infinity]) lags.sample('speaker', 'mine', value);
    expect(lags.state.getState().averages).toEqual({});
    for (let i = 0; i < 5; i++) lags.sample('translation', 'translator', 3000);
    expect(lags.state.getState().notice).toBeNull();
    lags.sample('translation', 'translator', 4000);
    expect(lags.state.getState().notice).not.toBeNull();
    lags.end();
    expect(lags.state.getState()).toEqual({ averages: {}, fallingBehind: {}, notice: null });
    lags.begin();
    for (let i = 0; i < 5; i++) lags.sample('speaker', 'mine', 2500);
    expect(lags.state.getState().notice?.model).toBe('mine');
  });
});

describe('runner measurement driver', () => {
  it('measures without VR, ignores kept conversation, clears on end and detaches all timers', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const run = createStore<RunState>(() => ({ phase: 'idle' }));
    const view = createStore(() => ({ entries: [entry('old')] }));
    const lags = createSessionLags();
    let heard = true;
    const off = driveSessionLags({ runner: { state: run }, view: { get: view.getState, subscribe: view.subscribe },
      clock: realClock, lags, models: () => models,
      levels: async () => ({ speaker: { push() {}, reset() {}, heard: () => heard }, participant: { push() {}, reset() {}, heard: () => false } }),
    });
    run.setState({ phase: 'running', since: 0, legs: {} }, true);
    await Promise.resolve();
    vi.advanceTimersByTime(250); heard = false; vi.advanceTimersByTime(250);
    vi.advanceTimersByTime(900);
    view.setState({ entries: [entry('old'), entry('new')] });
    expect(lags.average('speaker', 'mine')).toBe(900);
    run.setState({ phase: 'idle' }, true);
    expect(lags.state.getState().averages).toEqual({});
    expect(vi.getTimerCount()).toBe(0);
    off();
  });
  it('drops late level acquisition after a session ends', async () => {
    vi.useFakeTimers();
    const run = createStore<RunState>(() => ({ phase: 'running', since: 0, legs: {} }));
    let resolve!: (value: null) => void;
    const lags = createSessionLags();
    const off = driveSessionLags({ runner: { state: run }, view: { get: () => ({ entries: [] }), subscribe: () => () => {} },
      levels: () => new Promise((done) => { resolve = done; }), models: () => models, clock: realClock, lags });
    run.setState({ phase: 'idle' }, true); resolve(null); await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
    expect(lags.state.getState().notice).toBeNull(); off();
  });
});
