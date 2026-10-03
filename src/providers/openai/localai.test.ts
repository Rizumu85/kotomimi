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
    expect(localaiCredentials.keys).toEqual(['endpoint', 'translateKey', 'coachKey']);
    expect(localaiCredentials.fields(LOCALAI_DEFAULTS).map((f) => [f.key, f.secret])).toEqual([['endpoint', false]]);
    expect(localaiCredentials.read({ endpoint: 'http://192.168.1.10:8080' }, noAuth)).toEqual(K);
    expect(localaiCredentials.read({ endpoint: '' }, noAuth)).toHaveProperty('missing');
    expect(localaiCredentials.read({}, noAuth)).toHaveProperty('missing');
  });
});

describe("LocalAI Realtime's stage keys", () => {
  const fields = (patch: Partial<LocalAISettings>) => localaiCredentials.fields({ ...LOCALAI_DEFAULTS, ...patch }).map((f) => [f.key, f.secret]);

  it('asks for a text model\'s key only when that model is in use and its server wants one', () => {
    expect(fields({ translateVia: 'model', translateModel: 'm', translateNeedsKey: true })).toEqual([['endpoint', false], ['translateKey', true]]);
    // Named but not in use: the server's pipeline translates, and no one is coached.
    expect(fields({ translateModel: 'm', translateNeedsKey: true })).toEqual([['endpoint', false]]);
    expect(fields({ coach: true, translateModel: 'm', translateNeedsKey: true })).toEqual([['endpoint', false], ['translateKey', true]]);
    expect(fields({ coach: true, coachModel: 'c', coachNeedsKey: true })).toEqual([['endpoint', false], ['coachKey', true]]);
    expect(fields({ coachModel: 'c', coachNeedsKey: true })).toEqual([['endpoint', false]]);
  });

  it('reads the keys shown, and is missing while one is blank', () => {
    expect(localaiCredentials.read({ endpoint: '192.168.1.10:8080', translateKey: ' sk-a ', coachKey: 'sk-b' }, noAuth)).toEqual({ ...K, translateKey: 'sk-a', coachKey: 'sk-b' });
    expect(localaiCredentials.read({ endpoint: '192.168.1.10:8080', translateKey: '' }, noAuth)).toHaveProperty('missing');
    expect(localaiCredentials.read({ endpoint: '192.168.1.10:8080', coachKey: ' ' }, noAuth)).toHaveProperty('missing');
  });

  it('declares every setting that decides a field or an endpoint the check reaches', () => {
    expect(localaiProvider.checkReads).toEqual(['translateVia', 'translateBaseUrl', 'translateModel', 'translateNeedsKey', 'coach', 'coachBaseUrl', 'coachModel', 'coachNeedsKey']);
  });
});

describe("LocalAI Realtime's check", () => {
  const check = (fetch: typeof globalThis.fetch) => createLocalAICheck({ fetch, clock: createVirtualClock(0) })(K, LOCALAI_DEFAULTS, ctx());

  it('GETs the server\'s own model list, with no Authorization header', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json({ object: 'list', data: [{ id: 'gpt-realtime', object: 'model' }] }));
    await check(fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe('http://192.168.1.10:8080/v1/models');
    expect(fetch.mock.calls[0][1]?.headers).toBeUndefined();
  });

  it('answers ready with every model the server lists, in its order, each id once', async () => {
    const data = ['apple-speech-transcriber', 'hy-mt2-1.8b', 'gpt-realtime', 'gpt-realtime', 'silero-vad-ggml'].map((id) => ({ id, object: 'model' }));
    expect(await check(async () => json({ object: 'list', data }))).toEqual({ ok: true, models: [{ id: 'apple-speech-transcriber' }, { id: 'hy-mt2-1.8b' }, { id: 'gpt-realtime' }, { id: 'silero-vad-ggml' }] });
  });

  it('answers not ready when the server lists nothing', async () => {
    expect(await check(async () => json({ object: 'list', data: [] }))).toMatchObject({ ok: false });
  });

  it('also reaches every other server a stage names, with its key: a 401 or 403 is a refusal, a server that cannot be reached throws', async () => {
    const s = { ...LOCALAI_DEFAULTS, translateVia: 'model' as const, translateModel: 'gpt-4.1-mini', translateBaseUrl: 'https://api.example.com/v1/', translateNeedsKey: true };
    const k = { ...K, translateKey: 'sk-a' };
    const list = () => json({ object: 'list', data: [{ id: 'gpt-realtime' }] });
    const run = (other: () => Promise<Response>) => {
      const fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => (String(input).startsWith('http://192.168.1.10') ? list() : other()));
      return { fetch, result: createLocalAICheck({ fetch, clock: createVirtualClock(0) })(k, s, ctx()) };
    };
    const ok = run(async () => json({ data: [] }));
    expect(await ok.result).toMatchObject({ ok: true });
    expect(ok.fetch.mock.calls[1][0]).toBe('https://api.example.com/v1/models');
    expect((ok.fetch.mock.calls[1][1]?.headers as Record<string, string>).Authorization).toBe('Bearer sk-a');
    expect(await run(async () => json({}, 401)).result).toMatchObject({ ok: false, code: 'auth' });
    // Not every API lists its models: any other answer passes.
    expect(await run(async () => json({}, 404)).result).toMatchObject({ ok: true });
    await expect(run(async () => { throw new TypeError('Failed to fetch'); }).result).rejects.toThrow(/translation model's server \(https:\/\/api\.example\.com\/v1\) could not be reached/);
  });

  it('reaches no other server while the stages are the Realtime server\'s own', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json({ object: 'list', data: [{ id: 'gpt-realtime' }] }));
    await createLocalAICheck({ fetch, clock: createVirtualClock(0) })(K, { ...LOCALAI_DEFAULTS, translateVia: 'model', translateModel: 'hy-mt2-1.8b' }, ctx());
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('throws on an HTTP error or a failed fetch: it could not find out', async () => {
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
    expect(buildLocalAI(AUTO, { ...LOCALAI_DEFAULTS, model: '' }, { ...SHARED, models: [] })).toMatchObject({ code: 'models_required' });
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
    // OpenAI Realtime's own transcript model, inherited in `S`, is not read.
    expect(configFor(AUTO, { transcriptModel: 'gpt-4o-transcribe' }).transcription).toEqual({ language: 'en' });
  });

  it('keeps a stored transcription model and defaults a missing one', () => {
    const inputs = { legacy: {}, credentials: {} };
    expect(migrateLocalAISettings({ ...LOCALAI_DEFAULTS, asrModel: 'sensevoice-small-mlx' }, inputs).asrModel).toBe('sensevoice-small-mlx');
    expect(migrateLocalAISettings({ ...LOCALAI_DEFAULTS, asrModel: 7 }, inputs).asrModel).toBe('');
    expect(migrateLocalAISettings({ ...LOCALAI_DEFAULTS }, inputs)).toMatchObject({ model: 'gpt-realtime', turnDetectionMode: 'Semantic', semanticEagerness: 'High' });
    // The stages: stored values kept, anything of the wrong type back to the server's own.
    expect(migrateLocalAISettings({ ...LOCALAI_DEFAULTS, translateVia: 'model', translateModel: 'm', translateNeedsKey: true, coach: true, coachBaseUrl: 'http://x/v1' }, inputs))
      .toMatchObject({ translateVia: 'model', translateModel: 'm', translateNeedsKey: true, coach: true, coachBaseUrl: 'http://x/v1' });
    expect(migrateLocalAISettings({ ...LOCALAI_DEFAULTS, translateVia: 'cloud', translateModel: 3, coach: 'yes' }, inputs)).toMatchObject({ translateVia: 'server', translateModel: '', coach: false });
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
