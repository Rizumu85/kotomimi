import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionContext } from '../../lib/contract/adapter';
import { createVirtualClock } from '../../lib/contract/clock';
import { recordEvents, type AdapterEvent } from '../../lib/contract/events';
import { fakeSockets } from '../../lib/contract/testing/fakeSocket';
import { trackedClock } from '../../lib/contract/testing/trackedClock';
import type { CheckContext } from '../../lib/provider/types';
import { useModelStore } from '../../stores/modelStore';
import { createFakeEngines } from '../localInference/fakeEngines';
import {
  admitLocalAI, buildLocalAI, createLocalAICheck, describeLocalAI, LOCALAI_DEFAULTS, localaiCredentials, localaiProvider, migrateLocalAISettings,
  type LocalAIConfig, type LocalAICredentials, type LocalAISettings,
} from './localai';
import { deviceChatModels, deviceChoices, deviceCoachModel, deviceNeeds, deviceRecognizer, deviceTranslator, needsServer } from './localaiDevice';
import type { LocalAIModel } from './localaiModels';
import { createPipelineAdapter, FIRST_REF, type DeviceStage } from './pipeline';
import { SHARED } from './testing';

// "I read Chinese, the other side speaks Japanese": the speaker leg is zh → ja, the participant leg its reverse.
const SPEAKER: SessionContext = { direction: { source: 'zh-CN', target: 'ja' }, speech: false, turns: 'auto' };
const PARTICIPANT: SessionContext = { direction: { source: 'ja', target: 'zh-CN' }, speech: false, turns: 'auto' };
const PAIR = { source: 'zh-CN', target: 'ja' };
const shared = { ...SHARED, reversed: (d: SessionContext['direction']) => d.source === 'ja', models: [] as LocalAIModel[] };
// Every stage of a translation on this computer.
const HERE: Partial<LocalAISettings> = { asrVia: 'device', translateAt: 'device' };
const NONE: LocalAICredentials = { apiKey: '', endpoint: '' };
const SERVER: LocalAICredentials = { apiKey: '', endpoint: 'ws://192.168.1.10:8080/v1/realtime' };
const settings = (patch: Partial<LocalAISettings> = {}): LocalAISettings => ({ ...LOCALAI_DEFAULTS, ...patch });

/** What this computer has downloaded: SenseVoice hears Chinese and Japanese; Bing, a cloud model, is always there to translate. */
function downloaded(...ids: string[]) {
  useModelStore.setState({ initialized: true, webgpuAvailable: true, deviceFeatures: [], modelStatuses: Object.fromEntries(ids.map((id) => [id, 'downloaded' as const])) });
}

beforeEach(() => downloaded('sensevoice-int8'));

function configFor(context: SessionContext, patch: Partial<LocalAISettings>, models: typeof shared.models = []): LocalAIConfig {
  const config = buildLocalAI(context, settings(patch), { ...shared, models });
  if ('refused' in config) throw new Error(config.refused);
  return config;
}

describe('where each stage runs', () => {
  it('places each stage by itself: what hears decides nothing about what translates', () => {
    expect(deviceChoices(settings({ asrVia: 'device' })).translateAt).toBe('server');
    expect(deviceChoices(settings({ asrVia: 'device', translateAt: 'api' })).translateAt).toBe('api');
    expect(deviceChoices(settings({ translateAt: 'device' })).asrVia).toBe('server');
  });

  it('needs the other device only while a stage is on it', () => {
    expect(needsServer(settings())).toBe(true);
    expect(needsServer(settings(HERE))).toBe(false);
    // The translation on the other device brings it back, whatever hears; an API does not.
    expect(needsServer(settings({ ...HERE, translateAt: 'server' }))).toBe(true);
    expect(needsServer(settings({ ...HERE, translateAt: 'api' }))).toBe(false);
    // The feedback's place counts only while the speaker is coached.
    expect(needsServer(settings({ ...HERE, coachAt: 'server' }))).toBe(false);
    expect(needsServer(settings({ ...HERE, coach: true, coachAt: 'server' }))).toBe(true);
    expect(needsServer(settings({ ...HERE, coach: true, coachAt: 'api' }))).toBe(false);
  });

  it('lists the models a run loads here: a recognizer per leg heard, a translation per leg translated', () => {
    const needs = (patch: Partial<LocalAISettings>, legs: Array<'speaker' | 'participant'>) =>
      deviceNeeds(deviceChoices(settings(patch)), PAIR, legs).map((n) => `${n.leg}:${n.stage}:${n.dir}${n.required ? '' : '?'}`);
    expect(needs({}, ['speaker', 'participant'])).toEqual([]);
    expect(needs(HERE, ['speaker'])).toEqual(['speaker:asr:zh→ja', 'speaker:translation:zh→ja']);
    expect(needs(HERE, ['speaker', 'participant'])).toEqual(['speaker:asr:zh→ja', 'speaker:translation:zh→ja', 'participant:asr:ja→zh', 'participant:translation:ja→zh']);
    // The server hears, this computer translates.
    expect(needs({ translateAt: 'device' }, ['participant'])).toEqual(['participant:translation:ja→zh']);
    // This computer hears, another place translates: a recognizer and nothing else.
    expect(needs({ asrVia: 'device' }, ['speaker'])).toEqual(['speaker:asr:zh→ja']);
    // A coached speaker speaks Japanese: their recognizer is the Japanese one, and only what they type is translated.
    expect(needs({ ...HERE, coach: true }, ['speaker'])).toEqual(['speaker:asr:ja→zh', 'speaker:translation:zh→ja?']);
  });

  it('resolves a slot to the pick, else to the best model downloaded, and to nothing for a language no one hears', () => {
    expect(deviceRecognizer('zh-CN', 'ja', {})).toEqual({ modelId: 'sensevoice-int8', streaming: false });
    expect(deviceRecognizer('auto', 'ja', {})).toBeNull();
    downloaded();
    expect(deviceRecognizer('zh-CN', 'ja', {})).toBeNull();
    // A cloud translator needs no download.
    expect(deviceTranslator('zh-CN', 'ja', {})).toBe('bing-translator');
    expect(deviceTranslator('auto', 'ja', {})).toBeNull();
  });
});

describe('a leg this computer hears', () => {
  it('is built with its own recognizer and translation, no transcription session, and nothing of the server', () => {
    const c = configFor(SPEAKER, HERE);
    expect(c.device).toEqual({ modelId: 'sensevoice-int8', streaming: false, vad: { threshold: 0.3, minSilenceDuration: 1.4, minSpeechDuration: 0.4, maxSpeechDuration: 30 } });
    expect(c).not.toHaveProperty('transcribeOnly');
    expect(c.model).toBe('');
    const speech = c.stages?.speech as DeviceStage;
    expect(speech).toMatchObject({ via: 'device', kind: 'translate', model: 'bing-translator', wrapTranscript: true });
    expect(speech.system).toContain('Chinese');
    expect(c.stages?.typed).toBe(c.stages?.speech);
    expect(describeLocalAI(c)).toEqual({ translationModel: 'bing-translator', asrModel: 'sensevoice-int8' });
  });

  it('hands the stored turn-detection knobs to the recognizer', () => {
    const c = configFor(SPEAKER, { ...HERE, vadThreshold: 0.5, vadMinSilenceDuration: 0.8, vadNegativeThreshold: 0.2 });
    expect(c.device?.vad).toEqual({ threshold: 0.5, minSilenceDuration: 0.8, minSpeechDuration: 0.4, maxSpeechDuration: 30, negativeThreshold: 0.2 });
  });

  it('is refused, in Local Inference\'s own words, while no recognizer is downloaded for the language', () => {
    downloaded();
    expect(buildLocalAI(SPEAKER, settings(HERE), shared)).toMatchObject({ code: 'no_asr', params: { source: 'zh-CN' } });
    expect(buildLocalAI({ ...SPEAKER, direction: { source: 'auto', target: 'ja' } }, settings(HERE), shared)).toMatchObject({ code: 'no_asr' });
  });

  it('can be answered by a text model instead: an API\'s, or the other device\'s', () => {
    const c = configFor(SPEAKER, { asrVia: 'device', translateAt: 'api', translateModel: 'hy-mt2-1.8b', translateBaseUrl: 'http://192.168.1.10:8080/v1', translateNeedsKey: false });
    expect(c.device?.modelId).toBe('sensevoice-int8');
    expect(c.stages?.speech).toMatchObject({ kind: 'translate', baseUrl: 'http://192.168.1.10:8080/v1', model: 'hy-mt2-1.8b' });
    expect(c.stages?.speech).not.toHaveProperty('via');
    expect(c.stages?.speech).not.toHaveProperty('key');
    // On the other device: the model named, asked over chat at the device's own address.
    const there = configFor(SPEAKER, { asrVia: 'device', translateAt: 'server', translateServerModel: 'hy-mt2-1.8b', serverNeedsKey: true });
    expect(there.device?.modelId).toBe('sensevoice-int8');
    expect(there.stages?.speech).toMatchObject({ kind: 'translate', baseUrl: '', model: 'hy-mt2-1.8b', key: 'apiKey' });
    // None named: the first model the device lists that translates — when it says what its models are for.
    const listed = [{ id: 'gpt-realtime', kind: 'pipeline' as const }, { id: 'whisper-large-turbo', kind: 'asr' as const }, { id: 'hy-mt2-1.8b', kind: 'text' as const }];
    expect(configFor(SPEAKER, { asrVia: 'device', translateAt: 'server' }, listed).stages?.speech).toMatchObject({ baseUrl: '', model: 'hy-mt2-1.8b' });
    // A device that does not say: nothing is run on a guess.
    expect(buildLocalAI(SPEAKER, settings({ asrVia: 'device', translateAt: 'server' }), { ...shared, models: [{ id: 'some-model' }] })).toMatchObject({ code: 'models_required' });
    expect(buildLocalAI(SPEAKER, settings({ asrVia: 'device', translateAt: 'api' }), shared)).toMatchObject({ code: 'models_required' });
  });

  it('hears a coached speaker in the language they practise, and translates only what they type', () => {
    const c = configFor(SPEAKER, { ...HERE, coach: true, coachAt: 'api', coachModel: 'qwen3-4b', coachBaseUrl: 'http://192.168.1.10:8080/v1', coachNeedsKey: false });
    expect(c.device?.modelId).toBe('sensevoice-int8');
    expect(c.stages).toMatchObject({ heard: 'ja', speech: { kind: 'coach', model: 'qwen3-4b' }, typed: { via: 'device', model: 'bing-translator' } });
    // The feedback has a place of its own, and borrows no model from the translation's.
    expect(buildLocalAI(SPEAKER, settings({ ...HERE, coach: true, coachAt: 'api', translateModel: 'left-over' }), shared)).toMatchObject({ code: 'models_required' });
  });

  it('offers no "auto-detect" source: no recognizer here detects a language', () => {
    expect(localaiProvider.languages.sources(settings(HERE)).map((o) => o.value)).not.toContain('auto');
    expect(localaiProvider.languages.sources(settings()).map((o) => o.value)).toContain('auto');
  });

  it('takes typed text whenever something translates it', () => {
    expect(localaiProvider.textInput(settings(HERE))).toBe(true);
    expect(localaiProvider.textInput(settings({ ...HERE, coach: true }))).toBe(true);
    // An API with no model named answers nothing a coached speaker types.
    expect(localaiProvider.textInput(settings({ coach: true, translateAt: 'api' }))).toBe(false);
    expect(localaiProvider.textInput(settings({ coach: true, translateAt: 'api', translateBaseUrl: 'https://api.example.com/v1', translateModel: 'm' }))).toBe(true);
  });

  it('keeps stored picks and knobs, and defaults what is missing or of the wrong type', () => {
    const inputs = { legacy: {}, credentials: {} };
    const picks = { 'zh→ja': { asr: { modelId: 'sensevoice-int8' }, translation: { modelId: '' }, tts: { modelId: '' } } };
    expect(migrateLocalAISettings({ ...LOCALAI_DEFAULTS, asrVia: 'device', coachDeviceModel: 'qwen3-0.6b-translation', selections: picks, vadThreshold: 0.6, serverNeedsKey: true }, { legacy: { translateAt: 'device', coachAt: 'device' }, credentials: {} }))
      .toMatchObject({ asrVia: 'device', translateAt: 'device', coachAt: 'device', coachDeviceModel: 'qwen3-0.6b-translation', selections: picks, vadThreshold: 0.6, serverNeedsKey: true });
    expect(migrateLocalAISettings({ ...LOCALAI_DEFAULTS, asrVia: 'cloud', selections: ['x'], vadThreshold: 'high', serverNeedsKey: 1 }, inputs))
      .toMatchObject({ asrVia: 'server', selections: {}, vadThreshold: 0.3, serverNeedsKey: false });
  });
});

describe('a leg the server hears and this computer translates', () => {
  it('opens a transcription session and answers with the device stage', () => {
    const c = configFor(PARTICIPANT, { translateAt: 'device' }, [{ id: 'gpt-realtime' }]);
    expect(c).toMatchObject({ model: 'gpt-realtime', transcribeOnly: true });
    expect(c).not.toHaveProperty('device');
    expect(c.stages?.speech).toMatchObject({ via: 'device', model: 'bing-translator' });
  });
});

describe('the memory this computer\'s models take', () => {
  it('counts nothing for a run with every stage elsewhere, and the device models otherwise', () => {
    expect(admitLocalAI({ speaker: configFor(SPEAKER, {}, [{ id: 'gpt-realtime' }]) })).toBe(true);
    expect(admitLocalAI({ speaker: configFor(SPEAKER, HERE), participant: configFor(PARTICIPANT, HERE) })).toBe(true);
    localStorage.setItem('debug:device-memory', '0.1');
    try {
      expect(admitLocalAI({ speaker: configFor(SPEAKER, HERE) })).toMatchObject({ code: 'memory_exceeded' });
      // A server-heard run is never refused for this computer's memory.
      expect(admitLocalAI({ speaker: configFor(SPEAKER, {}, [{ id: 'gpt-realtime' }]) })).toBe(true);
    } finally {
      localStorage.removeItem('debug:device-memory');
    }
  });
});

describe('grammar feedback on this computer', () => {
  const COACHED: Partial<LocalAISettings> = { ...HERE, coach: true, coachAt: 'device' };

  it('is written by one of the catalog\'s chat models: the pick, else the largest downloaded', () => {
    expect(deviceChatModels().map((m) => m.id)).toEqual(['qwen2.5-0.5b-translation', 'qwen3-0.6b-translation', 'qwen3.5-0.8b-translation', 'qwen3.5-2b-translation']);
    downloaded('sensevoice-int8', 'qwen3-0.6b-translation', 'qwen3.5-2b-translation', 'opus-mt-ja-en');
    expect(deviceCoachModel('')).toBe('qwen3.5-2b-translation');
    expect(deviceCoachModel('qwen3-0.6b-translation')).toBe('qwen3-0.6b-translation');
    // A pick that cannot run falls back; a translation model that is no chat model is never one.
    expect(deviceCoachModel('qwen2.5-0.5b-translation')).toBe('qwen3.5-2b-translation');
    expect(deviceCoachModel('opus-mt-ja-en')).toBe('qwen3.5-2b-translation');
    const c = configFor(SPEAKER, COACHED);
    expect(c.stages).toMatchObject({
      heard: 'ja',
      // The feedback's own instructions, the sentence as it was said, and answers in the speaker's own language.
      speech: { via: 'device', kind: 'coach', model: 'qwen3.5-2b-translation', wrapTranscript: false, language: 'zh-CN' },
      typed: { via: 'device', kind: 'translate', model: 'bing-translator' },
    });
    expect((c.stages?.speech as DeviceStage).system).toContain('日语');
    // The participant's leg is never coached: it translates.
    expect(configFor(PARTICIPANT, COACHED).stages?.speech).toMatchObject({ via: 'device', kind: 'translate' });
  });

  it('is refused, in the words for a missing model, while none is downloaded', () => {
    expect(deviceCoachModel('')).toBeNull();
    expect(buildLocalAI(SPEAKER, settings(COACHED), shared)).toMatchObject({ code: 'local_models_missing' });
  });

  it('counts both of the leg\'s models when the feedback\'s is not the translation\'s', () => {
    downloaded('sensevoice-int8', 'qwen3.5-2b-translation');
    expect(admitLocalAI({ speaker: configFor(SPEAKER, COACHED) })).toBe(true);
    // A chat model runs on the graphics card: counted against its memory, when a budget for it is set.
    localStorage.setItem('debug:vram-budget', '1');
    try {
      // Beside the online translator, which takes none.
      expect(admitLocalAI({ speaker: configFor(SPEAKER, COACHED) })).toMatchObject({ code: 'memory_exceeded' });
      // The other device hears and translates; this computer only gives the feedback: its model alone is still counted.
      expect(admitLocalAI({ speaker: configFor(SPEAKER, { coach: true, coachAt: 'device', translateServerModel: 'hy-mt2-1.8b' }, [{ id: 'gpt-realtime' }]) })).toMatchObject({ code: 'memory_exceeded' });
      // With the feedback elsewhere nothing of the graphics card's is.
      expect(admitLocalAI({ speaker: configFor(SPEAKER, HERE) })).toBe(true);
    } finally {
      localStorage.removeItem('debug:vram-budget');
    }
  });
});

describe('readiness with stages on this computer', () => {
  const ctx = (legs: CheckContext['legs'] = ['speaker']): CheckContext => ({ pair: PAIR, legs });
  const check = (s: LocalAISettings, k: LocalAICredentials = NONE, legs?: CheckContext['legs'], fetch: ReturnType<typeof vi.fn> = vi.fn(async () => { throw new Error('no server should be asked'); })) =>
    createLocalAICheck({ fetch: fetch as unknown as typeof globalThis.fetch, clock: createVirtualClock(0) })(k, s, ctx(legs)).then((result) => ({ result, fetch }));

  it('asks no server while every stage is here, and is ready once the models are downloaded', async () => {
    const { result, fetch } = await check(settings(HERE), NONE, ['speaker', 'participant']);
    expect(result).toEqual({ ok: true, models: [] });
    expect(fetch).not.toHaveBeenCalled();
    expect(localaiCredentials.read({}, { signedIn: false, getToken: async () => null })).toEqual(NONE);
  });

  it('is not ready, in Local Inference\'s words, while a leg\'s recognizer is missing', async () => {
    downloaded();
    expect((await check(settings(HERE))).result).toMatchObject({ ok: false, code: 'no_asr', params: { source: 'zh-CN' } });
    // A coached speaker is heard in the other language.
    expect((await check(settings({ ...HERE, coach: true, coachAt: 'api', coachModel: 'c', coachBaseUrl: 'https://api.example.com/v1' }), NONE, ['speaker'], vi.fn(async () => new Response('{}', { status: 404 })))).result)
      .toMatchObject({ ok: false, code: 'no_asr', params: { source: 'ja' } });
  });

  it('is not ready while the feedback\'s model here is missing, and only for a run that coaches', async () => {
    expect((await check(settings({ ...HERE, coach: true, coachAt: 'device' }))).result).toMatchObject({ ok: false, code: 'local_models_missing' });
    expect((await check(settings({ ...HERE, coach: true, coachAt: 'device' }), NONE, ['participant'])).result).toMatchObject({ ok: true });
    downloaded('sensevoice-int8', 'qwen3-0.6b-translation');
    expect((await check(settings({ ...HERE, coach: true, coachAt: 'device' }))).result).toMatchObject({ ok: true });
  });

  it('still asks the server when one stage stays on it', async () => {
    const list = vi.fn(async (input: RequestInfo | URL) => (String(input).endsWith('/capabilities') ? new Response('{}', { status: 404 }) : new Response(JSON.stringify({ data: [{ id: 'hy-mt2-1.8b' }] }), { headers: { 'Content-Type': 'application/json' } })));
    const { result } = await check(settings({ asrVia: 'device', translateAt: 'server', translateServerModel: 'hy-mt2-1.8b' }), SERVER, ['speaker'], list as never);
    expect(result).toEqual({ ok: true, models: [{ id: 'hy-mt2-1.8b' }] });
    expect(list.mock.calls[0][0]).toBe('http://192.168.1.10:8080/v1/models');
  });

  it('reads the pair and the legs, and watches the downloads', () => {
    expect(localaiProvider.checkReadsDirection).toBe(true);
    const changed = vi.fn();
    const off = localaiProvider.watchReadiness!(changed);
    downloaded('sensevoice-int8', 'sensevoice-nano-int8');
    expect(changed).toHaveBeenCalledTimes(1);
    off();
    downloaded();
    expect(changed).toHaveBeenCalledTimes(1);
  });
});

/** A leg with this computer's fake engines, started once they are told to be ready. */
async function live(context: SessionContext, patch: Partial<LocalAISettings>, o: { models?: typeof shared.models; ready?: boolean } = {}) {
  const config = configFor(context, patch, o.models ?? []);
  const fakes = createFakeEngines();
  const sockets = fakeSockets();
  const { clock } = trackedClock();
  const { events, log } = recordEvents();
  const abort = new AbortController();
  const fetch = vi.fn(async (): Promise<Response> => { throw new Error('no text model should be called'); });
  const starting = createPipelineAdapter({ openSocket: sockets.create, fetch: fetch as unknown as typeof globalThis.fetch, engines: fakes.engines })
    .start({ context, config, credentials: config.device ? NONE : SERVER, clock, signal: abort.signal }, events);
  starting.catch(() => {});
  const of = <T extends AdapterEvent['kind']>(kind: T) => log.filter((e): e is Extract<AdapterEvent, { kind: T }> => e.kind === kind);
  const lastText = (ref: number) => of('segmentText').filter((e) => e.payload.ref === ref).pop()?.payload;
  const h = { config, ...fakes, sockets, starting, abort, log, of, lastText, fetch };
  if (o.ready !== false) {
    if (config.device) fakes.asr.ready();
    fakes.translation.ready();
    if (!config.device) {
      const socket = sockets.last();
      socket.open('');
      socket.receive(JSON.stringify({ type: 'session.created', session: { id: 's', type: 'realtime' } }));
      socket.receive(JSON.stringify({ type: 'session.updated', session: { id: 's', type: 'transcription' } }));
    }
  }
  return h;
}

describe('a session this computer hears and translates', () => {
  it('opens no socket, loads the recognizer for the language heard and the translator for the direction, and counts both as it loads', async () => {
    const h = await live(SPEAKER, HERE);
    const session = await h.starting;
    expect(h.sockets.all).toHaveLength(0);
    expect(h.asr.inits).toEqual([{ modelId: 'sensevoice-int8', options: { vadConfig: h.config.device!.vad, language: 'zh', translateTo: undefined, punctuationEndpoint: true } }]);
    expect(h.translation.inits).toEqual([{ sourceLang: 'zh', targetLang: 'ja', modelId: 'bing-translator' }]);
    expect(h.of('loading').map((e) => e.payload).pop()).toMatchObject({ done: 2, total: 2 });
    expect(session.info).toEqual({ transport: 'local' });
    // The recognizer's own "transcription only" notice is not this session's: a stage answers.
    await Promise.resolve();
    expect(h.of('degraded')).toEqual([]);
  });

  it('turns an utterance into a source and its translation, by this computer\'s model', async () => {
    const h = await live(SPEAKER, HERE);
    await h.starting;
    h.asr.partial('今天天气');
    h.asr.final('今天天气很好');
    await vi.waitFor(() => expect(h.translation.calls).toHaveLength(1));
    expect(h.translation.calls[0]).toMatchObject({ text: '今天天气很好', wrapTranscript: true });
    h.translation.answer('今日は天気がいいです');
    await vi.waitFor(() => expect(h.of('busy').map((e) => e.payload).pop()).toBe(false));
    expect(h.of('segmentOpened').map((e) => e.payload)).toEqual([
      { ref: 1, side: 'source', origin: 'u1' },
      { ref: FIRST_REF + 1, side: 'translation', origin: 'u1' },
    ]);
    expect(h.lastText(1)?.text).toBe('今天天气很好');
    expect(h.lastText(FIRST_REF + 1)?.text).toBe('今日は天気がいいです');
    expect(h.of('segmentClosed').map((e) => e.payload.ref)).toEqual([1, FIRST_REF + 1]);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.of('frame').map((e) => e.payload.type)).toEqual(expect.arrayContaining(['text.request', 'text.done']));
  });

  it('translates typed text by the same model', async () => {
    const h = await live(SPEAKER, HERE);
    const session = await h.starting;
    session.appendText(' 报销 ');
    await vi.waitFor(() => expect(h.translation.calls).toHaveLength(1));
    h.translation.answer('経費精算');
    await vi.waitFor(() => expect(h.lastText(FIRST_REF + 2)?.text).toBe('経費精算'));
    expect(h.of('segmentOpened').map((e) => e.payload)).toEqual([
      { ref: FIRST_REF + 1, side: 'source', origin: 'sokuji_typed_1' },
      { ref: FIRST_REF + 2, side: 'translation', origin: 'sokuji_typed_1' },
    ]);
  });

  it('keeps going past a translation that fails, and says so', async () => {
    const h = await live(SPEAKER, HERE);
    await h.starting;
    h.asr.final('一');
    await vi.waitFor(() => expect(h.translation.calls).toHaveLength(1));
    h.translation.reject(new Error('[bing:network] offline'));
    await vi.waitFor(() => expect(h.of('degraded')).toHaveLength(1));
    expect(h.of('degraded')[0].payload).toMatchObject({ code: 'translation_failed' });
    h.asr.final('二');
    await vi.waitFor(() => expect(h.translation.calls).toHaveLength(2));
    expect(h.of('failed')).toEqual([]);
  });

  it('hears a coached speaker in the language they practise, and marks what they said as that language', async () => {
    const h = await live(SPEAKER, { ...HERE, coach: true, coachAt: 'api', coachModel: 'c', coachBaseUrl: 'https://api.example.com/v1', coachNeedsKey: false });
    await h.starting;
    expect(h.asr.inits[0].options.language).toBe('ja');
    h.fetch.mockImplementationOnce(async () => new Response(JSON.stringify({ choices: [{ message: { content: '✓' } }] }), { headers: { 'Content-Type': 'application/json' } }));
    h.asr.final('今日はいい天気です');
    await vi.waitFor(() => expect(h.lastText(FIRST_REF + 1)?.text).toBe('✓'));
    expect(h.lastText(1)).toMatchObject({ text: '今日はいい天気です', language: 'ja' });
  });

  it('disposes every engine at stop, and says nothing after', async () => {
    const h = await live(SPEAKER, HERE);
    const session = await h.starting;
    h.asr.final('一');
    await vi.waitFor(() => expect(h.translation.calls).toHaveLength(1));
    const before = h.log.length;
    await session.stop();
    expect(h.asr.disposes).toBe(1);
    expect(h.translation.disposes).toBe(1);
    h.translation.answer('いち');
    await Promise.resolve();
    expect(h.log.length).toBe(before);
  });

  it('fails the start when the translator cannot load, the recognizer let go', async () => {
    const h = await live(SPEAKER, HERE, { ready: false });
    h.asr.ready();
    h.translation.failInit('model files are missing');
    await expect(h.starting).rejects.toThrow(/Translation engine init failed: model files are missing/);
    expect(h.asr.disposes).toBeGreaterThanOrEqual(1);
    expect(h.translation.disposes).toBeGreaterThanOrEqual(1);
  });

  it('fails the start when the recognizer cannot load, the translator let go', async () => {
    const h = await live(SPEAKER, HERE, { ready: false });
    h.translation.ready();
    h.asr.failInit('no such model');
    await expect(h.starting).rejects.toThrow(/ASR engine init failed: no such model/);
    expect(h.translation.disposes).toBeGreaterThanOrEqual(1);
  });

  it('lets everything go when the start is cancelled while loading', async () => {
    const h = await live(SPEAKER, HERE, { ready: false });
    h.abort.abort(new Error('cancelled'));
    await expect(h.starting).rejects.toThrow(/cancelled/);
    expect(h.asr.disposes).toBeGreaterThanOrEqual(1);
    expect(h.translation.disposes).toBeGreaterThanOrEqual(1);
  });

  it('ends the session when the translator dies', async () => {
    const h = await live(SPEAKER, HERE);
    await h.starting;
    h.translation.fatal('worker crashed');
    expect(h.of('failed').map((e) => e.payload.message)).toEqual(['Translation stopped: worker crashed']);
    expect(h.asr.disposes).toBe(1);
  });
});

describe('a session the server hears and this computer translates', () => {
  it('opens a transcription session, and answers each source with the device model', async () => {
    const h = await live(PARTICIPANT, { translateAt: 'device' }, { models: [{ id: 'gpt-realtime' }] });
    await h.starting;
    const socket = h.sockets.last();
    expect((socket.sentJson<{ session: { type: string } }>()[0]).session.type).toBe('transcription');
    expect(h.translation.inits).toEqual([{ sourceLang: 'ja', targetLang: 'zh', modelId: 'bing-translator' }]);
    socket.receive(JSON.stringify({ type: 'input_audio_buffer.committed', item_id: 'i1' }));
    socket.receive(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'i1', content_index: 0, transcript: 'こんにちは' }));
    await vi.waitFor(() => expect(h.translation.calls).toHaveLength(1));
    h.translation.answer('你好');
    await vi.waitFor(() => expect(h.lastText(FIRST_REF + 1)?.text).toBe('你好'));
    expect(h.fetch).not.toHaveBeenCalled();
  });
});
