// Fork: on this computer a stage is run by the app's own models, or by the LocalAI installed here.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionContext } from '../../lib/contract/adapter';
import { createVirtualClock } from '../../lib/contract/clock';
import { recordEvents } from '../../lib/contract/events';
import { fakeSockets } from '../../lib/contract/testing/fakeSocket';
import { trackedClock } from '../../lib/contract/testing/trackedClock';
import type { CheckContext } from '../../lib/provider/types';
import { useModelStore } from '../../stores/modelStore';
import {
  buildLocalAI, createLocalAICheck, hereBaseUrl, localaiProvider, LOCALAI_DEFAULTS, migrateLocalAISettings, settled,
  type LocalAIConfig, type LocalAICredentials, type LocalAISettings,
} from './localai';
import { cutsSentencesHere, deviceChoices, deviceNeeds, hearsByLocalServer } from './localaiDevice';
import type { LocalAIModel } from './localaiModels';
import { createPipelineAdapter } from './pipeline';
import { SHARED } from './testing';

const SPEAKER: SessionContext = { direction: { source: 'zh-CN', target: 'ja' }, speech: false, turns: 'auto' };
const PAIR = { source: 'zh-CN', target: 'ja' };
const shared = { ...SHARED, reversed: (d: SessionContext['direction']) => d.source === 'ja', models: [] as LocalAIModel[] };
const settings = (patch: Partial<LocalAISettings> = {}): LocalAISettings => ({ ...LOCALAI_DEFAULTS, ...patch });
const NONE: LocalAICredentials = { apiKey: '', endpoint: '' };
const HERE_BASE = 'http://127.0.0.1:8080/v1';
const INPUTS = { legacy: {}, credentials: {} };

// Everything on this computer, and all of it by its LocalAI.
const ALL_LOCALAI: Partial<LocalAISettings> = {
  asrVia: 'device', asrHere: 'localai', asrHereModel: 'whisper-large-turbo',
  translateAt: 'device', translateHere: 'localai', translateHereModel: 'hy-mt2-1.8b',
};

/** As the provider builds it: the settings read settled. */
function configFor(patch: Partial<LocalAISettings>, models: LocalAIModel[] = []): LocalAIConfig {
  const config = localaiProvider.build(SPEAKER, settings(patch), { ...shared, models });
  if ('refused' in config) throw new Error(config.refused);
  return config;
}

// Nothing of the app's own is downloaded: whatever is needed here is the LocalAI's.
beforeEach(() => useModelStore.setState({ initialized: true, webgpuAvailable: true, deviceFeatures: [], modelStatuses: {} }));

describe('who runs a stage on this computer', () => {
  it('is the app\'s own models unless said otherwise, and kept as stored', () => {
    expect(LOCALAI_DEFAULTS).toMatchObject({ asrHere: 'app', translateHere: 'app', coachHere: 'app', hereAddress: '127.0.0.1:8080' });
    const kept = migrateLocalAISettings({ asrHere: 'localai', asrHereModel: 'whisper-large-turbo', translateHere: 'nonsense', hereAddress: '127.0.0.1:8085' }, INPUTS);
    expect(kept).toMatchObject({ asrHere: 'localai', asrHereModel: 'whisper-large-turbo', translateHere: 'app', coachHere: 'app', hereAddress: '127.0.0.1:8085' });
  });

  it('asks nothing of the app\'s own models for a stage the LocalAI runs', () => {
    expect(deviceNeeds(deviceChoices(settings(ALL_LOCALAI)), PAIR, ['speaker', 'participant'])).toEqual([]);
    // The recognizer alone is the LocalAI's: the translation is still one of the app's.
    const mixed = deviceNeeds(deviceChoices(settings({ ...ALL_LOCALAI, translateHere: 'app' })), PAIR, ['speaker']);
    expect(mixed.map((need) => need.stage)).toEqual(['translation']);
  });

  it('tells who cuts the sentences: the LocalAI\'s own session does, as the other device\'s does', () => {
    expect(hearsByLocalServer(settings(ALL_LOCALAI))).toBe(true);
    expect(cutsSentencesHere(settings(ALL_LOCALAI))).toBe(false);
    expect(cutsSentencesHere(settings({ asrVia: 'device' }))).toBe(true);
    expect(cutsSentencesHere(settings({ asrVia: 'api' }))).toBe(true);
    // Left on LocalAI from before, and the stage moved away: it counts for nothing.
    expect(hearsByLocalServer(settings({ asrVia: 'server', asrHere: 'localai' }))).toBe(false);
  });

  it('reads a text stage the LocalAI runs as the text model at an address it is, with no key', () => {
    const s = settled(settings({ ...ALL_LOCALAI, coach: true, coachAt: 'device', coachHere: 'localai', coachHereModel: 'qwen3-4b', hereAddress: '127.0.0.1:8085' }));
    expect(s).toMatchObject({
      translateAt: 'api', translateBaseUrl: 'http://127.0.0.1:8085/v1', translateModel: 'hy-mt2-1.8b', translateNeedsKey: false,
      coachAt: 'api', coachBaseUrl: 'http://127.0.0.1:8085/v1', coachModel: 'qwen3-4b', coachNeedsKey: false,
      // What hears is no API: it stays this computer's, for the builder to open its session.
      asrVia: 'device', asrHere: 'localai',
    });
    // Nothing of it while the app's own models run the stage, or while the stage is elsewhere.
    const own = settings({ translateAt: 'device' });
    expect(settled(own)).toBe(own);
    const away = settings({ translateAt: 'server', translateHere: 'localai' });
    expect(settled(away)).toBe(away);
    expect(hereBaseUrl(settings({ hereAddress: ' ' }))).toBe(HERE_BASE);
  });

  it('asks for no key and no address: there is nothing to type', () => {
    expect(localaiProvider.credentials.fields(settings({ ...ALL_LOCALAI, coach: true, coachAt: 'device', coachHere: 'localai', coachHereModel: 'qwen3-4b' }))).toEqual([]);
  });
});

describe('a leg this computer\'s LocalAI hears', () => {
  it('is a Realtime session on its own socket, told its recognizer through the pipeline first, and answered by its text model over chat', () => {
    const config = configFor(ALL_LOCALAI);
    expect(config.socket).toEqual({ endpoint: 'ws://127.0.0.1:8080/v1/realtime' });
    expect(config.prepare).toEqual({ pipeline: 'gpt-realtime', transcription: 'whisper-large-turbo' });
    expect(config.model).toBe('gpt-realtime');
    // A session that only transcribes, naming no recognizer: a LocalAI takes none but its pipeline's there.
    expect(config.transcribeOnly).toBe(true);
    expect(config.transcription).toEqual({ language: 'zh' });
    expect(config.device).toBeUndefined();
    expect(config.stages?.speech).toMatchObject({ kind: 'translate', baseUrl: HERE_BASE, model: 'hy-mt2-1.8b' });
    expect(config.stages?.speech).not.toHaveProperty('key');
  });

  it('names the pipeline it was chosen with, and leaves the recognizer to it when none is picked', () => {
    const config = configFor({ ...ALL_LOCALAI, asrHereModel: '', herePipeline: 'realtime-ja', hereAddress: '127.0.0.1:8085' });
    expect(config.model).toBe('realtime-ja');
    expect(config.socket).toEqual({ endpoint: 'ws://127.0.0.1:8085/v1/realtime' });
    expect(config.prepare).toBeUndefined();
  });

  it('can be translated anywhere else: by the app\'s own model, or by the other device, asked at its own address', () => {
    useModelStore.setState({ modelStatuses: {} });
    const own = configFor({ ...ALL_LOCALAI, translateHere: 'app' });
    expect(own.socket).toBeDefined();
    expect(own.stages?.speech).toMatchObject({ via: 'device', kind: 'translate' });

    const remote = configFor({ ...ALL_LOCALAI, translateAt: 'server', translateServerModel: 'qwen3-4b' });
    expect(remote.socket).toEqual({ endpoint: 'ws://127.0.0.1:8080/v1/realtime' });
    // Blank: the credentials' own endpoint, which stays the other device's.
    expect(remote.stages?.speech).toMatchObject({ baseUrl: '', model: 'qwen3-4b' });
    // No model named there, and none it lists: it is asked for, as for any leg the other device does not hear.
    expect(localaiProvider.build(SPEAKER, settings({ ...ALL_LOCALAI, translateAt: 'server' }), shared)).toMatchObject({ code: 'translate_unnamed' });
  });

  it('is refused, by the stage, while the LocalAI\'s text model is not chosen', () => {
    expect(localaiProvider.build(SPEAKER, settings({ ...ALL_LOCALAI, translateHereModel: '' }), shared)).toMatchObject({ code: 'translate_unnamed' });
    // Unsettled, the builder would run one of the app's own: it is the definition that reads the settings settled.
    const unsettled = buildLocalAI(SPEAKER, settings(ALL_LOCALAI), shared) as LocalAIConfig;
    expect(unsettled.stages?.speech).toMatchObject({ via: 'device' });
  });

  it('opens that socket with no key, after the pipeline was told — and asks the text model with the credentials it has', async () => {
    const config = configFor(ALL_LOCALAI);
    const sockets = fakeSockets();
    const { clock } = trackedClock();
    const { events } = recordEvents();
    const order: string[] = [];
    const prepare = vi.fn(async () => { order.push(`prepare, ${sockets.all.length} socket(s) open`); });
    const starting = createPipelineAdapter({ openSocket: sockets.create, fetch: vi.fn(), prepare }).start(
      // The other device's address and key are the credentials': the LocalAI of this computer is neither.
      { context: SPEAKER, config, credentials: { apiKey: 'their-key', endpoint: 'ws://192.168.1.10:8790/v1/realtime' }, clock, signal: new AbortController().signal },
      events,
    );
    await vi.waitFor(() => expect(sockets.all).toHaveLength(1));
    expect(prepare).toHaveBeenCalledWith('gpt-realtime', 'whisper-large-turbo');
    expect(order).toEqual(['prepare, 0 socket(s) open']);
    const socket = sockets.last();
    expect(socket.url).toContain('ws://127.0.0.1:8080/v1/realtime');
    expect(JSON.stringify(socket.protocols ?? '')).not.toContain('their-key');
    socket.open('');
    socket.receive(JSON.stringify({ type: 'session.created', session: { id: 's', type: 'realtime', model: 'gpt-realtime' } }));
    socket.receive(JSON.stringify({ type: 'session.updated', session: { id: 's', type: 'transcription' } }));
    const session = await starting;
    await session.stop();
  });

  it('still starts when the pipeline could not be told: it hears with the recognizer the pipeline has', async () => {
    const sockets = fakeSockets();
    const { clock } = trackedClock();
    const prepare = vi.fn(async () => { throw new Error('LocalAI could not be reached.'); });
    const starting = createPipelineAdapter({ openSocket: sockets.create, fetch: vi.fn(), prepare }).start(
      { context: SPEAKER, config: configFor(ALL_LOCALAI), credentials: NONE, clock, signal: new AbortController().signal },
      recordEvents().events,
    );
    await vi.waitFor(() => expect(sockets.all).toHaveLength(1));
    starting.catch(() => {});
    sockets.last().close(1000, '');
  });
});

describe('readiness with a stage the LocalAI runs', () => {
  const ctx: CheckContext = { pair: PAIR, legs: ['speaker'] };
  const list = (ids: string[]) => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { headers: { 'Content-Type': 'application/json' } });
  const check = (s: LocalAISettings, fetch: ReturnType<typeof vi.fn>) => createLocalAICheck({ fetch: fetch as unknown as typeof globalThis.fetch, clock: createVirtualClock(0) })(NONE, settled(s), ctx);

  it('asks this computer\'s LocalAI, and none of the app\'s own models', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => list(['gpt-realtime', 'whisper-large-turbo', 'hy-mt2-1.8b']));
    const result = await check(settings(ALL_LOCALAI), fetch);
    expect(result).toMatchObject({ ok: true });
    expect(fetch.mock.calls.map((call) => String(call[0]))).toContain(`${HERE_BASE}/models`);
    // Not one request carries a key: a LocalAI asks for none.
    for (const call of fetch.mock.calls) expect(JSON.stringify(call[1]?.headers ?? {})).not.toContain('Bearer');
  });

  it('is not ready while that LocalAI does not answer', async () => {
    const fetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    const outcome = await check(settings(ALL_LOCALAI), fetch).then((result) => result, (error: unknown) => ({ ok: false, thrown: String(error) }));
    expect(outcome.ok).toBe(false);
  });

  it('declares what it reads, so a change of who runs a stage is checked again', () => {
    for (const field of ['asrHere', 'translateHere', 'translateHereModel', 'coachHere', 'coachHereModel', 'hereAddress']) expect(localaiProvider.checkReads).toContain(field);
  });
});
