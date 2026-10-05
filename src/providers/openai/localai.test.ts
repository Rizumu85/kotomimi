import { describe, it, expect, vi } from 'vitest';
import type { SessionContext } from '../../lib/contract/adapter';
import { createVirtualClock } from '../../lib/contract/clock';
import { recordEvents, type AdapterEvent } from '../../lib/contract/events';
import { fakeSockets } from '../../lib/contract/testing/fakeSocket';
import { trackedClock } from '../../lib/contract/testing/trackedClock';
import { isPresent } from '../../lib/provider/presence';
import type { CheckContext } from '../../lib/provider/types';
import { PROVIDERS } from '../registry';
import { createRealtimeAdapter } from './adapter';
import type { RealtimeConfig } from './config';
import {
  buildLocalAI, createLocalAICheck, effectiveLocalAIModel, LOCALAI_DEFAULTS, localaiCredentials, localaiEndpoint, localaiModelsUrl, localaiProvider,
  migrateLocalAISettings, type LocalAICredentials, type LocalAISettings,
} from './localai';
import { REALTIME_WS_URL, realtimeProtocols, realtimeUrl } from './wire';
import { SHARED } from './testing';

const K: LocalAICredentials = { apiKey: '', endpoint: 'ws://192.168.1.10:8080/v1/realtime' };
const AUTO: SessionContext = { direction: { source: 'en', target: 'zh-CN' }, speech: false, turns: 'auto' };
const MANUAL: SessionContext = { ...AUTO, turns: 'manual' };
const SERVER_MODELS = { ...SHARED, models: [{ id: 'apple-speech-transcriber' }, { id: 'gpt-realtime' }, { id: 'whisper-large-turbo' }] };
const ctx = (signal?: AbortSignal): CheckContext => ({ pair: { source: 'en', target: 'zh-CN' }, legs: ['speaker'], signal });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const noAuth = { signedIn: false, getToken: async () => null };

function configFor(context: SessionContext = AUTO, patch: Partial<LocalAISettings> = {}): RealtimeConfig {
  const c = buildLocalAI(context, { ...LOCALAI_DEFAULTS, ...patch }, SERVER_MODELS);
  if ('refused' in c) throw new Error(c.refused);
  return c;
}

/** The frames a live LocalAI sent the GA client (probed 2026-10-02): no `event_id` worth reading, no `conversation_id`, an input item re-announced under another id. */
const frame = (e: Record<string, unknown>) => JSON.stringify(e);
const LOCALAI = {
  created: () => frame({ type: 'session.created', event_id: 'event_TODO', session: { id: 'sess_1', object: 'realtime.session', type: 'realtime', model: 'gpt-realtime', audio: { input: { turn_detection: { type: 'semantic_vad', eagerness: 'high', create_response: true, interrupt_response: true }, transcription: { model: 'apple-speech-transcriber' } }, output: {} } } }),
  updated: () => frame({ type: 'session.updated', event_id: 'event_TODO', session: { id: 'sess_1', object: 'realtime.session', type: 'realtime', model: 'gpt-realtime', output_modalities: ['text'], max_output_tokens: 'inf', audio: { input: { transcription: { model: 'apple-speech-transcriber', language: 'en' } }, output: {} } } }),
  committed: (itemId: string) => frame({ type: 'input_audio_buffer.committed', item_id: itemId }),
  inputDelta: (itemId: string, delta: string) => frame({ type: 'conversation.item.input_audio_transcription.delta', event_id: 'event_TODO', item_id: itemId, content_index: 0, delta }),
  inputDone: (itemId: string, transcript: string) => frame({ type: 'conversation.item.input_audio_transcription.completed', event_id: 'event_TODO', item_id: itemId, content_index: 0, transcript }),
  itemAdded: (itemId: string, transcript: string) => frame({ type: 'conversation.item.added', item: { id: itemId, type: 'message', role: 'user', status: 'completed', content: [{ type: 'input_audio', audio: 'AAAA', transcript }] } }),
  responseCreated: (id: string) => frame({ type: 'response.created', response: { id, object: 'realtime.response', status: 'in_progress' } }),
  outputItemAdded: (id: string, itemId: string) => frame({ type: 'response.output_item.added', response_id: id, output_index: 0, item: { id: itemId, type: 'message', role: 'assistant', status: 'in_progress', content: [] } }),
  textDelta: (id: string, itemId: string, delta: string) => frame({ type: 'response.output_text.delta', response_id: id, item_id: itemId, output_index: 0, content_index: 0, delta }),
  textDone: (id: string, itemId: string, text: string) => frame({ type: 'response.output_text.done', response_id: id, item_id: itemId, output_index: 0, content_index: 0, text }),
  outputItemDone: (id: string, itemId: string) => frame({ type: 'response.output_item.done', response_id: id, output_index: 0, item: { id: itemId, type: 'message', role: 'assistant', status: 'completed', content: [] } }),
  responseDone: (id: string) => frame({ type: 'response.done', response: { id, object: 'realtime.response', status: 'completed', output: [], usage: { total_tokens: 80, input_tokens: 75, output_tokens: 5 } } }),
  transcriptionFailed: () => frame({ type: 'error', event_id: 'event_TODO', error: { type: 'invalid_request_error', code: 'transcription_failed', message: 'rpc error', event_id: 'event_TODO' } }),
};

/** A LocalAI leg over a `FakeSocket`, started, opened with no subprotocol, created and configured. */
async function live(context: SessionContext = AUTO, patch: Partial<LocalAISettings> = {}) {
  const sockets = fakeSockets();
  const { clock } = trackedClock();
  const { events, log } = recordEvents();
  const config = configFor(context, patch);
  const starting = createRealtimeAdapter({ openSocket: sockets.create }).start({ context, config, credentials: K, clock, signal: new AbortController().signal }, events);
  const socket = sockets.last();
  socket.open('');
  socket.receive(LOCALAI.created());
  socket.receive(LOCALAI.updated());
  const session = await starting;
  const sent = () => socket.sentJson<Record<string, unknown>>();
  const of = <T extends AdapterEvent['kind']>(kind: T) => log.filter((e): e is Extract<AdapterEvent, { kind: T }> => e.kind === kind);
  return { socket, session, sent, of, log, receive: (...messages: string[]) => { for (const m of messages) socket.receive(m); } };
}

describe("LocalAI Realtime's endpoint", () => {
  it('reads a bare host, an http URL, a /v1 base and the full path as one socket URL', () => {
    for (const typed of ['192.168.1.10:8080', ' 192.168.1.10:8080 ', 'http://192.168.1.10:8080', 'http://192.168.1.10:8080/', 'ws://192.168.1.10:8080/v1', 'ws://192.168.1.10:8080/v1/', 'ws://192.168.1.10:8080/v1/realtime', 'ws://192.168.1.10:8080/v1/realtime?model=other']) {
      expect(localaiEndpoint(typed), typed).toBe('ws://192.168.1.10:8080/v1/realtime');
    }
    expect(localaiEndpoint('https://mac.local/v1')).toBe('wss://mac.local/v1/realtime');
    expect(localaiEndpoint('ws://host:9000/custom/rt')).toBe('ws://host:9000/custom/rt');
  });

  it('answers null for nothing, for a scheme no socket dials, and for what is no URL', () => {
    for (const typed of ['', '   ', 'ftp://host:21', 'http://', 'ws://']) expect(localaiEndpoint(typed), typed).toBeNull();
  });

  it('finds the model list beside the Realtime path, over http', () => {
    expect(localaiModelsUrl('ws://192.168.1.10:8080/v1/realtime')).toBe('http://192.168.1.10:8080/v1/models');
    expect(localaiModelsUrl('wss://mac.local/v1/realtime')).toBe('https://mac.local/v1/models');
  });

  it('is the one credential while every stage is the server\'s, and carries no Realtime key', () => {
    expect(localaiCredentials.keys).toEqual(['endpoint', 'serverKey', 'asrKey', 'translateKey', 'coachKey']);
    expect(localaiCredentials.fields(LOCALAI_DEFAULTS).map((f) => [f.key, f.secret])).toEqual([['endpoint', false]]);
    expect(localaiCredentials.read({ endpoint: 'http://192.168.1.10:8080' }, noAuth)).toEqual(K);
    expect(localaiCredentials.read({ endpoint: '' }, noAuth)).toHaveProperty('missing');
  });

  it('is not asked for while no stage is on a server, and a server that wants a key is given it as the Realtime key', () => {
    const here = { ...LOCALAI_DEFAULTS, asrVia: 'device' as const, translateAt: 'device' as const };
    // This computer hears and translates: no other device at all.
    expect(localaiCredentials.fields(here)).toEqual([]);
    expect(localaiCredentials.read({}, noAuth)).toEqual({ apiKey: '', endpoint: '' });
    // A translation left on the other device brings the address back; one at an API does not.
    expect(localaiCredentials.fields({ ...here, translateAt: 'server' }).map((f) => f.key)).toEqual(['endpoint']);
    expect(localaiCredentials.fields({ ...here, translateAt: 'api', translateNeedsKey: false })).toEqual([]);
    expect(localaiCredentials.fields({ ...LOCALAI_DEFAULTS, serverNeedsKey: true }).map((f) => [f.key, f.secret])).toEqual([['endpoint', false], ['serverKey', true]]);
    expect(localaiCredentials.read({ endpoint: '192.168.1.10:8080', serverKey: ' abc ' }, noAuth)).toEqual({ ...K, apiKey: 'abc' });
    expect(localaiCredentials.read({ endpoint: '192.168.1.10:8080', serverKey: '' }, noAuth)).toHaveProperty('missing');
    expect(realtimeProtocols({ ...K, apiKey: 'abc' })).toEqual(['realtime', 'openai-insecure-api-key.abc']);
  });
});

describe("LocalAI Realtime's stage keys", () => {
  const fields = (patch: Partial<LocalAISettings>) => localaiCredentials.fields({ ...LOCALAI_DEFAULTS, ...patch }).map((f) => [f.key, f.secret]);

  it('asks for an API\'s key only while a stage runs there and the API wants one', () => {
    expect(fields({ translateAt: 'api' })).toEqual([['endpoint', false], ['translateKey', true]]);
    expect(fields({ translateAt: 'api', translateNeedsKey: false })).toEqual([['endpoint', false]]);
    // Not in use: the other device translates.
    expect(fields({ translateNeedsKey: true })).toEqual([['endpoint', false]]);
    expect(fields({ coach: true, coachAt: 'api' })).toEqual([['endpoint', false], ['coachKey', true]]);
    // No one is coached: the feedback's place asks for nothing.
    expect(fields({ coachAt: 'api' })).toEqual([['endpoint', false]]);
  });

  it('leaves every field to the stage cards to draw, beside the stage it belongs to', () => {
    const all = localaiCredentials.fields({ ...LOCALAI_DEFAULTS, serverNeedsKey: true, translateAt: 'api', coach: true, coachAt: 'api' });
    expect(all.map((f) => f.key)).toEqual(['endpoint', 'serverKey', 'translateKey', 'coachKey']);
    expect(all.every((f) => f.drawnByAssist)).toBe(true);
  });

  it('reads the keys shown, and is missing while one is blank', () => {
    expect(localaiCredentials.read({ endpoint: '192.168.1.10:8080', translateKey: ' sk-a ', coachKey: 'sk-b' }, noAuth)).toEqual({ ...K, translateKey: 'sk-a', coachKey: 'sk-b' });
    expect(localaiCredentials.read({ endpoint: '192.168.1.10:8080', translateKey: '' }, noAuth)).toHaveProperty('missing');
    expect(localaiCredentials.read({ endpoint: '192.168.1.10:8080', coachKey: ' ' }, noAuth)).toHaveProperty('missing');
  });

  it('declares every setting that decides a field, an endpoint the check reaches, or a model a start needs named', () => {
    expect(localaiProvider.checkReads).toEqual(['asrVia', 'asrApiBaseUrl', 'asrApiModel', 'asrApiNeedsKey', 'asrDetectOther', 'translateAt', 'translateBaseUrl', 'translateNeedsKey', 'coach', 'coachAt', 'coachBaseUrl', 'coachNeedsKey', 'coachDeviceModel', 'serverNeedsKey', 'selections', 'model', 'translateModel', 'translateServerModel', 'coachModel', 'coachServerModel', 'asrHere', 'translateHere', 'translateHereModel', 'coachHere', 'coachHereModel', 'hereAddress', 'asrNativeModel', 'asrNativeByLanguage', 'translateNativeModel', 'coachNativeModel']);
  });
});

describe("LocalAI Realtime's check", () => {
  const SERVER = 'http://192.168.1.10:8080/v1';
  /** The Mac's own answers, as LocalAI gave them (2026-10-03): a pipeline with no capability, recognizers, text models, a VAD. */
  const CAPABILITIES = [
    { id: 'apple-speech-transcriber', capabilities: ['transcript'] },
    { id: 'hy-mt2-1.8b', capabilities: ['chat', 'completion', 'vision'] },
    { id: 'qwen3-1.7b-mlx', capabilities: ['transcript'] },
    { id: 'gpt-realtime', capabilities: null },
    { id: 'qwen3-4b', capabilities: ['chat', 'vision', 'thinking'] },
    { id: 'silero-vad-ggml', capabilities: ['vad'] },
  ];
  const list = (ids: string[]) => json({ object: 'list', data: ids.map((id) => ({ id, object: 'model' })) });
  /** A fetch that answers by URL: the server's list, its capabilities (a 404 when it has none), and any other server's. */
  function server(o: { ids?: string[]; capabilities?: unknown[] | null; other?: () => Promise<Response> } = {}) {
    const ids = o.ids ?? CAPABILITIES.map((m) => m.id);
    return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === `${SERVER}/models`) return list(ids);
      if (url === `${SERVER}/models/capabilities`) return o.capabilities === null ? json({}, 404) : json({ object: 'list', data: o.capabilities ?? CAPABILITIES });
      if (o.other) return o.other();
      throw new Error(`unexpected request: ${url}`);
    });
  }
  const check = (fetch: typeof globalThis.fetch, s: LocalAISettings = LOCALAI_DEFAULTS, k: LocalAICredentials = K) => createLocalAICheck({ fetch, clock: createVirtualClock(0) })(k, s, ctx());

  it('GETs the server\'s model list and its capabilities, with no Authorization header', async () => {
    const fetch = server();
    await check(fetch);
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([`${SERVER}/models`, `${SERVER}/models/capabilities`]);
    for (const call of fetch.mock.calls) expect(call[1]?.headers).toBeUndefined();
  });

  it('answers ready with every model the server lists, in its order, each with what it is for', async () => {
    expect(await check(server())).toEqual({
      ok: true,
      models: [
        { id: 'apple-speech-transcriber', kind: 'asr' },
        { id: 'hy-mt2-1.8b', kind: 'text' },
        // A model named like an LLM that is a recognizer: the server's word, not the name, decides.
        { id: 'qwen3-1.7b-mlx', kind: 'asr' },
        { id: 'gpt-realtime', kind: 'pipeline' },
        { id: 'qwen3-4b', kind: 'text' },
        { id: 'silero-vad-ggml', kind: 'other' },
      ],
    });
  });

  it('lists the models unsorted when the server has no capability list: nothing is hidden on a guess', async () => {
    expect(await check(server({ ids: ['a', 'b', 'a'], capabilities: null }))).toEqual({ ok: true, models: [{ id: 'a' }, { id: 'b' }] });
    // A capability list that cannot be read is done without, too.
    const broken = vi.fn(async (input: RequestInfo | URL) => (String(input).endsWith('/capabilities') ? Promise.reject(new TypeError('Failed to fetch')) : list(['a'])));
    expect(await check(broken)).toEqual({ ok: true, models: [{ id: 'a' }] });
  });

  it('says in words the cards can tell that the other device does not answer, and still could not find out', async () => {
    await expect(check(async () => { throw new TypeError('Failed to fetch'); })).rejects.toThrow(/^The other device could not be reached \(.+\): Failed to fetch$/);
  });

  it('answers not ready when the server lists nothing', async () => {
    expect(await check(server({ ids: [] }))).toMatchObject({ ok: false });
  });

  it('also lists every other server a text stage names, with its key, as text models of that stage', async () => {
    const s = { ...LOCALAI_DEFAULTS, translateAt: 'api' as const, translateModel: 'gpt-4.1-mini', translateBaseUrl: 'https://api.example.com/v1/', translateNeedsKey: true };
    const fetch = server({ other: async () => list(['gpt-4.1-mini', 'gpt-4.1']) });
    const result = await check(fetch, s, { ...K, translateKey: 'sk-a' });
    expect(fetch.mock.calls[2][0]).toBe('https://api.example.com/v1/models');
    expect((fetch.mock.calls[2][1]?.headers as Record<string, string>).Authorization).toBe('Bearer sk-a');
    expect(result).toMatchObject({ ok: true });
    expect((result as unknown as { models: unknown[] }).models.slice(-2)).toEqual([
      { id: 'gpt-4.1-mini', kind: 'text', from: 'translate' },
      { id: 'gpt-4.1', kind: 'text', from: 'translate' },
    ]);
  });

  it('is refused by an API\'s 401 or 403; any other answer passes, and unreachable throws', async () => {
    const inUse = { ...LOCALAI_DEFAULTS, translateAt: 'api' as const, translateModel: 'gpt-4.1-mini', translateBaseUrl: 'https://api.example.com/v1', translateNeedsKey: false };
    // No key was sent: the API is said to ask for one, by its address.
    expect(await check(server({ other: async () => json({}, 401) }), inUse)).toMatchObject({ ok: false, code: 'api_key_needed', params: { address: 'https://api.example.com/v1' } });
    // Not every API lists its models: any other answer passes.
    expect(await check(server({ other: async () => json({}, 404) }), inUse)).toMatchObject({ ok: true });
    // Google says a key it does not know with 400, in words: refused all the same. A 400 about anything else passes.
    expect(await check(server({ other: async () => json({ error: { code: 400, message: 'Please pass a valid API key', status: 'INVALID_ARGUMENT' } }, 400) }), inUse)).toMatchObject({ ok: false, code: 'api_key_needed', params: { address: 'https://api.example.com/v1' } });
    expect(await check(server({ other: async () => json({ error: { message: 'Bad request' } }, 400) }), inUse)).toMatchObject({ ok: true });
    await expect(check(server({ other: async () => { throw new TypeError('Failed to fetch'); } }), inUse)).rejects.toThrow(/translation model's server \(https:\/\/api\.example\.com\/v1\) could not be reached/);
    // An address left from when the stage ran there: not asked at all while it runs elsewhere.
    const elsewhere = { ...LOCALAI_DEFAULTS, translateBaseUrl: 'https://api.example.com/v1' };
    const fetch = server({ other: async () => json({}, 401) });
    expect(await check(fetch, elsewhere)).toMatchObject({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('reaches no other server while the stages are the Realtime server\'s own', async () => {
    const fetch = server();
    await check(fetch, { ...LOCALAI_DEFAULTS, translateServerModel: 'hy-mt2-1.8b', coach: true, coachServerModel: 'qwen3-4b' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('throws on an HTTP error or a failed fetch of the server\'s own list: it could not find out', async () => {
    await expect(check(async () => json({}, 502))).rejects.toThrow(/HTTP 502/);
    await expect(check(async () => { throw new TypeError('Failed to fetch'); })).rejects.toThrow(/Failed to fetch/);
  });
});

describe("LocalAI Realtime's model and config", () => {
  it('runs the model as typed, listed or not, and never an OpenAI default', () => {
    expect(effectiveLocalAIModel({ model: 'gpt-realtime' }, [{ id: 'gpt-realtime-2.1-mini' }])).toBe('gpt-realtime');
    expect(effectiveLocalAIModel({ model: ' my-pipeline ' }, SERVER_MODELS.models)).toBe('my-pipeline');
    expect(configFor(AUTO, { model: 'my-pipeline' }).model).toBe('my-pipeline');
  });

  it('falls to the server\'s list only when the field is blank', () => {
    expect(effectiveLocalAIModel({ model: '' }, SERVER_MODELS.models)).toBe('gpt-realtime');
    expect(effectiveLocalAIModel({ model: '' }, [{ id: 'qwen3-4b' }])).toBe('qwen3-4b');
    // With the server's word on what each model is, only a pipeline: never a text model, or one another server lists.
    expect(effectiveLocalAIModel({ model: '' }, [{ id: 'qwen3-4b', kind: 'text' }, { id: 'my-pipeline', kind: 'pipeline' }, { id: 'gpt-realtime-x', kind: 'text', from: 'translate' }])).toBe('my-pipeline');
    expect(buildLocalAI(AUTO, { ...LOCALAI_DEFAULTS, model: '' }, { ...SHARED, models: [] })).toMatchObject({ code: 'asr_unnamed' });
  });

  it('builds a text-only leg with no voice, no reasoning, no anchor, and commits that answer themselves', () => {
    const c = configFor();
    expect(c).toMatchObject({ model: 'gpt-realtime', modalities: ['text'], anchor: false, commitAnswers: true, transport: 'websocket', noiseReduction: null, maxTokens: 'inf' });
    expect(c).not.toHaveProperty('voice');
    expect(c).not.toHaveProperty('reasoningEffort');
    // Even were the leg asked to speak: the pipeline's audio output never ends its response.
    expect(configFor({ ...AUTO, speech: true }).modalities).toEqual(['text']);
    expect(configFor({ ...AUTO, speech: true })).not.toHaveProperty('voice');
  });

  it('starts from semantic detection at the eagerness LocalAI\'s own session has, and hands a manual leg none', () => {
    expect(configFor().turnDetection).toEqual({ type: 'semantic_vad', eagerness: 'high' });
    expect(configFor(AUTO, { turnDetectionMode: 'Normal' }).turnDetection).toMatchObject({ type: 'server_vad' });
    expect(configFor(MANUAL).turnDetection).toBeNull();
  });

  it('leaves the transcription model to the server, sends the language it hears, and never an OpenAI model name', () => {
    expect(configFor().transcription).toEqual({ language: 'en' });
    expect(configFor({ ...AUTO, direction: { source: 'zh-CN', target: 'en' } }).transcription).toEqual({ language: 'zh' });
    expect(configFor({ ...AUTO, direction: { source: 'auto', target: 'en' } }).transcription).toEqual({});
    expect(configFor(AUTO, { asrModel: 'whisper-large-turbo' }).transcription).toEqual({ model: 'whisper-large-turbo', language: 'en' });
    // A leg that only transcribes takes the server's own recognizer: LocalAI refuses any other in a transcription session.
    expect(configFor(AUTO, { asrModel: 'whisper-large-turbo', translateServerModel: 'hy-mt2-1.8b' }).transcription).toEqual({ language: 'en' });
    // OpenAI Realtime's own transcript model, inherited in `S`, is not read.
    expect(configFor(AUTO, { transcriptModel: 'gpt-4o-transcribe' }).transcription).toEqual({ language: 'en' });
  });

  it('keeps a stored transcription model and defaults a missing one', () => {
    const inputs = { legacy: {}, credentials: {} };
    expect(migrateLocalAISettings({ ...LOCALAI_DEFAULTS, asrModel: 'sensevoice-small-mlx' }, inputs).asrModel).toBe('sensevoice-small-mlx');
    expect(migrateLocalAISettings({ ...LOCALAI_DEFAULTS, asrModel: 7 }, inputs).asrModel).toBe('');
    expect(migrateLocalAISettings({ ...LOCALAI_DEFAULTS }, inputs)).toMatchObject({ model: 'gpt-realtime', turnDetectionMode: 'Semantic', semanticEagerness: 'High' });
    // The stages: stored values kept, anything of the wrong type back to the default.
    expect(migrateLocalAISettings({ ...LOCALAI_DEFAULTS, translateModel: 'm', translateNeedsKey: true, coach: true, coachBaseUrl: 'http://x/v1' }, { legacy: { translateAt: 'api', coachAt: 'device' }, credentials: {} }))
      .toMatchObject({ translateAt: 'api', translateModel: 'm', translateNeedsKey: true, coach: true, coachAt: 'device', coachBaseUrl: 'http://x/v1' });
    expect(migrateLocalAISettings({ ...LOCALAI_DEFAULTS, translateModel: 3, coach: 'yes' }, { legacy: { translateAt: 'cloud' }, credentials: {} })).toMatchObject({ translateAt: 'server', translateModel: '', coach: false });
  });
});

describe("LocalAI Realtime's settings from an earlier build", () => {
  // What the store hands a migration: every field, a default where nothing was stored; and beside it, the raw values of the legacy keys.
  const old = (stored: Record<string, unknown>, legacy: Record<string, unknown>) => migrateLocalAISettings({ ...LOCALAI_DEFAULTS, ...stored }, { legacy, credentials: {} });

  it('reads the earlier words for where the translation ran, until the places are stored', () => {
    expect(localaiProvider.settings.legacyKeys).toEqual(expect.arrayContaining(['translateAt', 'coachAt', 'translateVia', 'translateNeedsKey', 'coachNeedsKey']));
    // Nothing stored: every stage on the other device.
    expect(old({}, {})).toMatchObject({ translateAt: 'server', translateServerModel: '', coachAt: 'server' });
    // This computer translated: by choice, or because it heard, and no pipeline of the other device could answer what it heard.
    expect(old({}, { translateVia: 'device' })).toMatchObject({ translateAt: 'device', coachAt: 'device' });
    expect(old({ asrVia: 'device' }, { translateVia: 'server' })).toMatchObject({ translateAt: 'device' });
    expect(old({ asrVia: 'device' }, {})).toMatchObject({ translateAt: 'device' });
    // A text model: on the other device while its address was blank, else an API — whose key was asked for only when switched on.
    expect(old({ translateModel: 'hy-mt2-1.8b' }, { translateVia: 'model' })).toMatchObject({ translateAt: 'server', translateServerModel: 'hy-mt2-1.8b', translateModel: '' });
    expect(old({ translateModel: 'gpt-x', translateBaseUrl: 'https://api.example.com/v1' }, { translateVia: 'model' })).toMatchObject({ translateAt: 'api', translateModel: 'gpt-x', translateNeedsKey: false });
    expect(old({ translateModel: 'gpt-x', translateBaseUrl: 'https://api.example.com/v1' }, { translateVia: 'model', translateNeedsKey: true })).toMatchObject({ translateAt: 'api', translateNeedsKey: true });
    // A model named under the pipeline is what the page showed it as: the translation's.
    expect(old({ translateModel: 'translategemma-4b' }, { translateVia: 'server' })).toMatchObject({ translateAt: 'server', translateServerModel: 'translategemma-4b', translateModel: '' });
  });

  it('gives the feedback the model it ran on', () => {
    expect(old({ coach: true, coachModel: 'qwen3-4b' }, {})).toMatchObject({ coachAt: 'server', coachServerModel: 'qwen3-4b', coachModel: '' });
    expect(old({ coach: true, coachModel: 'gpt-x', coachBaseUrl: 'https://api.example.com/v1' }, { coachNeedsKey: true })).toMatchObject({ coachAt: 'api', coachModel: 'gpt-x', coachNeedsKey: true });
    // None of its own: the translation's text model.
    expect(old({ coach: true, translateModel: 'translategemma-4b' }, {})).toMatchObject({ coachAt: 'server', coachServerModel: 'translategemma-4b' });
    expect(old({ coach: true, translateModel: 'gpt-x', translateBaseUrl: 'https://api.example.com/v1' }, { translateVia: 'model', translateNeedsKey: true }))
      .toMatchObject({ coachAt: 'api', coachBaseUrl: 'https://api.example.com/v1', coachModel: 'gpt-x', coachNeedsKey: true });
    // While this computer translated there was none to take: the feedback stands beside the translation.
    expect(old({ coach: true, translateModel: 'left-over' }, { translateVia: 'device' })).toMatchObject({ coachAt: 'device', coachServerModel: '' });
  });

  it('reads the places as stored from then on, whatever the earlier words still say', () => {
    expect(old({ asrVia: 'device', translateModel: 'left-over', translateNeedsKey: false }, { translateAt: 'server', coachAt: 'api', translateVia: 'device' }))
      .toMatchObject({ translateAt: 'server', translateServerModel: '', translateModel: 'left-over', translateNeedsKey: false, coachAt: 'api' });
  });
});

describe("LocalAI Realtime's wire", () => {
  it('dials the endpoint with the model in its query, and offers no subprotocol', () => {
    expect(realtimeUrl({ model: 'gpt-realtime' }, K.endpoint)).toBe('ws://192.168.1.10:8080/v1/realtime?model=gpt-realtime');
    expect(realtimeProtocols(K)).toEqual([]);
  });

  it('leaves OpenAI Realtime dialing OpenAI, its key in a subprotocol', () => {
    expect(realtimeUrl({ model: 'gpt-realtime-2.1-mini' }, undefined)).toBe(`${REALTIME_WS_URL}?model=gpt-realtime-2.1-mini`);
    expect(realtimeUrl({ model: 'gpt-realtime-2.1-mini' })).toBe(`${REALTIME_WS_URL}?model=gpt-realtime-2.1-mini`);
    expect(realtimeProtocols({ apiKey: 'sk-x' })).toEqual(['realtime', 'openai-insecure-api-key.sk-x']);
  });
});

describe('a LocalAI leg', () => {
  it('opens its socket at the endpoint with no subprotocol, configures the session in the GA shape, and sends no anchor', async () => {
    const h = await live();
    expect(h.socket.url).toBe('ws://192.168.1.10:8080/v1/realtime?model=gpt-realtime');
    expect(h.socket.protocols).toEqual([]);
    const sent = h.sent();
    expect(sent.map((m) => m.type)).toEqual(['session.update']);
    expect(sent[0].session).toMatchObject({
      type: 'realtime', output_modalities: ['text'], tool_choice: 'none', tools: [],
      audio: { input: { turn_detection: { type: 'semantic_vad', eagerness: 'high', create_response: true, interrupt_response: false }, transcription: { language: 'en' }, noise_reduction: null } },
    });
    expect(sent[0].session).not.toHaveProperty('model');
    expect((sent[0].session as { audio: object }).audio).not.toHaveProperty('output');
  });

  it('never anchors, however many translations complete', async () => {
    const h = await live();
    for (let n = 1; n <= 6; n += 1) {
      h.receive(LOCALAI.committed(`in_${n}`), LOCALAI.inputDone(`in_${n}`, 'Hi.'), LOCALAI.responseCreated(`r_${n}`), LOCALAI.outputItemAdded(`r_${n}`, `out_${n}`), LOCALAI.textDone(`r_${n}`, `out_${n}`, '你好。'), LOCALAI.responseDone(`r_${n}`));
    }
    expect(h.sent().filter((m) => m.type === 'response.create')).toEqual([]);
  });

  it('turns one spoken exchange, as LocalAI frames it, into a source and its translation', async () => {
    const h = await live();
    h.receive(
      LOCALAI.committed('item_in'),
      LOCALAI.inputDelta('item_in', 'Good morning, everyone.'),
      LOCALAI.inputDone('item_in', 'Good morning, everyone.'),
      // LocalAI announces the input again under another id, its audio inside.
      LOCALAI.itemAdded('item_other', 'Good morning, everyone.'),
      LOCALAI.responseCreated('resp_1'),
      LOCALAI.outputItemAdded('resp_1', 'item_out'),
      LOCALAI.textDelta('resp_1', 'item_out', '大家早上好。'),
      LOCALAI.textDone('resp_1', 'item_out', '大家早上好。'),
      LOCALAI.outputItemDone('resp_1', 'item_out'),
      LOCALAI.responseDone('resp_1'),
    );
    const opened = h.of('segmentOpened').map((e) => e.payload);
    expect(opened).toEqual([
      { ref: 1, side: 'source', origin: 'item_in' },
      { ref: 2, side: 'translation', origin: 'item_in' },
    ]);
    const lastText = (ref: number) => h.of('segmentText').map((e) => e.payload).filter((p) => p.ref === ref).pop()?.text;
    expect(lastText(1)).toBe('Good morning, everyone.');
    expect(lastText(2)).toBe('大家早上好。');
    expect(h.of('segmentClosed').map((e) => e.payload.ref).sort()).toEqual([1, 2]);
    expect(h.of('busy').map((e) => e.payload)).toEqual([true, false]);
    expect(h.of('failed')).toEqual([]);
  });

  it('under manual turns commits the press and asks for no response: the server answers its commit', async () => {
    const h = await live(MANUAL);
    h.session.beginTurn();
    h.session.appendAudio(new Int16Array(2_400).fill(500));
    h.session.endTurn();
    expect(h.sent().map((m) => m.type)).toEqual(['session.update', 'input_audio_buffer.append', 'input_audio_buffer.commit']);
    expect((h.sent()[0].session as { audio: { input: { turn_detection: unknown } } }).audio.input.turn_detection).toBeNull();
    // LocalAI transcribes the commit under an id of its own, then answers it.
    h.receive(LOCALAI.committed('item_commit'), LOCALAI.inputDelta('item_asr', 'Hello.'), LOCALAI.inputDone('item_asr', 'Hello.'), LOCALAI.responseCreated('resp_1'), LOCALAI.outputItemAdded('resp_1', 'item_out'), LOCALAI.textDone('resp_1', 'item_out', '你好。'), LOCALAI.responseDone('resp_1'));
    expect(h.sent().filter((m) => m.type === 'response.create')).toEqual([]);
    // One source, opened by its transcript; the commit's own id opens none, which would stay open and empty.
    expect(h.of('segmentOpened').map((e) => e.payload)).toEqual([
      { ref: 1, side: 'source', origin: 'item_asr' },
      { ref: 2, side: 'translation', origin: 'item_asr' },
    ]);
    expect(h.of('segmentClosed').map((e) => e.payload.ref).sort()).toEqual([1, 2]);
  });

  it('still asks for a typed text\'s response itself', async () => {
    const h = await live();
    h.session.appendText('Good morning.');
    expect(h.sent().slice(1).map((m) => m.type)).toEqual(['conversation.item.create', 'response.create']);
  });

  it('keeps the session through a transcription the server could not make', async () => {
    const h = await live();
    h.receive(LOCALAI.committed('item_in'), LOCALAI.transcriptionFailed());
    expect(h.of('failed')).toEqual([]);
    expect(h.socket.closedByClient).toBeNull();
  });
});

describe('the LocalAI Realtime definition', () => {
  it('is registered once, last, on the desktop app alone, text only, with both turn modes', () => {
    expect(PROVIDERS.filter((p) => p.id === 'localai')).toEqual([localaiProvider]);
    expect(localaiProvider).toMatchObject({ id: 'localai', kind: 'own-key', platforms: ['electron'], speech: 'never', settings: { key: 'localai', defaults: LOCALAI_DEFAULTS } });
    expect(localaiProvider.turns(LOCALAI_DEFAULTS)).toEqual(['auto', 'manual']);
    expect(localaiProvider.textInput(LOCALAI_DEFAULTS)).toBe(true);
    const env = (platform: 'electron' | 'extension' | 'web') => ({ platform, dev: false, enabled: new Set<string>(), kizuna: false, switchOn: () => false });
    expect(isPresent(localaiProvider, env('electron'))).toBe(true);
    expect(isPresent(localaiProvider, env('extension'))).toBe(false);
    expect(isPresent(localaiProvider, env('web'))).toBe(false);
  });
});
