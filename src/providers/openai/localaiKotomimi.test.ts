/**
 * Fork: this provider against another Kotomimi sharing its models
 * (`src/lib/lan`) — what the check learns from its lists, and what the
 * builder then asks of it. The lists here are the ones `protocol.ts` writes,
 * so the two sides are held to one shape.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SessionContext } from '../../lib/contract/adapter';
import { createVirtualClock } from '../../lib/contract/clock';
import { recordEvents, type AdapterEvent } from '../../lib/contract/events';
import { fakeSockets } from '../../lib/contract/testing/fakeSocket';
import { trackedClock } from '../../lib/contract/testing/trackedClock';
import { capabilityList, LAN_PIPELINE, modelList, type SharedModel } from '../../lib/lan/protocol';
import { buildLocalAI, createLocalAICheck, localaiLanguages, LOCALAI_DEFAULTS, type LocalAIConfig, type LocalAICredentials, type LocalAISettings } from './localai';
import { isKotomimiServer, kindOf, modelsFor, type LocalAIModel } from './localaiModels';
import { createPipelineAdapter, FIRST_REF, type TextStage } from './pipeline';
import { SHARED } from './testing';

const K: LocalAICredentials = { apiKey: '', endpoint: 'ws://192.168.1.20:8790/v1/realtime' };
const SERVER = 'http://192.168.1.20:8790/v1';
const THEIRS: SharedModel[] = [
  { id: 'sensevoice-int8', kind: 'asr', languages: ['zh', 'en', 'ja', 'ko', 'yue'] },
  { id: 'whisper-large-v3-turbo-webgpu', kind: 'asr', languages: [] },
  { id: 'bing-translator', kind: 'translate', languages: [] },
];
/** What the check answers for that server. */
const FOUND: LocalAIModel[] = [
  { id: LAN_PIPELINE, kind: 'pipeline', host: 'kotomimi' },
  // The languages a recognizer takes come along; one that takes any says none.
  { id: 'sensevoice-int8', kind: 'asr', host: 'kotomimi', languages: ['zh', 'en', 'ja', 'ko', 'yue'] },
  { id: 'whisper-large-v3-turbo-webgpu', kind: 'asr', host: 'kotomimi' },
  { id: 'bing-translator', kind: 'translate', host: 'kotomimi' },
];
const SPEAKER: SessionContext = { direction: { source: 'zh-CN', target: 'ja' }, speech: false, turns: 'auto' };
const shared = { ...SHARED, reversed: (d: SessionContext['direction']) => d.source === 'ja', models: FOUND };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const settings = (patch: Partial<LocalAISettings> = {}): LocalAISettings => ({ ...LOCALAI_DEFAULTS, model: '', ...patch });

function configFor(patch: Partial<LocalAISettings> = {}, context: SessionContext = SPEAKER): LocalAIConfig {
  const config = buildLocalAI(context, settings(patch), shared);
  if ('refused' in config) throw new Error(config.refused);
  return config;
}

describe('another Kotomimi\'s model lists', () => {
  const serve = (key = '') => vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (key && (init?.headers as Record<string, string> | undefined)?.Authorization !== `Bearer ${key}`) return json({ error: { code: 'invalid_api_key' } }, 401);
    return String(input).endsWith('/capabilities') ? json(capabilityList(THEIRS)) : json(modelList(THEIRS));
  });
  const check = (fetch: ReturnType<typeof serve>, s = settings(), k = K) =>
    createLocalAICheck({ fetch: fetch as unknown as typeof globalThis.fetch, clock: createVirtualClock(0) })(k, s, { pair: { source: 'zh-CN', target: 'ja' }, legs: ['speaker'] });

  it('are read as what they are: a pipeline, recognizers, and translation models that are no chat models — every one marked as that Kotomimi\'s', async () => {
    expect(await check(serve())).toEqual({ ok: true, models: FOUND });
    expect(kindOf(['translate'])).toBe('translate');
    expect(isKotomimiServer(FOUND)).toBe(true);
    expect(isKotomimiServer([{ id: 'gpt-realtime', kind: 'pipeline' }])).toBe(false);
  });

  it('offer a translation model to the translation slot, and never to the feedback slot', () => {
    expect(modelsFor(FOUND, 'translate').map((m) => m.id)).toEqual(['bing-translator']);
    expect(modelsFor(FOUND, 'coach')).toEqual([]);
    expect(modelsFor(FOUND, 'asr').map((m) => m.id)).toEqual(['sensevoice-int8', 'whisper-large-v3-turbo-webgpu']);
    expect(modelsFor(FOUND, 'pipeline').map((m) => m.id)).toEqual([LAN_PIPELINE]);
  });

  it('carries an explicit bilingual capability from the host into the language controls', async () => {
    const offered: SharedModel[] = [
      ...THEIRS,
      ...['en', 'fr'].map((language) => ({ id: `apple-speech:${language}`, kind: 'asr' as const, languages: [language], bilingual: true })),
    ];
    const fetch = vi.fn(async (input: RequestInfo | URL) => json(String(input).endsWith('/capabilities') ? capabilityList(offered) : modelList(offered)));
    const result = await check(fetch);
    expect(result).toMatchObject({ ok: true, models: expect.arrayContaining([
      { id: 'apple-speech:en', kind: 'asr', host: 'kotomimi', languages: ['en'], bilingual: true },
      { id: 'apple-speech:fr', kind: 'asr', host: 'kotomimi', languages: ['fr'], bilingual: true },
    ]) });
  });

  it('are asked with the access key when that Kotomimi has one, and a wrong key is the key\'s refusal', async () => {
    const fetch = serve('s3cret');
    expect(await check(fetch, settings({ serverNeedsKey: true }), { ...K, apiKey: 's3cret' })).toMatchObject({ ok: true });
    expect(await check(fetch, settings({ serverNeedsKey: true }), { ...K, apiKey: 'wrong' })).toMatchObject({ ok: false, code: 'server_key_refused' });
  });

  it('list, for a text stage that names it as its own server, its pipeline and translation models only', async () => {
    const elsewhere = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('http://192.168.1.30:8790')) return url.endsWith('/capabilities') ? json(capabilityList(THEIRS)) : json(modelList(THEIRS));
      return url.endsWith('/capabilities') ? json({}, 404) : json({ data: [{ id: 'gpt-realtime' }] });
    });
    const result = await check(elsewhere as never, settings({ translateAt: 'api', translateModel: 'bing-translator', translateBaseUrl: 'http://192.168.1.30:8790/v1', translateNeedsKey: false }));
    expect(result).toEqual({
      ok: true,
      models: [
        { id: 'gpt-realtime' },
        { id: LAN_PIPELINE, kind: 'translate', from: 'translate', host: 'kotomimi' },
        { id: 'bing-translator', kind: 'translate', from: 'translate', host: 'kotomimi' },
      ],
    });
  });
});

describe('a leg another Kotomimi hears', () => {
  it('is cut into sentences there with this computer\'s own speech detection, not Realtime\'s semantic default', () => {
    expect(configFor({ asrVia: 'server', vadThreshold: 0.35, vadMinSilenceDuration: 1.2 }).turnDetection).toEqual({ type: 'server_vad', threshold: 0.35, prefixPaddingMs: 300, silenceDurationMs: 1200 });
    // A leg whose turns are its own commits them, as ever.
    expect(configFor({ asrVia: 'server' }, { ...SPEAKER, turns: 'manual' }).turnDetection).toBeNull();
    // And it takes the quick pace a video asks for.
    expect(configFor({ asrVia: 'server' }).paces).toBe(true);
  });

  it('keeps a selected non-detecting recognizer when the host also advertises a detector', () => {
    const models: LocalAIModel[] = [...FOUND, { id: 'qwen3-asr-1.7b-q8', host: 'kotomimi', kind: 'asr', languages: ['auto', 'zh', 'ja'] }];
    const s = settings({ asrModel: 'sensevoice-int8', speakBoth: true, asrDetectOther: true });
    const controls = localaiLanguages.detection?.(s, models, SPEAKER.direction);
    expect(controls?.both).toMatchObject({ on: true, available: true, bestEffort: true });
    expect(controls?.other).toMatchObject({ on: true, available: true, bestEffort: true });
    for (const direction of [SPEAKER.direction, { source: 'ja', target: 'zh-CN' }]) {
      expect(buildLocalAI({ ...SPEAKER, direction }, s, { ...shared, models })).toMatchObject({
        transcription: { model: 'sensevoice-int8', language: direction.source === 'zh-CN' ? 'zh' : 'ja' },
        stages: { heard: 'auto' },
      });
    }
  });

  it('hears an explicitly selected Apple pair as a best effort when the host is old or lacks either language', async () => {
    const pair = { source: 'en', target: 'fr' };
    const offered: SharedModel[] = ['en', 'fr'].map((language) => ({ id: `apple-speech:${language}`, kind: 'asr', languages: [language], bilingual: true }));
    for (const asr of [offered.map(({ bilingual: _, ...m }) => m), offered.slice(0, 1)]) {
      const all = [...asr, { id: 'bing-translator', kind: 'translate' as const, languages: [] }];
      const fetch = vi.fn(async (input: RequestInfo | URL) => json(String(input).endsWith('/capabilities') ? capabilityList(all) : modelList(all)));
      const s = settings({ asrModel: 'apple-speech', speakBoth: true });
      const result = await createLocalAICheck({ fetch })(K, s, { pair, legs: ['speaker'] });
      expect(result).toMatchObject({ ok: true });
      const models = result.models ?? [];
      expect(buildLocalAI({ ...SPEAKER, direction: pair }, s, { ...shared, models, reversed: () => false })).toMatchObject({ stages: { heard: 'auto' } });
      expect(localaiLanguages.detection?.(s, models, pair).both).toMatchObject({ on: true, available: true });
    }
  });

  it('exposes both toggles for a paired host: bilingual is exact, open-ended detection is a best effort', () => {
    const pair = { source: 'en', target: 'fr' };
    const models: LocalAIModel[] = ['en', 'fr'].map((language) => ({ id: `apple-speech:${language}`, host: 'kotomimi', kind: 'asr', languages: [language], bilingual: true }));
    const controls = localaiLanguages.detection?.(settings({ asrModel: 'apple-speech', speakBoth: true }), models, pair);
    expect(controls?.both).toMatchObject({ on: true, available: true });
    expect(controls?.other).toMatchObject({ on: false, available: true });
    expect(controls?.both.turn(true)).toEqual({ speakBoth: true });
  });

  it('keeps both paired recognition candidates when translation and feedback are enabled together', () => {
    const models: LocalAIModel[] = [
      ...['zh', 'ja'].map((language) => ({ id: `apple-speech:${language}`, host: 'kotomimi' as const, kind: 'asr' as const, languages: [language], bilingual: true })),
      { id: LAN_PIPELINE, host: 'kotomimi', kind: 'pipeline' },
      { id: 'bing-translator', host: 'kotomimi', kind: 'translate' },
    ];
    const s = settings({ asrModel: 'apple-speech', speakBoth: true, coach: true, coachAt: 'api', coachBaseUrl: 'https://feedback.example.com/v1', coachModel: 'feedback-model' });
    const config = buildLocalAI(SPEAKER, s, { ...shared, models });
    if ('refused' in config) throw new Error(config.refused);
    expect(config.transcription).toMatchObject({ languages: ['zh', 'ja'] });
    expect(config.stages).toMatchObject({
      requiresLanguage: true,
      heard: 'auto',
      speech: { kind: 'translate' },
      back: { language: 'ja', own: 'zh-CN', stage: { kind: 'translate' } },
      feedback: { language: 'ja', stage: { kind: 'coach' } },
    });
    expect(localaiLanguages.detection?.(s, models, SPEAKER.direction).both).toMatchObject({ on: true, available: true });
  });

  it('opens a transcription session and asks the pipeline, over chat, for the translation — with the pair', () => {
    const c = configFor();
    expect(c).toMatchObject({ model: LAN_PIPELINE, transcribeOnly: true });
    const stage = c.stages?.speech as TextStage;
    expect(stage).toMatchObject({ kind: 'translate', baseUrl: '', model: LAN_PIPELINE, pair: { source: 'zh-CN', target: 'ja' } });
    expect(stage).not.toHaveProperty('key');
    expect(c.stages?.typed).toBe(stage);
  });

  it('names a translation model of that Kotomimi when one is chosen, still with the pair', () => {
    const stage = configFor({ translateServerModel: 'bing-translator' }).stages?.speech as TextStage;
    expect(stage).toMatchObject({ model: 'bing-translator', pair: { source: 'zh-CN', target: 'ja' } });
  });

  it('tells no pair to a chat model elsewhere: a hosted API may refuse a field it does not know', () => {
    const stage = configFor({ translateAt: 'api', translateModel: 'gpt-4.1-mini', translateBaseUrl: 'https://api.example.com/v1', translateNeedsKey: false }).stages?.speech as TextStage;
    expect(stage).not.toHaveProperty('pair');
  });

  it('takes the recognizer chosen, which a LocalAI would refuse in a transcription session', () => {
    expect(configFor({ asrModel: 'whisper-large-v3-turbo-webgpu' }).transcription).toEqual({ model: 'whisper-large-v3-turbo-webgpu', language: 'zh' });
    expect(configFor().transcription).toEqual({ language: 'zh' });
  });

  it('asks its pipeline for the translation of a leg heard elsewhere, too', () => {
    const c = configFor({ asrVia: 'api', asrApiBaseUrl: 'https://api.example.com/v1', asrApiModel: 'whisper-1' });
    expect(c.model).toBe('');
    expect(c.stages?.speech).toMatchObject({ kind: 'translate', baseUrl: '', model: LAN_PIPELINE, pair: { source: 'zh-CN', target: 'ja' } });
  });

  it('uses that Kotomimi\'s access key for its chat requests too', () => {
    expect((configFor({ serverNeedsKey: true }).stages?.speech as TextStage).key).toBe('apiKey');
  });

  it('sends the pair up with each sentence, and the key as a Bearer token', async () => {
    const config = configFor({ serverNeedsKey: true });
    const sockets = fakeSockets();
    const { clock } = trackedClock();
    const { events, log } = recordEvents();
    const calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(init?.body as string), headers: init?.headers as Record<string, string> });
      // The device leaves the model to itself here, and names the one it ran in its answer.
      return json({ model: 'index-translate-2b', choices: [{ message: { role: 'assistant', content: 'こんにちは' } }] });
    });
    const starting = createPipelineAdapter({ openSocket: sockets.create, fetch: fetch as unknown as typeof globalThis.fetch })
      .start({ context: SPEAKER, config, credentials: { ...K, apiKey: 's3cret' }, clock, signal: new AbortController().signal }, events);
    const socket = sockets.last();
    expect(socket.protocols).toEqual(['realtime', 'openai-insecure-api-key.s3cret']);
    socket.open('realtime');
    socket.receive(JSON.stringify({ type: 'session.created', session: { id: 'sess_1', type: 'transcription', model: LAN_PIPELINE } }));
    socket.receive(JSON.stringify({ type: 'session.updated', session: { id: 'sess_1', type: 'transcription' } }));
    await starting;
    // As `transcriber.ts` writes an utterance.
    for (const e of [
      { type: 'input_audio_buffer.speech_started', item_id: 'item_1' },
      { type: 'conversation.item.input_audio_transcription.delta', item_id: 'item_1', content_index: 0, delta: '你好' },
      { type: 'input_audio_buffer.speech_stopped', item_id: 'item_1' },
      { type: 'input_audio_buffer.committed', item_id: 'item_1', previous_item_id: null },
      { type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_1', content_index: 0, transcript: '你好' },
    ]) socket.receive(JSON.stringify(e));
    const of = <T extends AdapterEvent['kind']>(kind: T) => log.filter((e): e is Extract<AdapterEvent, { kind: T }> => e.kind === kind);
    await vi.waitFor(() => expect(of('segmentText').some((e) => e.payload.ref === FIRST_REF + 1)).toBe(true));
    expect(calls[0].url).toBe(`${SERVER}/chat/completions`);
    expect(calls[0].body).toMatchObject({ model: LAN_PIPELINE, source_language: 'zh-CN', target_language: 'ja' });
    expect(calls[0].headers.Authorization).toBe('Bearer s3cret');
    expect(of('segmentText').map((e) => [e.payload.ref, e.payload.text])).toEqual([[1, '你好'], [FIRST_REF + 1, 'こんにちは']]);
    expect(of('segmentOpened').map((e) => e.payload.origin)).toEqual(['item_1', 'item_1']);
    // The one that ran, as its answer named it — not the pipeline's name that was asked.
    expect(of('frame').filter((e) => e.payload.type === 'text.done').map((e) => e.payload.payload))
      .toMatchObject([{ model: LAN_PIPELINE, served: 'index-translate-2b' }]);
    // The key is never framed.
    expect(JSON.stringify(of('frame'))).not.toContain('s3cret');
  });
});

describe('another Kotomimi that hears none of a leg\'s language', () => {
  /** That Kotomimi lends `theirs`, and — as a sharing computer with a LocalAI does — `lent`, its LocalAI's recognizers. */
  const serving = (theirs: SharedModel[], lent: string[] = []) => vi.fn(async (input: RequestInfo | URL) => {
    const caps = capabilityList(theirs);
    const list = modelList(theirs);
    for (const id of lent) {
      caps.data.push({ id, capabilities: ['transcript'] });
      list.data.push({ id, object: 'model', owned_by: 'localai' });
    }
    return String(input).endsWith('/capabilities') ? json(caps) : json(list);
  });
  const JA_ONLY: SharedModel[] = [{ id: 'custom-kotoba-whisper', kind: 'asr', languages: ['ja'] }, { id: 'bing-translator', kind: 'translate', languages: [] }];
  const ask = (fetch: ReturnType<typeof serving>, legs: Array<'speaker' | 'participant'>, patch: Partial<LocalAISettings> = {}) =>
    createLocalAICheck({ fetch: fetch as unknown as typeof globalThis.fetch, clock: createVirtualClock(0) })(K, settings(patch), { pair: { source: 'zh-CN', target: 'ja' }, legs, signal: new AbortController().signal });

  it('is refused before Start, naming the language, where its socket would refuse the session', async () => {
    // I speak Chinese; it hears Japanese only.
    const told = serving(JA_ONLY);
    expect(await ask(told, ['speaker'])).toMatchObject({ ok: false, code: 'server_no_asr', params: { source: 'zh-CN' } });
    // It is told which language it found nothing for: its settings then offer a model for it (fork).
    expect(told.mock.calls.map((c) => String(c[0])).filter((url) => url.includes('asks='))).toEqual([expect.stringMatching(/\/models\/capabilities\?asks=zh-CN(&|$)/)]);
    // What it lists stays: another place, or a model there, is chosen from it.
    expect(await ask(serving(JA_ONLY), ['speaker'])).toMatchObject({ models: expect.arrayContaining([expect.objectContaining({ id: 'custom-kotoba-whisper' })]) });
  });

  it('passes what it hears: the other side\'s Japanese, a coached speaker\'s Japanese, a recognizer that hears any language, the LocalAI it lends', async () => {
    expect(await ask(serving(JA_ONLY), ['participant'])).toMatchObject({ ok: true });
    expect(await ask(serving(JA_ONLY), ['speaker'], { coach: true, coachAt: 'api', coachBaseUrl: 'http://x/v1', coachModel: 'm', coachNeedsKey: false })).toMatchObject({ ok: true });
    expect(await ask(serving([...JA_ONLY, { id: 'whisper-large-v3-turbo-webgpu', kind: 'asr', languages: [] }]), ['speaker'])).toMatchObject({ ok: true });
    expect(await ask(serving(JA_ONLY, ['apple-speech-transcriber']), ['speaker'])).toMatchObject({ ok: true });
    // Heard elsewhere: what that Kotomimi hears does not matter.
    expect(await ask(serving(JA_ONLY), ['speaker'], { asrVia: 'api', asrApiBaseUrl: 'http://x/v1', asrApiModel: 'm', asrApiNeedsKey: false })).toMatchObject({ ok: true });
  });

  it('is refused before Start where the other side is to be detected and none it lists detects: that leg is told its own language (fork)', async () => {
    const ZH_ONLY: SharedModel[] = [{ id: 'sensevoice-small-q8', kind: 'asr', languages: ['zh'] }, { id: 'bing-translator', kind: 'translate', languages: [] }];
    // The other side speaks Japanese, which SenseVoice is not said to hear here: the session would be refused at Start.
    expect(await ask(serving(ZH_ONLY), ['participant'], { asrDetectOther: true })).toMatchObject({ ok: false, code: 'server_no_asr', params: { source: 'ja' } });
    // One that detects is listed: the leg is told "auto", and nothing is refused.
    expect(await ask(serving([...ZH_ONLY, { id: 'qwen3-asr-1.7b-q8', kind: 'asr', languages: ['zh', 'ja', 'auto'] }]), ['participant'], { asrDetectOther: true })).toMatchObject({ ok: true });
  });
});

describe('a translation model that cannot take a direction of the run (fork)', () => {
  const serving = (models: SharedModel[]) => vi.fn(async (input: RequestInfo | URL) =>
    (String(input).endsWith('/capabilities') ? json(capabilityList(models)) : json(modelList(models))));
  const ask = (
    fetch: ReturnType<typeof serving>, patch: Partial<LocalAISettings>, pair: { source: string; target: string },
    legs: Array<'speaker' | 'participant'> = ['speaker'],
  ) => createLocalAICheck({ fetch: fetch as unknown as typeof globalThis.fetch, clock: createVirtualClock(0) })(K, settings(patch), { pair, legs, signal: new AbortController().signal });

  it('is refused before the run, where another model would otherwise answer in its place', async () => {
    const fetch = serving([
      { id: 'whisper-large', kind: 'asr', languages: [] },
      { id: 'hy-mt2-1.8b', kind: 'translate', languages: ['ja', 'zh', 'en'] },
    ]);
    expect(await ask(fetch, { translateServerModel: 'hy-mt2-1.8b' }, { source: 'zh-CN', target: 'el' }))
      .toMatchObject({ ok: false, code: 'server_translator_unfit', params: { name: 'Hunyuan MT 2 1.8B' } });
    // The pair it does take is ready.
    expect(await ask(fetch, { translateServerModel: 'hy-mt2-1.8b' }, { source: 'zh-CN', target: 'ja' })).toMatchObject({ ok: true });
  });

  it('is refused for the other side of a directional model, which names one way only', async () => {
    const fetch = serving([
      { id: 'whisper-large', kind: 'asr', languages: [] },
      { id: 'opus-mt-ja-en', kind: 'translate', languages: ['ja', 'en'], pair: ['ja', 'en'] },
    ]);
    expect(await ask(fetch, { translateServerModel: 'opus-mt-ja-en' }, { source: 'ja', target: 'en' })).toMatchObject({ ok: true });
    expect(await ask(fetch, { translateServerModel: 'opus-mt-ja-en' }, { source: 'ja', target: 'en' }, ['speaker', 'participant']))
      .toMatchObject({ ok: false, code: 'server_translator_unfit' });
  });
});
