import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { RunState } from '../lib/session/types';
import type { Entry, Row } from '../lib/projection/types';
import { createSessionRecording, markSessionLine, openSessionRecordings } from './sessionRecording';

const mocks = vi.hoisted(() => ({
  enabled: false, electron: true, settingChanged: (_on: boolean) => {},
  begin: vi.fn(async () => true), end: vi.fn(async () => {}), record: vi.fn(async (_cb: unknown) => true),
  stop: vi.fn(), invoke: vi.fn(async (_channel: string, _data?: unknown) => ({ ok: true })), report: vi.fn(),
}));
vi.mock('../stores/settingsStore', () => ({ useSettingsStore: {
  getState: () => ({ recordSessions: mocks.enabled }),
  subscribe: (_selector: unknown, cb: (on: boolean) => void) => { mocks.settingChanged = cb; return () => {}; },
} }));
vi.mock('../utils/environment', () => ({ isElectron: () => mocks.electron }));
vi.mock('../lib/diagnostics/report', () => ({ reportError: (...args: unknown[]) => mocks.report(...args), describeCause: String }));
vi.mock('../lib/audio/appCapture', () => ({ micSettings: () => ({
  deviceId: () => 'chosen-mic', deviceLabel: () => 'Headset', echoCancellation: () => 'all',
}) }));
vi.mock('../lib/modern-audio/DeviceCaptureRecorder', () => ({ DeviceCaptureRecorder: class {
  begin = mocks.begin; end = mocks.end; record = mocks.record;
  getStream() { return { getTracks: () => [{ stop: mocks.stop }], getAudioTracks: () => [{
    label: 'Raw headset', getSettings: () => ({ deviceId: 'chosen-mic', echoCancellation: false, noiseSuppression: false, autoGainControl: false }),
    addEventListener: () => {},
  }] }; }
} }));
const drain = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
let now: number;
beforeEach(() => {
  mocks.enabled = true; mocks.electron = true;
  mocks.invoke.mockReset().mockResolvedValue({ ok: true });
  mocks.begin.mockReset().mockResolvedValue(true);
  mocks.end.mockClear(); mocks.record.mockClear(); mocks.stop.mockClear(); mocks.report.mockClear();
  now = 10000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  Object.defineProperty(window, 'electron', { configurable: true, value: { invoke: mocks.invoke } });
});
afterEach(() => vi.restoreAllMocks());

const row = (value: string, final = true): Row => ({ key: value, segmentId: value, side: 'source', start: 0, end: value.length, text: value, final });
function exchange(id: string, extra = {}): Extract<Entry, { kind: 'exchange' }> {
  return { kind: 'exchange', id, leg: 'speaker', languages: { source: 'en', target: 'ja' }, pairing: 'stated',
    source: [row('hello')], translation: [], t: 10001, ...extra };
}
function fixture() {
  const state = createStore<RunState>(() => ({ phase: 'idle' }));
  const viewState = createStore<{ entries: Entry[] }>(() => ({ entries: [] }));
  const flush = vi.fn();
  const recording = createSessionRecording();
  const off = recording.drive({ runner: { state }, view: { get: viewState.getState, subscribe: viewState.subscribe, flush }, metadata: () => ({ provider: 'test' }) });
  return { state, viewState, recording, off, flush };
}
const writes = (kind: string) => mocks.invoke.mock.calls.filter(([c, p]) => c === 'session-recording:write' && (p as { kind: string }).kind === kind)
  .map(([, p]) => p as { data: Record<string, unknown>; pcm: Int16Array; ms: number });

describe('session recorder driver', () => {
  it('records each final stage once, excludes old/video entries, and flushes final view on end', async () => {
    const f = fixture();
    f.state.setState({ phase: 'starting', step: 'checking' });
    await drain();
    expect(mocks.begin).toHaveBeenCalledWith({ deviceId: 'chosen-mic' });
    expect(writes('track')[0].data).toMatchObject({ kind: 'raw', settings: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    f.state.setState({ phase: 'running' } as RunState);
    now = 10100;
    f.viewState.setState({ entries: [exchange('old', { t: 9000 }), exchange('video', { lane: 'video' }), exchange('a')] });
    f.viewState.setState({ entries: [exchange('a')] });
    f.viewState.setState({ entries: [exchange('a', { translation: [row('konnichiwa', false)] })] });
    await drain();
    expect(writes('line')).toHaveLength(1);
    f.flush.mockImplementation(() => f.viewState.setState({ entries: [exchange('a', { translation: [row('konnichiwa')] })] }));
    now = 10200;
    f.state.setState({ phase: 'idle' });
    await f.recording.settled();
    expect(writes('line').map((p) => p.data.stage)).toEqual(['source', 'translation']);
    expect(writes('line')[1].data).toMatchObject({ lineWallTime: 10001, ms: 200, wallTime: 10200 });
    expect(mocks.invoke).toHaveBeenLastCalledWith('session-recording:end', { endedAt: 10200, durationMs: 200 });
    expect(mocks.stop).toHaveBeenCalled();
    f.off();
  });

  it('omits undetected languages and records reported languages independently of the leg pair', async () => {
    const f = fixture();
    f.state.setState({ phase: 'starting', step: 'checking' });
    await drain();
    f.viewState.setState({ entries: [
      exchange('undetected', { leg: 'participant', languages: { source: 'es', target: 'en' },
        source: [row('こんにちは')], translation: [row('Hello')] }),
      exchange('detected', { leg: 'participant', languages: { source: 'es', target: 'en' },
        source: [{ ...row('こんにちは'), language: 'ja' }],
        translation: [{ ...row('你好'), language: 'zh' }, row('Hello')] }),
    ] });
    await drain();
    // Match the JSONL representation: unknown languages must be absent, not inferred from the pair.
    const lines = writes('line').map(({ data }) => JSON.parse(JSON.stringify(data)));
    for (const line of lines.filter((line) => line.entryId === 'undetected')) {
      expect(line).not.toHaveProperty('sourceLanguage');
      expect(line.translations).toEqual([{ text: 'Hello' }]);
    }
    for (const line of lines.filter((line) => line.entryId === 'detected')) {
      expect(line.sourceLanguage).toBe('ja');
      expect(line.translations).toEqual([{ text: '你好', language: 'zh' }, { text: 'Hello' }]);
    }
    expect(lines).toHaveLength(4);
    f.off(); await f.recording.settled();
  });

  it('copies audio at arrival and keeps processed track changes', async () => {
    const f = fixture();
    f.state.setState({ phase: 'starting', step: 'checking' });
    await drain();
    const pcm = Int16Array.from([1, 2, 3]);
    now += 30;
    f.recording.pcm('speaker', pcm);
    pcm.fill(0);
    f.recording.track({ kind: 'processed', settings: { deviceId: 'new-mic', echoCancellation: 'all' } });
    await drain();
    expect(Array.from(writes('pcm')[0].pcm)).toEqual([1, 2, 3]);
    expect(writes('pcm')[0].ms).toBe(30);
    expect(writes('track')[1].data).toMatchObject({ ms: 30, settings: { deviceId: 'new-mic' } });
    f.off(); await f.recording.settled();
  });

  it.each([['disabled', false, true], ['web', true, false]] as const)('does nothing when %s', async (_name, enabled, electron) => {
    mocks.enabled = enabled; mocks.electron = electron;
    const f = fixture(); f.state.setState({ phase: 'starting', step: 'checking' });
    f.recording.pcm('speaker', new Int16Array(24));
    await drain();
    expect(mocks.invoke).not.toHaveBeenCalled(); expect(mocks.begin).not.toHaveBeenCalled();
    f.off();
  });

  it('stops on disabling and does not restart within the same run', async () => {
    const f = fixture(); f.state.setState({ phase: 'starting', step: 'checking' }); await drain();
    mocks.settingChanged(false); await f.recording.settled();
    mocks.settingChanged(true);
    f.state.setState({ phase: 'starting', step: 'preparing' });
    f.recording.pcm('speaker', new Int16Array(24)); await drain();
    expect(mocks.invoke.mock.calls.filter(([c]) => c === 'session-recording:start')).toHaveLength(1);
    expect(writes('pcm')).toHaveLength(0);
    f.off();
  });

  it('closes the WAV without waiting for a pending raw-device permission, then releases a late stream', async () => {
    let resolve!: (value: boolean) => void;
    mocks.begin.mockImplementation(() => new Promise<boolean>((done) => { resolve = done; }));
    const f = fixture(); f.state.setState({ phase: 'starting', step: 'checking' }); await drain();
    f.state.setState({ phase: 'idle' }); await f.recording.settled();
    expect(mocks.invoke).toHaveBeenLastCalledWith('session-recording:end', expect.anything());
    resolve(true); await drain();
    expect(mocks.record).not.toHaveBeenCalled(); expect(mocks.end).toHaveBeenCalled();
    f.off();
  });

  it('reports a failing write once and drops subsequent chunks', async () => {
    const f = fixture(); f.state.setState({ phase: 'starting', step: 'checking' }); await drain();
    mocks.invoke.mockRejectedValueOnce(new Error('disk full'));
    f.recording.pcm('speaker', new Int16Array(24));
    f.recording.pcm('participant', new Int16Array(24));
    await drain();
    f.recording.pcm('speaker', new Int16Array(24)); await drain();
    expect(mocks.report).toHaveBeenCalledTimes(1);
    expect(writes('pcm')).toHaveLength(1);
    f.off(); await f.recording.settled();
  });

  it('bounds audio queued behind a slow disk and reports overflow once', async () => {
    const f = fixture(); f.state.setState({ phase: 'starting', step: 'checking' }); await drain();
    let release!: (result: { ok: boolean }) => void;
    mocks.invoke.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const pcm = new Int16Array(24000);
    for (let i = 0; i < 200; i++) f.recording.pcm('speaker', pcm);
    await drain();
    expect(mocks.report).toHaveBeenCalledTimes(1);
    expect(mocks.stop).toHaveBeenCalled();
    release({ ok: true });
    f.off(); await f.recording.settled();
    expect(writes('pcm').length * pcm.byteLength).toBeLessThanOrEqual(8 * 1024 * 1024);
  });
});

it('marks a line using its original wall time and opens the folder', async () => {
  const entry = exchange('old', { t: 123, translation: [row('hi')] });
  expect(await markSessionLine(entry)).toEqual({ ok: true });
  expect(mocks.invoke).toHaveBeenLastCalledWith('session-recording:mark', {
    wallTime: 123, leg: 'speaker', entryId: 'old', sourceText: 'hello', translationText: 'hi', markedAt: 10000,
  });
  expect(await openSessionRecordings()).toEqual({ ok: true });
  expect(mocks.invoke).toHaveBeenLastCalledWith('session-recording:open', undefined);
});
