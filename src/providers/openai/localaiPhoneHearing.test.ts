/**
 * Fork: a phone or an iPad lent to hear (the phone door): what it lists of its recognizers and their languages, what a
 * side may then add, and a run refused at the start (or at a switch) where the device does not hear a language asked.
 */
import { describe, expect, it, vi } from 'vitest';
import { recordEvents } from '../../lib/contract/events';
import { createVirtualClock } from '../../lib/contract/clock';
import type { NativeBridge, NativeStreamEvent } from '../../lib/native/nativeEngine';
import { createPipelineAdapter } from './pipeline';
import type { CheckContext } from '../../lib/provider/types';
import { buildLocalAI, createLocalAICheck, LOCALAI_DEFAULTS, localaiLanguages, type LocalAISettings } from './localai';
import { SHARED } from './testing';
import type { LocalAIModel } from './localaiModels';

const ADDRESS = '192.168.4.28:8792';
const BASE = `http://${ADDRESS}/v1`;
/** Hearing on the device, as the settings past the cards read it (`settled`); translation by an API. */
const ON_DEVICE = (model: string, patch: Partial<LocalAISettings> = {}): LocalAISettings => ({
  ...LOCALAI_DEFAULTS,
  asrVia: 'api', asrApiBaseUrl: BASE, asrApiModel: model, asrApiNeedsKey: false, asrOther: ADDRESS, asrOtherModel: model,
  translateAt: 'api', translateModel: 'gpt-x', translateBaseUrl: 'https://api.example.com/v1', translateNeedsKey: false,
  ...patch,
});
/** The iPad's model list: what it lends unasked, and every recognizer it may be asked for, Apple Speech with its languages. */
const IPAD = (languages: string[]) => ({
  object: 'list',
  data: [{ id: 'apple-speech', object: 'model', owned_by: 'kotomimi-phone' }],
  hear: [{ id: 'apple-speech', name: 'Apple Speech', streams: true, languages }, { id: 'qwen3-asr-0.6b-q8', name: 'Qwen3-ASR 0.6B' }],
});
/** The Android app's: the one it lends, by this app's own name. */
const ANDROID = (id: string) => ({ object: 'list', data: [{ id, object: 'model', owned_by: 'kotomimi-phone' }] });

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const answering = (device: unknown) => (async (input: RequestInfo | URL) => (String(input).startsWith(BASE) ? json(device) : json({ data: [{ id: 'gpt-x' }] }))) as typeof fetch;
const ctx = (pair: { source: string; target: string }, legs: CheckContext['legs'] = ['speaker', 'participant']): CheckContext => ({ pair, legs, signal: new AbortController().signal });
const check = (device: unknown, s: LocalAISettings, pair: { source: string; target: string }) => createLocalAICheck({ fetch: answering(device) })({ apiKey: '', endpoint: '' }, s, ctx(pair));
/** The models the check listed, for the settings to read. */
const listedBy = async (device: unknown, s: LocalAISettings, pair: { source: string; target: string }) => ((await check(device, s, pair)) as { models?: LocalAIModel[] }).models ?? [];

describe('a phone or an iPad lent to hear', () => {
  it('offers the languages the iPad lists for Apple Speech', async () => {
    const pair = { source: 'zh-CN', target: 'ja' };
    const s = ON_DEVICE('apple-speech');
    const has = await listedBy(IPAD(['zh', 'ja']), s, pair);
    expect(has.find((m) => m.id === 'apple-speech')).toMatchObject({ kind: 'asr', languages: ['zh', 'ja'] });
    // A recognizer it may be asked for by name, though it lends another unasked.
    expect(has.some((m) => m.id === 'qwen3-asr-0.6b-q8')).toBe(true);
    expect(localaiLanguages.more!(s as never, has, pair).mine).toMatchObject({ hearer: { name: 'Apple Speech', languages: ['zh', 'ja'] }, offered: ['zh', 'ja'], most: 1 });

    const lacks = await listedBy(IPAD(['zh', 'en']), s, pair);
    expect(localaiLanguages.more!(s as never, lacks, pair).mine).toMatchObject({ offered: ['zh', 'en'], most: 1 });
  });

  it('keeps the second extra quiet and routes only speech the iPad hears', async () => {
    const pair = { source: 'zh-CN', target: 'ja' };
    const s = ON_DEVICE('apple-speech', { speakAlso: ['en', 'ja'], theyAlso: ['en'], theyLit: 'en', asrDetectOther: true });
    const models = await listedBy(IPAD(['zh', 'ja', 'en']), s, pair);
    expect(localaiLanguages.more!(s, models, pair).mine).toMatchObject({
      chosen: ['en', 'ja'], using: ['ja'], quiet: { codes: ['en'], by: 'Apple Speech' },
    });
    const built = buildLocalAI({ direction: pair, speech: false, turns: 'auto' }, s, { ...SHARED, models, reversed: () => false });
    expect(built).toMatchObject({ device: { pairedWith: ['ja'] }, stages: { back: { languages: ['ja'] }, cross: [{ language: 'ja' }], requiresLanguage: true } });
  });

  it('leaves a language Apple Speech has not at all unused, and refuses nothing for it', async () => {
    const pair = { source: 'zh-CN', target: 'ru' };
    const s = ON_DEVICE('apple-speech', { speakAlso: ['ru'] });
    const models = await listedBy(IPAD(['zh', 'ja']), s, pair);
    expect(localaiLanguages.more!(s, models, { source: 'zh-CN', target: 'ru' }).mine).toMatchObject({ using: [], quiet: { codes: ['ru'], by: 'Apple Speech' } });
    const built = buildLocalAI({ direction: pair, speech: false, turns: 'auto' }, s, { ...SHARED, models, reversed: () => false });
    if ('refused' in built) throw new Error(built.refused);
    expect(built.stages?.heard).not.toBe('auto');
    expect(built.stages?.back).toBeUndefined();
  });

  it('hears a stored open participant leg as told when the optional language is absent', async () => {
    const pair = { source: 'en', target: 'ja' };
    const s = ON_DEVICE('apple-speech', { asrDetectOther: true });
    const models = await listedBy(IPAD(['ja']), s, pair);
    const built = buildLocalAI({ direction: { source: 'ja', target: 'en' }, speech: false, turns: 'auto' }, s, { ...SHARED, models, reversed: () => true });
    if ('refused' in built) throw new Error(built.refused);
    expect(built.stages?.heard).not.toBe('auto');
    expect(built.stages?.named).toBe('recognizer');
    expect(built.device?.language).toBeUndefined();
  });

  it('translates an unlabelled final in the told language on a non-streaming Apple door', async () => {
    const pair = { source: 'en', target: 'ja' };
    const context = { direction: pair, speech: false, turns: 'auto' as const };
    const s = ON_DEVICE('apple-speech', { speakBoth: true });
    const models = await listedBy(IPAD(['en', 'ja']), s, pair);
    const config = buildLocalAI(context, s, { ...SHARED, models, reversed: () => false });
    if ('refused' in config) throw new Error(config.refused);
    let vad: (type: string) => void;
    vi.stubGlobal('Worker', class {
      onmessage!: (event: { data: { type: string } }) => void;
      constructor() { vad = (type) => this.onmessage({ data: { type } }); }
      postMessage(message: { type: string }) { if (message.type === 'init') vad('ready'); }
      terminate() {}
    });
    const text = '明日は何を食べますか。';
    let read: (event: NativeStreamEvent) => void;
    const open = vi.fn<NativeBridge['open']>(async () => 1);
    const bridge: NativeBridge = { open, write() {}, end: (id) => read({ id, type: 'done', text }), abort() {},
      listen(listener) { read = listener; return () => {}; } };
    const { events, log } = recordEvents();
    const translate = vi.fn(async () => json({ choices: [{ message: { content: 'Translation' } }] }));
    try {
      const adapter = createPipelineAdapter({ remote: { node: async () => ({ model: 'apple-speech' }), bridge: () => bridge }, fetch: translate });
      const session = await adapter.start({ context, config, credentials: { apiKey: '', endpoint: '' }, signal: new AbortController().signal, clock: createVirtualClock() }, events);
      try {
        session.appendAudio(new Int16Array(24000));
        vad!('speech_start');
        await vi.waitFor(() => expect(open).toHaveBeenCalled());
        expect(open.mock.calls[0][0]).not.toHaveProperty('also');
        vad!('speech_end');
        await vi.waitFor(() => expect(translate).toHaveBeenCalled());
        expect(log).toContainEqual(expect.objectContaining({ kind: 'segmentText', payload: expect.objectContaining({ text, language: 'en' }) }));
      } finally {
        await session.stop();
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('refuses a run asking the iPad for a language it has not downloaded: the main one, or the one the user also speaks', async () => {
    const pair = { source: 'zh-CN', target: 'ja' };
    expect(await check(IPAD(['zh', 'ja']), ON_DEVICE('apple-speech', { speakAlso: ['ja'] }), pair)).toMatchObject({ ok: true });
    expect(await check(IPAD(['zh']), ON_DEVICE('apple-speech', { speakAlso: ['ja'] }), pair)).toMatchObject({
      ok: false, code: 'phone_no_language', params: { address: ADDRESS, name: 'Apple Speech', source: 'ja' },
    });
    const s = ON_DEVICE('apple-speech', { speakAlso: ['ja'] });
    const models = await listedBy(IPAD(['zh']), s, pair);
    expect(buildLocalAI({ direction: pair, speech: false, turns: 'auto' }, s, { ...SHARED, models, reversed: () => false })).toMatchObject({
      code: 'phone_no_language', params: { source: 'ja' },
    });
    expect(await check(IPAD([]), s, pair)).toMatchObject({ ok: false, code: 'phone_no_language', params: { source: 'zh-CN' } });
    // The other side in a language the iPad has not.
    expect(await check(IPAD(['zh', 'en']), ON_DEVICE('apple-speech'), pair)).toMatchObject({ ok: false, code: 'phone_no_language', params: { source: 'ja' } });
    expect(await check(IPAD(['en', 'ja']), ON_DEVICE('apple-speech'), pair)).toMatchObject({ ok: false, code: 'phone_no_language', params: { source: 'zh-CN' } });
  });

  it('asks the iPad for both of the other side’s languages while two are lit', async () => {
    const pair = { source: 'zh-CN', target: 'ja' };
    const lit = ON_DEVICE('apple-speech', { theyAlso: ['en'], theyLit: 'en', asrDetectOther: true });
    expect(await check(IPAD(['zh', 'ja']), lit, pair)).toMatchObject({ ok: false, code: 'phone_no_language', params: { source: 'en' } });
    expect(await check(IPAD(['zh', 'ja', 'en']), lit, pair)).toMatchObject({ ok: true });
  });

  it('refuses a language SenseVoice on the Android phone does not hear, and none Qwen3-ASR does', async () => {
    expect(await check(ANDROID('sensevoice-small-q8'), ON_DEVICE('sensevoice-small-q8'), { source: 'zh-CN', target: 'ja' })).toMatchObject({ ok: true });
    expect(await check(ANDROID('sensevoice-small-q8'), ON_DEVICE('sensevoice-small-q8'), { source: 'zh-CN', target: 'fr' })).toMatchObject({
      ok: false, code: 'phone_no_language', params: { name: 'SenseVoice-Small', source: 'fr' },
    });
    expect(await check(ANDROID('qwen3-asr-1.7b-q8'), ON_DEVICE('qwen3-asr-1.7b-q8'), { source: 'zh-CN', target: 'fr' })).toMatchObject({ ok: true });
  });

  it('leaves a recognizer whose languages are not known to answer for itself', async () => {
    expect(await check(ANDROID('some-other-asr'), ON_DEVICE('some-other-asr'), { source: 'zh-CN', target: 'fr' })).toMatchObject({ ok: true });
  });
});
