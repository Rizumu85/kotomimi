import { expect, it, vi } from 'vitest';
import { VOICE_DEFAULTS } from '../providers/openai/localaiVoice';
import useAudioStore from '../stores/audioStore';
import { useLineVoiceStore } from '../stores/lineVoiceStore';
import { useProviderStore } from '../stores/providerStore';
import { canSay, sayLine, voiceReady } from './lineVoice';

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

it('asks the other device for a line, at its address and with its access key, where the voice is there (fork)', async () => {
  const QWEN = 'qwen3-tts-1.7b-customvoice-q8';
  const choice = { ...VOICE_DEFAULTS, on: true, at: 'server' as const, serverModel: QWEN };
  const before = useProviderStore.getState();
  const entry = { settings: { serverNeedsKey: true, speak: choice }, credentials: { endpoint: '192.168.1.20:8790', serverKey: 'door-key', speakKey: 'not-this-one' } };
  useProviderStore.setState({
    entries: { ...before.entries, localai: { ...before.entries.localai, ...entry } as never },
    models: { ...before.models, localai: [{ id: 'kotomimi', kind: 'pipeline', host: 'kotomimi' }, { id: QWEN, kind: 'voice', host: 'kotomimi' }] as never },
  });
  const source = useAudioStore.getState().selectedParticipantSource;
  useAudioStore.setState({ selectedParticipantSource: { deviceId: 'app:123', label: 'Meeting', isVirtual: false } });
  const pcm = new Uint8Array(new Int16Array(9600).fill(700).buffer);
  const fetched = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(pcm, { headers: { 'Content-Type': 'audio/pcm;rate=24000' } }));
  vi.stubGlobal('fetch', fetched);
  line.mockClear();
  try {
    expect(voiceReady(choice)).toBe(true);
    expect(canSay('ja', choice)).toBe(true);
    await sayLine('row', 'こんにちは', 'ja', choice);
    expect(String(fetched.mock.calls[0][0])).toBe('http://192.168.1.20:8790/v1/audio/speech');
    expect((fetched.mock.calls[0][1]!.headers as Record<string, string>).Authorization).toBe('Bearer door-key');
    expect(JSON.parse(fetched.mock.calls[0][1]!.body as string)).toMatchObject({ model: QWEN, input: 'こんにちは', voice: 'ono_anna', response_format: 'pcm', language: 'ja' });
    expect(line).toHaveBeenCalledTimes(1);
    expect(useLineVoiceStore.getState()).toMatchObject({ line: null, phase: 'idle', failed: null });
    // No address: there is no device to ask, and nothing is.
    useProviderStore.setState({ entries: { ...useProviderStore.getState().entries, localai: { ...useProviderStore.getState().entries.localai, credentials: {} } as never } });
    expect(voiceReady(choice)).toBe(false);
    await sayLine('row', 'こんにちは', 'ja', choice);
    expect(fetched).toHaveBeenCalledTimes(1);
    expect(useLineVoiceStore.getState().failed).toBe('row');
  } finally {
    vi.unstubAllGlobals();
    useAudioStore.setState({ selectedParticipantSource: source });
    useProviderStore.setState({ entries: before.entries, models: before.models });
  }
});
