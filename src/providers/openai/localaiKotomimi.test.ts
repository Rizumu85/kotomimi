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
import { buildLocalAI, createLocalAICheck, LOCALAI_DEFAULTS, type LocalAIConfig, type LocalAICredentials, type LocalAISettings } from './localai';
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
  { id: 'sensevoice-int8', kind: 'asr', host: 'kotomimi' },
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

  it('are asked with the access key when that Kotomimi has one, and a wrong key is the key\'s refusal', async () => {
    const fetch = serve('s3cret');
    expect(await check(fetch, settings({ serverNeedsKey: true }), { ...K, apiKey: 's3cret' })).toMatchObject({ ok: true });
    expect(await check(fetch, settings({ serverNeedsKey: true }), { ...K, apiKey: 'wrong' })).toMatchObject({ ok: false, code: 'auth' });
  });

  it('list, for a text stage that names it as its own server, its pipeline and translation models only', async () => {
    const elsewhere = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('http://192.168.1.30:8790')) return url.endsWith('/capabilities') ? json(capabilityList(THEIRS)) : json(modelList(THEIRS));
      return url.endsWith('/capabilities') ? json({}, 404) : json({ data: [{ id: 'gpt-realtime' }] });
    });
    const result = await check(elsewhere as never, settings({ translateVia: 'model', translateModel: 'bing-translator', translateBaseUrl: 'http://192.168.1.30:8790/v1' }));
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
  it('opens a transcription session and asks the pipeline, over chat, for the translation — with the pair', () => {
    const c = configFor();
    expect(c).toMatchObject({ model: LAN_PIPELINE, transcribeOnly: true });
    const stage = c.stages?.speech as TextStage;
    expect(stage).toMatchObject({ kind: 'translate', baseUrl: '', model: LAN_PIPELINE, pair: { source: 'zh-CN', target: 'ja' } });
    expect(stage).not.toHaveProperty('key');
    expect(c.stages?.typed).toBe(stage);
  });

  it('names a translation model of that Kotomimi when one is chosen, still with the pair', () => {
    const stage = configFor({ translateVia: 'model', translateModel: 'bing-translator' }).stages?.speech as TextStage;
    expect(stage).toMatchObject({ model: 'bing-translator', pair: { source: 'zh-CN', target: 'ja' } });
  });

  it('tells no pair to a chat model elsewhere: a hosted API may refuse a field it does not know', () => {
    const stage = configFor({ translateVia: 'model', translateModel: 'gpt-4.1-mini', translateBaseUrl: 'https://api.example.com/v1' }).stages?.speech as TextStage;
    expect(stage).not.toHaveProperty('pair');
  });

  it('takes the recognizer chosen, which a LocalAI would refuse in a transcription session', () => {
    expect(configFor({ asrModel: 'whisper-large-v3-turbo-webgpu' }).transcription).toEqual({ model: 'whisper-large-v3-turbo-webgpu', language: 'zh' });
    expect(configFor().transcription).toEqual({ language: 'zh' });
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
      return json({ choices: [{ message: { role: 'assistant', content: 'こんにちは' } }] });
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
    // The key is never framed.
    expect(JSON.stringify(of('frame'))).not.toContain('s3cret');
  });
});
