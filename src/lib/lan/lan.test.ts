import { describe, expect, it, vi } from 'vitest';
import { createVirtualClock } from '../contract/clock';
import { pcmToBase64 } from '../contract/pcm64';
import { createLanHost, type LanBridge, type LanModels } from './host';
import { baseLanguage, capabilityList, firewallAnswer, LAN_OWNER, LAN_PIPELINE, modelList, type SharedModel } from './protocol';
import { LanTranscriber, vadFrom, type Recognizer } from './transcriber';
import { LanTranslator, type Translator } from './translator';

const SHARED: SharedModel[] = [
  { id: 'sensevoice-int8', kind: 'asr', languages: ['zh', 'en', 'ja', 'ko', 'yue'] },
  { id: 'bing-translator', kind: 'translate', languages: [] },
];

/** A recognizer the test drives by hand. */
function fakeRecognizer() {
  let settle: { resolve(): void; reject(error: unknown): void } | null = null;
  const fake = {
    onPartialResult: null as Recognizer['onPartialResult'],
    onResult: null as Recognizer['onResult'],
    onSpeechStart: null as Recognizer['onSpeechStart'],
    onError: null as Recognizer['onError'],
    onFatal: null as Recognizer['onFatal'],
    inits: [] as Array<{ modelId: string; options: unknown }>,
    fed: [] as number[],
    flushes: 0,
    disposes: 0,
    init(modelId: string, options: unknown) {
      fake.inits.push({ modelId, options });
      return new Promise<void>((resolve, reject) => { settle = { resolve, reject }; });
    },
    feedAudio(samples: Int16Array) { fake.fed.push(samples.length); },
    flush() { fake.flushes += 1; },
    dispose() { fake.disposes += 1; },
    async loaded() { settle?.resolve(); await Promise.resolve(); await Promise.resolve(); },
    async broken(message: string) { settle?.reject(new Error(message)); await Promise.resolve(); await Promise.resolve(); },
  };
  return fake;
}

function socket(dialled = LAN_PIPELINE, resolve: (language: string, wanted: string) => { modelId: string; streaming: boolean } | null = () => ({ modelId: 'sensevoice-int8', streaming: false })) {
  const sent: Array<Record<string, unknown>> = [];
  const closed: Array<{ code: number; reason: string }> = [];
  const engines: Array<ReturnType<typeof fakeRecognizer>> = [];
  const clock = createVirtualClock(0);
  const asked: Array<[string, string]> = [];
  const t = new LanTranscriber({
    recognizer: () => { const e = fakeRecognizer(); engines.push(e); return e; },
    resolve: (language, wanted) => { asked.push([language, wanted]); return resolve(language, wanted); },
    send: (event) => sent.push(event),
    close: (code, reason) => closed.push({ code, reason }),
    clock,
  }, 'sess_1', dialled);
  const say = (event: Record<string, unknown>) => t.receive(JSON.stringify(event));
  const update = (language: string | undefined, extra: Record<string, unknown> = {}) => say({ type: 'session.update', session: { type: 'transcription', audio: { input: { transcription: { ...(language ? { language } : {}), ...extra }, turn_detection: { type: 'semantic_vad', eagerness: 'high' } } } } });
  const types = () => sent.map((e) => e.type);
  return { t, sent, closed, engines, clock, asked, say, update, types, engine: () => engines[engines.length - 1] };
}

describe('what a sharing Kotomimi says of itself', () => {
  it('lists its pipeline and its models as its own, each with what it is for', () => {
    expect(modelList(SHARED).data).toEqual([
      { id: LAN_PIPELINE, object: 'model', owned_by: LAN_OWNER },
      { id: 'sensevoice-int8', object: 'model', owned_by: LAN_OWNER },
      { id: 'bing-translator', object: 'model', owned_by: LAN_OWNER },
    ]);
    expect(capabilityList(SHARED).data).toEqual([
      { id: LAN_PIPELINE, capabilities: null },
      { id: 'sensevoice-int8', capabilities: ['transcript'], languages: ['zh', 'en', 'ja', 'ko', 'yue'] },
      { id: 'bing-translator', capabilities: ['translate'], languages: [] },
    ]);
  });

  it('reads a language as the catalog codes it', () => {
    expect(baseLanguage('zh-CN')).toBe('zh');
    expect(baseLanguage(' JA ')).toBe('ja');
    expect(baseLanguage(undefined)).toBe('');
  });

  it('turns a client\'s turn detection into this computer\'s knobs', () => {
    expect(vadFrom({ type: 'server_vad', threshold: 0.6, silence_duration_ms: 700 })).toMatchObject({ threshold: 0.6, minSilenceDuration: 0.7 });
    expect(vadFrom({ type: 'semantic_vad', eagerness: 'high' }).minSilenceDuration).toBe(0.8);
    expect(vadFrom({ type: 'semantic_vad', eagerness: 'low' }).minSilenceDuration).toBe(2);
    expect(vadFrom(null)).toMatchObject({ threshold: 0.3, minSilenceDuration: 1.4 });
  });
});

describe('what the main process says of the firewall', () => {
  it('is held to its shape, and anything else is unknown', () => {
    expect(firewallAnswer({ state: 'allowed', public: false })).toEqual({ state: 'allowed', public: false });
    expect(firewallAnswer({ state: 'blocked', public: true })).toEqual({ state: 'blocked', public: true });
    // Nothing is shut on a public network once it is allowed.
    expect(firewallAnswer({ state: 'allowed', public: true })).toEqual({ state: 'allowed', public: false });
    for (const bad of [null, undefined, 'blocked', {}, { state: 'open' }, { state: 'unknown', public: true }]) expect(firewallAnswer(bad)).toEqual({ state: 'unknown', public: false });
  });
});

describe('a Realtime socket of a sharing Kotomimi', () => {
  it('announces its session, and confirms a configuration at once while the model loads', () => {
    const s = socket();
    s.t.open();
    expect(s.sent[0]).toMatchObject({ type: 'session.created', session: { id: 'sess_1', type: 'transcription', model: LAN_PIPELINE } });
    s.update('zh-CN');
    expect(s.asked).toEqual([['zh', '']]);
    expect(s.engine().inits).toEqual([{ modelId: 'sensevoice-int8', options: { vadConfig: vadFrom({ type: 'semantic_vad', eagerness: 'high' }), language: 'zh', punctuationEndpoint: true } }]);
    expect(s.sent[1]).toMatchObject({ type: 'session.updated', session: { type: 'transcription', audio: { input: { transcription: { model: 'sensevoice-int8', language: 'zh' } } } } });
  });

  it('takes the recognizer a client names, in the configuration or in the socket\'s own model', () => {
    const named = socket();
    named.update('ja', { model: 'whisper-tiny' });
    expect(named.asked).toEqual([['ja', 'whisper-tiny']]);
    const dialled = socket('sensevoice-nano-int8');
    dialled.update('ja');
    expect(dialled.asked).toEqual([['ja', 'sensevoice-nano-int8']]);
  });

  it('refuses a configuration with no language, or with no model to hear it, in words a client can show', () => {
    const s = socket(LAN_PIPELINE, () => null);
    s.update(undefined);
    expect(s.sent[0]).toMatchObject({ type: 'error', error: { code: 'language_required' } });
    s.update('sw');
    expect(s.sent[1]).toMatchObject({ type: 'error', error: { code: 'model_not_found', message: expect.stringContaining('"sw"') } });
    expect(s.engines).toHaveLength(0);
  });

  it('holds the audio that comes while the model loads, and feeds it in order once loaded', async () => {
    const s = socket();
    s.update('zh');
    s.say({ type: 'input_audio_buffer.append', audio: pcmToBase64(new Int16Array(2400)) });
    s.say({ type: 'input_audio_buffer.append', audio: pcmToBase64(new Int16Array(1200)) });
    expect(s.engine().fed).toEqual([]);
    await s.engine().loaded();
    expect(s.engine().fed).toEqual([2400, 1200]);
    s.say({ type: 'input_audio_buffer.append', audio: pcmToBase64(new Int16Array(480)) });
    expect(s.engine().fed).toEqual([2400, 1200, 480]);
    // Not audio: dropped, and the session goes on.
    s.say({ type: 'input_audio_buffer.append', audio: '***' });
    expect(s.types()).toEqual(['session.updated']);
  });

  it('writes one utterance as the GA events: started, deltas while the text only grows, stopped, committed, completed', async () => {
    const s = socket();
    s.update('zh');
    await s.engine().loaded();
    const e = s.engine();
    e.onSpeechStart?.();
    e.onPartialResult?.('今天');
    e.onPartialResult?.('今天天气');
    // A hypothesis that rewrites itself is not a delta: the final carries the whole text.
    e.onPartialResult?.('今日天气');
    e.onResult?.({ text: ' 今日天气很好 ', durationMs: 1000, recognitionTimeMs: 50 });
    const events = s.sent.slice(1);
    expect(events.map((x) => x.type)).toEqual([
      'input_audio_buffer.speech_started',
      'conversation.item.input_audio_transcription.delta',
      'conversation.item.input_audio_transcription.delta',
      'input_audio_buffer.speech_stopped',
      'input_audio_buffer.committed',
      'conversation.item.input_audio_transcription.completed',
    ]);
    expect(events.filter((x) => x.type === 'conversation.item.input_audio_transcription.delta').map((x) => x.delta)).toEqual(['今天', '天气']);
    expect(events[5]).toMatchObject({ transcript: '今日天气很好' });
    // One item id throughout, and a new one for the next utterance.
    expect(new Set(events.map((x) => x.item_id)).size).toBe(1);
    e.onResult?.({ text: '第二句', durationMs: 500, recognitionTimeMs: 20 });
    expect(s.sent[s.sent.length - 1].item_id).not.toBe(events[0].item_id);
  });

  it('says nothing for a false start: speech detected, and nothing heard', async () => {
    const s = socket();
    s.update('zh');
    await s.engine().loaded();
    s.engine().onResult?.({ text: '  ', durationMs: 300, recognitionTimeMs: 10 });
    expect(s.types()).toEqual(['session.updated']);
  });

  it('flushes at a client\'s own commit, and drops what a cleared turn held', async () => {
    const s = socket();
    s.update('zh');
    await s.engine().loaded();
    const e = s.engine();
    s.say({ type: 'input_audio_buffer.commit' });
    expect(e.flushes).toBe(1);
    // The short silence that lets the detection go.
    expect(e.fed).toEqual([2400, 2400, 2400, 2400, 2400, 2400, 2400]);
    s.say({ type: 'input_audio_buffer.clear' });
    expect(s.types()).toContain('input_audio_buffer.cleared');
    e.onResult?.({ text: '被取消的话', durationMs: 500, recognitionTimeMs: 20 });
    expect(s.types()).not.toContain('conversation.item.input_audio_transcription.completed');
    // Later speech is heard again.
    s.clock.advance(3000);
    e.onResult?.({ text: '之后的话', durationMs: 500, recognitionTimeMs: 20 });
    expect(s.sent[s.sent.length - 1]).toMatchObject({ type: 'conversation.item.input_audio_transcription.completed', transcript: '之后的话' });
  });

  it('ends a turn committed while the model still loads once it has loaded, after the audio held for it', async () => {
    const s = socket();
    s.update('ja');
    s.say({ type: 'input_audio_buffer.append', audio: pcmToBase64(new Int16Array(4800)) });
    s.say({ type: 'input_audio_buffer.commit' });
    expect(s.engine().flushes).toBe(0);
    await s.engine().loaded();
    // The speech first, then the silence that ends it, then the flush.
    expect(s.engine().fed).toEqual([4800, 2400, 2400, 2400, 2400, 2400, 2400, 2400]);
    expect(s.engine().flushes).toBe(1);
  });

  it('answers a request for a response by saying where translations are asked for', () => {
    const s = socket();
    s.say({ type: 'response.create' });
    expect(s.sent[0]).toMatchObject({ type: 'error', error: { code: 'transcription_only', message: expect.stringContaining('/v1/chat/completions') } });
  });

  it('fails one utterance and goes on; ends the socket when the model cannot load or dies', async () => {
    const s = socket();
    s.update('zh');
    await s.engine().loaded();
    s.engine().onSpeechStart?.();
    s.engine().onError?.('decode failed');
    expect(s.sent[s.sent.length - 1]).toMatchObject({ type: 'conversation.item.input_audio_transcription.failed' });
    expect(s.closed).toEqual([]);
    s.engine().onFatal?.('worker crashed');
    expect(s.closed).toEqual([{ code: 1011, reason: 'speech recognition stopped' }]);
    expect(s.engine().disposes).toBe(1);

    const other = socket();
    other.update('zh');
    await other.engine().broken('files missing');
    expect(other.sent[other.sent.length - 1]).toMatchObject({ type: 'error', error: { message: expect.stringContaining('files missing') } });
    expect(other.closed).toEqual([{ code: 1011, reason: 'the model could not load' }]);
  });

  it('starts nothing again for the same configuration, and a new model for another language', async () => {
    const s = socket();
    s.update('zh');
    s.update('zh');
    expect(s.engines).toHaveLength(1);
    s.update('ja');
    expect(s.engines).toHaveLength(2);
    expect(s.engines[0].disposes).toBe(1);
    // The first model, loading still, is let go when it lands.
    await s.engines[0].loaded();
    expect(s.engines[0].disposes).toBe(2);
  });

  it('lets its model go when the socket closes, and says nothing after', async () => {
    const s = socket();
    s.update('zh');
    await s.engine().loaded();
    s.t.dispose();
    expect(s.engine().disposes).toBe(1);
    const before = s.sent.length;
    s.engine().onResult?.({ text: '迟到的话', durationMs: 1, recognitionTimeMs: 1 });
    s.update('zh');
    expect(s.sent.length).toBe(before);
  });
});

/** A translation engine the test drives. */
function fakeTranslator(answer: (text: string) => string | Error = (text) => `[${text}]`) {
  const fake = {
    onError: null as Translator['onError'],
    inits: [] as Array<[string, string, string | undefined]>,
    calls: [] as Array<{ text: string; system: string; wrap: boolean }>,
    disposes: 0,
    failInit: null as Error | null,
    async init(source: string, target: string, model?: string) { fake.inits.push([source, target, model]); if (fake.failInit) throw fake.failInit; },
    async translate(text: string, system: string, wrap: boolean) {
      fake.calls.push({ text, system, wrap });
      const out = answer(text);
      if (out instanceof Error) throw out;
      return { translatedText: out };
    },
    dispose() { fake.disposes += 1; },
  };
  return fake;
}

function translator(resolve: (source: string, target: string, wanted: string) => string | null = () => 'bing-translator') {
  const made: Array<ReturnType<typeof fakeTranslator>> = [];
  const clock = createVirtualClock(1_700_000_000_000);
  const next: { fail?: Error } = {};
  const t = new LanTranslator({
    translator: () => { const f = fakeTranslator(); if (next.fail) f.failInit = next.fail; made.push(f); return f; },
    resolve,
    clock,
  });
  const ask = (patch: Record<string, unknown> = {}) => t.complete({ model: LAN_PIPELINE, source_language: 'zh-CN', target_language: 'ja', messages: [{ role: 'system', content: 'ignored' }, { role: 'user', content: ' 你好 ' }], ...patch });
  return { t, made, clock, ask, next };
}

describe('a sharing Kotomimi\'s translations', () => {
  it('translates the last user message for the pair named, with the model\'s own prompt, in OpenAI\'s shape', async () => {
    const x = translator();
    const answer = await x.ask();
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ object: 'chat.completion', model: 'bing-translator', choices: [{ index: 0, message: { role: 'assistant', content: '[你好]' }, finish_reason: 'stop' }] });
    expect(x.made[0].inits).toEqual([['zh', 'ja', 'bing-translator']]);
    expect(x.made[0].calls[0]).toMatchObject({ text: '你好', wrap: true });
    expect(x.made[0].calls[0].system).toContain('Chinese');
    expect(x.made[0].calls[0].system).not.toContain('ignored');
  });

  it('answers a client that asked for a stream with one', async () => {
    const answer = await translator().ask({ stream: true });
    expect(answer.contentType).toBe('text/event-stream');
    const lines = String(answer.body).split('\n\n').filter(Boolean);
    expect(JSON.parse(lines[0].slice(6)).choices[0].delta).toEqual({ role: 'assistant', content: '[你好]' });
    expect(lines[lines.length - 1]).toBe('data: [DONE]');
  });

  it('reads a message whose content is a list of parts', async () => {
    const answer = await translator().ask({ messages: [{ role: 'user', content: [{ type: 'text', text: '早' }, { type: 'text', text: '上好' }] }] });
    expect((answer.body as { choices: Array<{ message: { content: string } }> }).choices[0].message.content).toBe('[早上好]');
  });

  it('keeps a model loaded for its pair, and loads another for another pair', async () => {
    const x = translator();
    await x.ask();
    await x.ask();
    expect(x.made).toHaveLength(1);
    await x.ask({ source_language: 'ja', target_language: 'zh' });
    expect(x.made).toHaveLength(2);
    expect(x.made[1].inits).toEqual([['ja', 'zh', 'bing-translator']]);
  });

  it('lets the least recently used model go when more than a few are loaded', async () => {
    const x = translator();
    for (const target of ['ja', 'en', 'ko', 'fr']) { x.clock.advance(10); await x.ask({ target_language: target }); }
    expect(x.made.map((m) => m.disposes)).toEqual([1, 0, 0, 0]);
  });

  it('asks the named model of the catalog, and the pipeline\'s name for the best', async () => {
    const asked: string[] = [];
    const x = translator((_s, _t, wanted) => { asked.push(wanted); return wanted || 'bing-translator'; });
    await x.ask();
    await x.ask({ model: 'hy-mt15-1.8b-translation' });
    expect(asked).toEqual(['', 'hy-mt15-1.8b-translation']);
  });

  it('refuses, in words, a request with no pair, no text, or no model for the pair', async () => {
    const x = translator(() => null);
    expect(await x.ask({ source_language: undefined })).toMatchObject({ status: 400, body: { error: { code: 'languages_required' } } });
    expect(await x.ask({ messages: [{ role: 'system', content: 'x' }] })).toMatchObject({ status: 400, body: { error: { code: 'no_text' } } });
    expect(await x.ask()).toMatchObject({ status: 404, body: { error: { code: 'model_not_found' } } });
  });

  it('answers a failure as a server error, and loads afresh after a model that could not load', async () => {
    const x = translator();
    x.next.fail = new Error('out of memory');
    expect(await x.ask()).toMatchObject({ status: 500, body: { error: { message: expect.stringContaining('out of memory') } } });
    x.next.fail = undefined;
    expect((await x.ask()).status).toBe(200);
    expect(x.made).toHaveLength(2);
    x.t.dispose();
    expect(x.made[1].disposes).toBe(1);
  });
});

/** The main process's door, as a recorder: what the page called, and a way to deliver what the door would. */
function bridge(start: unknown = { ok: true, port: 8790, addresses: ['192.168.1.20'] }) {
  const calls: Array<{ channel: string; data: unknown }> = [];
  const listeners = new Map<string, (payload: never) => void>();
  const b: LanBridge = {
    invoke: async (channel, data) => { calls.push({ channel, data }); return channel === 'lan:start' ? start : true; },
    on: (channel, listener) => { listeners.set(channel, listener); return () => listeners.delete(channel); },
  };
  const deliver = (channel: string, payload: unknown) => (listeners.get(channel) as ((p: unknown) => void) | undefined)?.(payload);
  return { b, calls, listeners, deliver, of: (channel: string) => calls.filter((c) => c.channel === channel).map((c) => c.data as Record<string, unknown>) };
}

const MODELS: LanModels = {
  shared: () => SHARED,
  recognizer: () => ({ modelId: 'sensevoice-int8', streaming: false }),
  translator: () => 'bing-translator',
};

function host(start?: unknown) {
  const door = bridge(start);
  const recognizers: Array<ReturnType<typeof fakeRecognizer>> = [];
  const translators: Array<ReturnType<typeof fakeTranslator>> = [];
  const clients = vi.fn();
  const h = createLanHost({
    bridge: door.b,
    models: MODELS,
    engines: { recognizer: () => { const r = fakeRecognizer(); recognizers.push(r); return r; }, translator: () => { const t = fakeTranslator(); translators.push(t); return t; } },
    clock: createVirtualClock(0),
    onClients: clients,
  });
  return { h, door, recognizers, translators, clients };
}

describe('the sharing host', () => {
  it('starts the door with the port and the key, and answers the model lists itself', async () => {
    const x = host();
    expect(await x.h.start({ port: 8790, key: 'k' })).toEqual({ ok: true, port: 8790, addresses: ['192.168.1.20'] });
    expect(x.door.of('lan:start')).toEqual([{ port: 8790, key: 'k' }]);
    x.door.deliver('lan:request', { id: 'r1', method: 'GET', path: '/v1/models', body: null });
    x.door.deliver('lan:request', { id: 'r2', method: 'GET', path: '/v1/models/capabilities', body: null });
    await vi.waitFor(() => expect(x.door.of('lan:reply')).toHaveLength(2));
    expect(x.door.of('lan:reply')[0]).toMatchObject({ id: 'r1', status: 200, body: modelList(SHARED) });
    expect(x.door.of('lan:reply')[1]).toMatchObject({ id: 'r2', status: 200, body: capabilityList(SHARED) });
  });

  it('answers a chat request with a translation', async () => {
    const x = host();
    await x.h.start({ port: 8790, key: '' });
    x.door.deliver('lan:request', { id: 'r1', method: 'POST', path: '/v1/chat/completions', body: { model: LAN_PIPELINE, source_language: 'zh', target_language: 'ja', messages: [{ role: 'user', content: '你好' }] } });
    await vi.waitFor(() => expect(x.door.of('lan:reply')).toHaveLength(1));
    expect(x.door.of('lan:reply')[0]).toMatchObject({ id: 'r1', status: 200, body: { choices: [{ message: { content: '[你好]' } }] } });
  });

  it('gives each socket its own transcriber, counts them, and lets one go when its socket closes', async () => {
    const x = host();
    await x.h.start({ port: 8790, key: '' });
    x.door.deliver('lan:socket-open', { id: 's1', model: LAN_PIPELINE });
    x.door.deliver('lan:socket-open', { id: 's2', model: LAN_PIPELINE });
    expect(x.clients.mock.calls.map((c) => c[0]).slice(-2)).toEqual([1, 2]);
    expect(x.door.of('lan:send').map((c) => [c.id, JSON.parse(c.data as string).type])).toEqual([['s1', 'session.created'], ['s2', 'session.created']]);
    x.door.deliver('lan:socket-message', { id: 's1', data: JSON.stringify({ type: 'session.update', session: { audio: { input: { transcription: { language: 'ja' } } } } }) });
    expect(x.recognizers).toHaveLength(1);
    expect(JSON.parse(x.door.of('lan:send')[2].data as string)).toMatchObject({ type: 'session.updated' });
    x.door.deliver('lan:socket-close', { id: 's1' });
    expect(x.recognizers[0].disposes).toBe(1);
    expect(x.clients.mock.calls.pop()?.[0]).toBe(1);
  });

  it('lets everything go when it stops, and hears the door no more', async () => {
    const x = host();
    await x.h.start({ port: 8790, key: '' });
    x.door.deliver('lan:socket-open', { id: 's1', model: LAN_PIPELINE });
    x.door.deliver('lan:socket-message', { id: 's1', data: JSON.stringify({ type: 'session.update', session: { audio: { input: { transcription: { language: 'ja' } } } } }) });
    await x.h.stop();
    expect(x.recognizers[0].disposes).toBe(1);
    expect(x.door.of('lan:stop')).toHaveLength(1);
    expect(x.door.listeners.size).toBe(0);
    expect(x.clients.mock.calls.pop()?.[0]).toBe(0);
  });

  it('reports a door that could not open, and listens to nothing', async () => {
    const x = host({ ok: false, code: 'EADDRINUSE', message: 'listen EADDRINUSE' });
    expect(await x.h.start({ port: 8790, key: '' })).toEqual({ ok: false, code: 'EADDRINUSE', message: 'listen EADDRINUSE' });
    expect(x.door.listeners.size).toBe(0);
  });
});
