// Fork: on this computer, translation can be the native translation engine's — llama.cpp's server, downloaded and run by the app.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionContext } from '../../lib/contract/adapter';
import { createVirtualClock } from '../../lib/contract/clock';
import { NO_NATIVE_ENGINE, type NativeEngineStatus } from '../../lib/native/nativeEngine';
import type { CheckContext, CheckResult } from '../../lib/provider/types';
import { useModelStore } from '../../stores/modelStore';
import { useNativeTranslatorStore } from '../../stores/nativeEngineStore';
import { admitLocalAI, buildLocalAI, checkLocalAIWithNative, localaiProvider, LOCALAI_DEFAULTS, migrateLocalAISettings, type LocalAICredentials, type LocalAISettings } from './localai';
import { deviceChoices, deviceNeeds, translatesNatively } from './localaiDevice';
import type { LocalAIModel } from './localaiModels';
import { translatorBaseUrl, translatorGap } from './localaiNative';
import { BEFORE_SLOT, NATIVE_DEFAULT_TRANSLATOR, NATIVE_TRANSLATORS, nativeTranslates, nativeTranslator, TEXT_SLOT, translatorRequest } from './nativeTranslators';
import { SHARED } from './testing';
import { completeText } from './textModel';

const SPEAKER: SessionContext = { direction: { source: 'ja', target: 'zh-CN' }, speech: false, turns: 'auto' };
const PAIR = { source: 'ja', target: 'zh-CN' };
const CTX: CheckContext = { pair: PAIR, legs: ['speaker', 'participant'] };
const shared = { ...SHARED, reversed: (d: SessionContext['direction']) => d.source !== 'ja', models: [] as LocalAIModel[] };
const settings = (patch: Partial<LocalAISettings> = {}): LocalAISettings => ({ ...LOCALAI_DEFAULTS, ...patch });
const NONE: LocalAICredentials = { apiKey: '', endpoint: '' };
const NATIVE: Partial<LocalAISettings> = { asrVia: 'api', asrApiBaseUrl: 'https://api.example.com/v1', asrApiModel: 'whisper', asrApiNeedsKey: false, translateAt: 'device', translateHere: 'native' };

const engine = (patch: Partial<NativeEngineStatus> = {}): NativeEngineStatus => ({
  supported: true,
  engine: 'ready',
  engineBytes: 33_000_000,
  models: { 'index-translate-2b': { state: 'downloaded', received: 1312164352, total: 1312164352 }, 'hy-mt2-1.8b': { state: 'absent', received: 0, total: 1133080448 } },
  run: { state: 'stopped', model: null, port: 0, tail: '' },
  up: [],
  ...patch,
});
const READY = engine({ run: { state: 'ready', model: 'index-translate-2b', port: 4200, tail: '' } });

beforeEach(() => {
  useModelStore.setState({ initialized: true, webgpuAvailable: true, deviceFeatures: [], modelStatuses: {} });
  useNativeTranslatorStore.setState({ status: NO_NATIVE_ENGINE, asked: false });
});

describe('the words each translation model is asked with', () => {
  it('asks Index-Translate in its own form: the languages by their Chinese names, the sentence after a blank line, greedy, thinking off', () => {
    const request = translatorRequest(nativeTranslator('index-translate-2b'), 'ja', 'zh-CN');
    expect(request.wrap).toBe(`请将以下日语文本翻译为中文，直接输出翻译结果，不要进行任何解释。\n\n${TEXT_SLOT}`);
    expect(request.extra).toEqual({ temperature: 0, max_tokens: 512, chat_template_kwargs: { enable_thinking: false } });
    expect(translatorRequest(nativeTranslator('index-translate-2b'), 'zh-CN', 'ja').wrap).toContain('请将以下中文文本翻译为日语，');
    expect(translatorRequest(nativeTranslator('index-translate-2b'), 'en', 'zh-TW').wrap).toContain('请将以下英语文本翻译为繁体中文，');
  });

  it('leaves the source language out for Index-Translate when it is to be detected', () => {
    expect(translatorRequest(nativeTranslator('index-translate-2b'), 'auto', 'zh-CN').wrap).toBe(`请将以下文本翻译为中文，直接输出翻译结果，不要进行任何解释。\n\n${TEXT_SLOT}`);
  });

  it('asks Hunyuan MT in Chinese when either side is Chinese, in English otherwise, with its makers\' sampling', () => {
    const toChinese = translatorRequest(nativeTranslator('hy-mt2-1.8b'), 'ja', 'zh-CN');
    expect(toChinese.wrap).toBe(`将以下文本翻译为中文，注意只需要输出翻译后的结果，不要额外解释：\n\n${TEXT_SLOT}`);
    expect(toChinese.extra).toEqual({ temperature: 0.7, top_p: 0.6, top_k: 20, repeat_penalty: 1.05, max_tokens: 512 });
    expect(translatorRequest(nativeTranslator('hy-mt1.5-1.8b'), 'zh-CN', 'ja').wrap).toContain('将以下文本翻译为日语，');
    expect(translatorRequest(nativeTranslator('hy-mt2-1.8b'), 'ja', 'en').wrap).toBe(`Translate the following segment into English, without additional explanation.\n\n${TEXT_SLOT}`);
  });

  it('knows which pairs a model translates: any for Index-Translate, its card\'s list for Hunyuan MT', () => {
    expect(nativeTranslates(nativeTranslator('index-translate-2b'), 'sw', 'is')).toBe(true);
    expect(nativeTranslates(nativeTranslator('hy-mt2-1.8b'), 'ja', 'zh-CN')).toBe(true);
    expect(nativeTranslates(nativeTranslator('hy-mt2-1.8b'), 'auto', 'zh-CN')).toBe(true);
    expect(nativeTranslates(nativeTranslator('hy-mt2-1.8b'), 'ja', 'sw')).toBe(false);
    expect(nativeTranslator('gone').id).toBe(NATIVE_DEFAULT_TRANSLATOR);
    expect(NATIVE_TRANSLATORS.map((m) => m.id)).toEqual(['index-translate-2b', 'hy-mt2-1.8b', 'hy-mt1.5-1.8b']);
    // The older Hunyuan model is no longer offered: its successor does all it does. It stays for a computer that has it.
    expect(NATIVE_TRANSLATORS.filter((m) => m.retired).map((m) => m.id)).toEqual(['hy-mt1.5-1.8b']);
  });
});

describe('a request in a model\'s own form, on the chat wire', () => {
  it('goes as one user message with no system message, the sampling beside it', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: '你好' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const answer = await completeText(
      { url: 'http://127.0.0.1:4200/v1/chat/completions', model: 'index-translate-2b', system: '', user: 'こんにちは', extra: { temperature: 0, model: 'never', stream: false } },
      { fetch: fetch as unknown as typeof globalThis.fetch, clock: createVirtualClock(), signal: new AbortController().signal },
    );
    expect(answer.text).toBe('你好');
    expect(sent[0].messages).toEqual([{ role: 'user', content: 'こんにちは' }]);
    // The sampling goes along; the model and the stream stay the request's own.
    expect(sent[0]).toMatchObject({ temperature: 0, model: 'index-translate-2b', stream: true });
  });
});

describe('the native translation engine as what translates on this computer', () => {
  it('is kept as stored, with its model', () => {
    expect(LOCALAI_DEFAULTS).toMatchObject({ translateHere: 'app', translateNativeModel: NATIVE_DEFAULT_TRANSLATOR });
    const kept = migrateLocalAISettings({ translateHere: 'native', translateNativeModel: 'hy-mt2-1.8b' }, { legacy: {}, credentials: {} });
    expect(kept).toMatchObject({ translateHere: 'native', translateNativeModel: 'hy-mt2-1.8b', coachHere: 'app' });
  });

  it('asks nothing of the app\'s own translation models', () => {
    const s = settings(NATIVE);
    expect(translatesNatively(s)).toBe(true);
    expect(deviceNeeds(deviceChoices(s), PAIR, ['speaker', 'participant'])).toEqual([]);
  });

  it('builds a leg whose translation is asked of the engine on this computer, in the model\'s own form', () => {
    useNativeTranslatorStore.setState({ status: READY, asked: true });
    expect(translatorBaseUrl()).toBe('http://127.0.0.1:4200/v1');
    const config = buildLocalAI(SPEAKER, settings(NATIVE), shared);
    if ('refused' in config) throw new Error(config.refused);
    expect(config.stages?.speech).toMatchObject({ kind: 'translate', baseUrl: 'http://127.0.0.1:4200/v1', model: 'index-translate-2b', system: '', wrap: expect.stringContaining('请将以下日语文本翻译为中文') });
    expect(config.stages?.speech).not.toHaveProperty('key');
    expect(config.stages?.typed).toBe(config.stages?.speech);
    // Its memory is not the app's own models' to count.
    expect(admitLocalAI({ speaker: config })).toBe(true);
  });

  it('refuses a pair its model does not translate', () => {
    const config = buildLocalAI({ ...SPEAKER, direction: { source: 'ja', target: 'sw' } }, settings({ ...NATIVE, translateNativeModel: 'hy-mt2-1.8b' }), shared);
    expect(config).toMatchObject({ refused: expect.stringContaining('sw'), code: 'local_models_missing' });
  });
});

describe('whether a run that translates by the engine can start', () => {
  const asked = (status: NativeEngineStatus, id = 'index-translate-2b', pairs = [PAIR, { source: 'zh-CN', target: 'ja' }]) => ({ gap: translatorGap(id, pairs, { status: async () => status }) });

  it('can with its model downloaded: the engine is brought up when the run begins, not by the check', async () => {
    expect(await asked(READY).gap).toBeNull();
    expect(await asked(engine()).gap).toBeNull();
  });

  it('cannot while the model is not downloaded, or where the system has no engine', async () => {
    expect(await asked(READY, 'hy-mt2-1.8b').gap).toMatchObject({ ok: false, code: 'native_translator_missing', params: { name: 'Hunyuan MT 2 1.8B' } });
    expect(await asked(NO_NATIVE_ENGINE).gap).toMatchObject({ ok: false, code: 'native_translator_unsupported' });
  });

  it('cannot for a pair the model does not translate', async () => {
    const downloaded = engine({ models: { 'hy-mt2-1.8b': { state: 'downloaded', received: 1, total: 1 } } });
    expect(await asked(downloaded, 'hy-mt2-1.8b', [{ source: 'ja', target: 'sw' }]).gap).toMatchObject({ ok: false, code: 'local_models_missing' });
  });

  it('says a start that failed, and does not try it again by itself', async () => {
    const failed = asked(engine({ run: { state: 'failed', model: 'index-translate-2b', port: 0, tail: 'no vulkan device' } }));
    expect(await failed.gap).toMatchObject({ ok: false, code: 'native_translator_failed', reason: expect.stringContaining('no vulkan device') });
  });
});

describe('the provider\'s check, with the translation engine', () => {
  const OK: CheckResult = { ok: true, models: [] };
  const deps = (gap: typeof translatorGap) => ({ gap: vi.fn(async () => null), idle: vi.fn(), translatorGap: gap, translatorIdle: vi.fn() });

  it('asks the engine for the pair each leg translates', async () => {
    const gap = vi.fn(async () => null);
    const native = deps(gap as unknown as typeof translatorGap);
    expect(await checkLocalAIWithNative(NONE, settings(NATIVE), CTX, async () => OK, native)).toBe(OK);
    expect(gap).toHaveBeenCalledWith('index-translate-2b', [PAIR, { source: 'zh-CN', target: 'ja' }]);
    expect(native.translatorIdle).not.toHaveBeenCalled();
  });

  it('lets the engine rest when it does not translate', async () => {
    const gap = vi.fn(async () => null);
    const native = deps(gap as unknown as typeof translatorGap);
    await checkLocalAIWithNative(NONE, settings({ ...NATIVE, translateHere: 'app' }), CTX, async () => OK, native);
    expect(gap).not.toHaveBeenCalled();
    expect(native.translatorIdle).toHaveBeenCalledTimes(1);
  });

  it('refuses in the engine\'s words', async () => {
    const refusal = { ok: false as const, reason: 'Index-Translate 2B is not downloaded.', code: 'native_translator_missing' };
    const native = deps((async () => refusal) as unknown as typeof translatorGap);
    expect(await checkLocalAIWithNative(NONE, settings(NATIVE), CTX, async () => OK, native)).toEqual(refusal);
  });

  it('is told of the engine\'s model among what decides the check', () => {
    expect(localaiProvider.checkReads).toContain('translateNativeModel');
    expect(localaiProvider.checkReads).toContain('translateHere');
  });
});

describe('a request with the sentence said before', () => {
  it('is Hunyuan MT\u2019s own form for it, from its card, where the request is in Chinese', () => {
    const request = translatorRequest(nativeTranslator('hy-mt2-1.8b'), 'ja', 'zh-CN');
    expect(request.wrapAfter).toBe(`${BEFORE_SLOT}\n参考上面的信息，把下面的文本翻译成中文，注意不需要翻译上文，也不要额外解释：\n${TEXT_SLOT}`);
    expect(translatorRequest(nativeTranslator('hy-mt2-1.8b'), 'zh-CN', 'ja').wrapAfter).toContain('翻译成日语');
    // Its card writes that form in Chinese only: between two other languages a sentence is asked alone.
    expect(translatorRequest(nativeTranslator('hy-mt2-1.8b'), 'ja', 'en').wrapAfter).toBeUndefined();
  });

  it('is not made for Index-Translate: given one, it translated that sentence instead of its own', () => {
    // Measured 2026-10-06, three forms, twelve pairs of sentences: one to three of twelve each.
    expect(translatorRequest(nativeTranslator('index-translate-2b'), 'ja', 'zh-CN').wrapAfter).toBeUndefined();
  });
});
