import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import useAudioStore from '../../stores/audioStore';
import * as diagnostics from '../diagnostics/report';
import { AppAudioRecorder } from '../modern-audio/AppAudioRecorder';
import { LoopbackRecorder } from '../modern-audio/LoopbackRecorder';
import { createAppCapture } from './appCapture';
import { createSourceCore } from './capture/core';
import { openMic } from './capture/mic';
import type { Playback } from './playback';

vi.mock('./capture/mic', () => ({ openMic: vi.fn() }));
vi.mock('../modern-audio/LoopbackRecorder', () => ({ LoopbackRecorder: vi.fn() }));
vi.mock('../modern-audio/AppAudioRecorder', () => ({ AppAudioRecorder: vi.fn() }));

const stereo = { mono: Int16Array.of(16000), left: Int16Array.of(20000), right: Int16Array.of(12000) };

function recorder() {
  let push: (chunk: { mono: Int16Array; left?: Int16Array; right?: Int16Array }) => void = () => {};
  return {
    begin: vi.fn(async () => true),
    record: vi.fn(async (fn: typeof push) => { push = fn; return true; }),
    end: vi.fn(async () => {}),
    push: () => push(stereo),
  };
}

const select = (deviceId: string) => useAudioStore.setState({ selectedParticipantSource: { deviceId, label: deviceId } });
const live = () => new AbortController().signal;
const quiet = Int16Array.of(10);
const app = 'app:42';
const whole = 'desktop-audio-loopback';

function setup(platform: 'electron' | 'extension' | 'web' = 'electron', os = 'win32') {
  const invoke = vi.fn(async (channel, id) => channel === 'check-screen-recording-permission'
    ? { status: 'granted' } : { success: true, capture: id === app ? 'app' : 'system' });
  vi.stubGlobal('electron', { osInfo: { platform: os }, invoke });
  const loop = recorder();
  const application = recorder();
  vi.mocked(LoopbackRecorder).mockImplementation(function () { return loop as unknown as LoopbackRecorder; });
  vi.mocked(AppAudioRecorder).mockImplementation(function () { return application as unknown as AppAudioRecorder; });
  const mic = createSourceCore({ muted: () => false, release: async () => {} });
  vi.mocked(openMic).mockResolvedValue(mic);
  const onPcm = vi.fn();
  const onPlayout = vi.fn();
  const playback = { ttsTap: { read: () => new Float32Array() } } as unknown as Playback;
  const capture = createAppCapture(playback, platform, { onPcm, onPlayout });
  const voiced = () => vi.mocked(openMic).mock.lastCall![0].voiced!(quiet);
  return { capture, loop, application, mic, onPcm, onPlayout, voiced, invoke };
}

describe('the microphone gate playout reference', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    select(app);
    useAudioStore.setState({ echoCancellationMode: 'gate', isParticipantMuted: false });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('uses only system playout for the gate while translating an application, even with the participant muted', async () => {
    const { capture, loop, application, onPcm, onPlayout, voiced, invoke } = setup();
    const participant = await capture.openSource('participant', live());
    expect(loop.begin).not.toHaveBeenCalled();
    const speaker = await capture.openSource('speaker', live());
    await vi.waitFor(() => expect(loop.record).toHaveBeenCalledOnce());
    const heard = vi.fn();
    participant.onPcm(heard);
    application.push();
    expect(heard).toHaveBeenCalledOnce();
    expect(voiced()).toBe(true);
    useAudioStore.setState({ isParticipantMuted: true });
    capture.levels.participant.reset();
    loop.push();
    expect(voiced()).toBe(false);
    expect(heard).toHaveBeenCalledOnce();
    expect(onPcm).toHaveBeenCalledOnce();
    // The recording takes the reference's two channels, not the application's chunk.
    expect(onPlayout.mock.calls).toEqual([[stereo]]);
    expect(capture.levels.participant.heard()).toBe(false);
    expect(capture.levels.speaker.heard()).toBe(false);
    await speaker.stop();
    expect(invoke.mock.calls).toEqual([['connect-system-audio-source', app]]);
    await participant.stop();
  });

  it('shares a whole-system participant even on parallel open and follows live source switches', async () => {
    select(whole);
    const { capture, loop, onPcm, onPlayout, voiced } = setup();
    const [speaker, participant] = await Promise.all([
      capture.openSource('speaker', live()), capture.openSource('participant', live()),
    ]);
    expect(loop.begin).toHaveBeenCalledTimes(1);
    useAudioStore.setState({ isParticipantMuted: true });
    loop.push();
    expect(voiced()).toBe(false);
    expect(onPcm).not.toHaveBeenCalled();
    expect(onPlayout).toHaveBeenCalledWith(stereo);
    select('app-waiting:Zoom');
    await vi.waitFor(() => expect(loop.record).toHaveBeenCalledTimes(2));
    expect(loop.end).toHaveBeenCalledTimes(1);
    select(app);
    await vi.waitFor(() => expect(AppAudioRecorder).toHaveBeenCalledOnce());
    expect(loop.begin).toHaveBeenCalledTimes(2);
    select(whole);
    await vi.waitFor(() => expect(loop.record).toHaveBeenCalledTimes(3));
    expect(loop.end).toHaveBeenCalledTimes(2);
    await speaker.stop();
    expect(loop.end).toHaveBeenCalledTimes(2);
    await participant.stop();
  });

  it('captures with the microphone alone, stops on leaving gate, and releases again when the mic ends', async () => {
    select(whole);
    const { capture, loop, mic, voiced } = setup();
    const speaker = await capture.openSource('speaker', live());
    await vi.waitFor(() => expect(loop.record).toHaveBeenCalledOnce());
    loop.push();
    expect(voiced()).toBe(false);
    useAudioStore.setState({ echoCancellationMode: 'off' });
    await vi.waitFor(() => expect(loop.end).toHaveBeenCalledOnce());
    useAudioStore.setState({ echoCancellationMode: 'gate' });
    await vi.waitFor(() => expect(loop.record).toHaveBeenCalledTimes(2));
    mic.end('unplugged');
    await vi.waitFor(() => expect(loop.end).toHaveBeenCalledTimes(2));
    await speaker.stop();
    expect(loop.end).toHaveBeenCalledTimes(2);
  });

  it('releases a late permission grant after the microphone stops', async () => {
    const { capture, loop } = setup();
    let grant!: (ok: boolean) => void;
    loop.begin.mockImplementation(() => new Promise((resolve) => { grant = resolve; }));
    const speaker = await capture.openSource('speaker', live());
    await vi.waitFor(() => expect(loop.begin).toHaveBeenCalledOnce());
    const stopped = speaker.stop();
    grant(true);
    await stopped;
    expect(loop.end).toHaveBeenCalledOnce();
    expect(loop.record).not.toHaveBeenCalled();
  });

  it('waits for an in-flight reference to release the display handler before opening a whole-system participant', async () => {
    select(whole);
    const { capture, loop, invoke } = setup();
    let grant!: (ok: boolean) => void;
    loop.begin.mockImplementationOnce(() => new Promise((resolve) => { grant = resolve; }));
    const speaker = await capture.openSource('speaker', live());
    await vi.waitFor(() => expect(loop.begin).toHaveBeenCalledOnce());
    const opening = capture.openSource('participant', live());
    expect(invoke).not.toHaveBeenCalled();
    grant(true);
    const participant = await opening;
    expect(loop.end).toHaveBeenCalledOnce();
    expect(loop.end.mock.invocationCallOrder[0]).toBeLessThan(loop.begin.mock.invocationCallOrder[1]);
    expect(loop.record).toHaveBeenCalledOnce();
    await speaker.stop();
    await participant.stop();
  });

  it('warns once on denial and keeps following the participant without retrying on unrelated changes', async () => {
    const { capture, loop, application, voiced } = setup();
    const warning = vi.spyOn(diagnostics, 'reportWarning');
    loop.begin.mockResolvedValue(false);
    const speaker = await capture.openSource('speaker', live());
    const participant = await capture.openSource('participant', live());
    await vi.waitFor(() => expect(warning).toHaveBeenCalledOnce());
    expect(warning).toHaveBeenCalledWith('EchoFollow', expect.any(String), expect.objectContaining({ dedupeKey: expect.any(String) }));
    useAudioStore.setState({ isParticipantMuted: true });
    useAudioStore.setState({ isParticipantMuted: false });
    application.push();
    expect(voiced()).toBe(false);
    expect(loop.begin).toHaveBeenCalledOnce();
    await speaker.stop();
    await participant.stop();
  });

  it.each([
    ['web', 'win32'], ['extension', 'win32'], ['electron', 'darwin'], ['electron', 'linux'],
  ] as const)('opens no separate loopback on %s (%s)', async (platform, os) => {
    const { capture, loop } = setup(platform, os);
    const speaker = await capture.openSource('speaker', live());
    await speaker.stop();
    expect(loop.begin).not.toHaveBeenCalled();
  });
});
