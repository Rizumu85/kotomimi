import { expect, it, vi } from 'vitest';
import { VOICE_DEFAULTS } from '../providers/openai/localaiVoice';
import useAudioStore from '../stores/audioStore';
import { useLineVoiceStore } from '../stores/lineVoiceStore';
import { sayLine } from './lineVoice';

const { line, stopReplay, native, release } = vi.hoisted(() => ({
  line: vi.fn(), stopReplay: vi.fn(), native: vi.fn(), release: vi.fn(),
}));
vi.mock('../lib/audio/appAudio', () => ({
  getAppAudio: async () => ({ playback: { line, stopReplay, queues: { replay: { clears: 0, pending: 0 } } } }),
}));
vi.mock('./session', () => ({
  getAppSession: () => ({ view: { get: () => ({ legs: [] }) }, runner: { state: { getState: () => ({ phase: 'running', legs: { participant: true } }) } } }),
}));
vi.mock('../utils/environment', async (original) => ({ ...await original<typeof import('../utils/environment')>(), getEnvironment: () => 'electron' }));
vi.mock('../lib/voice/liveVoice', () => ({ liveVoiceDeps: { native } }));
vi.mock('../providers/openai/localaiNative', async (original) => ({
  ...await original<typeof import('../providers/openai/localaiNative')>(), holdNative: () => release, voiceUp: async () => {},
}));

it('clears the replay and stops the line if whole-system capture begins between pieces', async () => {
  const before = useAudioStore.getState().selectedParticipantSource;
  useAudioStore.setState({ selectedParticipantSource: { deviceId: 'app:123', label: 'Meeting', isVirtual: false } });
  native.mockImplementation(async (_request, piece, signal) => {
    piece(new Int16Array(9600), 24000);
    expect(line).toHaveBeenCalledTimes(1);
    stopReplay.mockClear();
    useAudioStore.setState({ selectedParticipantSource: null });
    piece(new Int16Array(9600), 24000);
    expect(signal.aborted).toBe(true);
  });
  try {
    await sayLine('row', 'Hello', 'en', { ...VOICE_DEFAULTS, on: true });
    expect(line).toHaveBeenCalledTimes(1);
    expect(stopReplay).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(useLineVoiceStore.getState()).toMatchObject({ line: null, phase: 'idle', failed: null });
  } finally {
    useAudioStore.setState({ selectedParticipantSource: before });
  }
});
