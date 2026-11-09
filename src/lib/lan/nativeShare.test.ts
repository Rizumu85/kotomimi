// Fork: this computer's native engines, as the sharing host lends them.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_NATIVE_ENGINE, type NativeEngineStatus } from '../native/nativeEngine';
import { holdNative, holdNativeForRun, nativeIdle, preferNative, translatorIdle } from '../../providers/openai/localaiNative';
import { useModelStore } from '../../stores/modelStore';
import { useNativeCoachStore, useNativeEngineStore, useNativeTranslatorStore } from '../../stores/nativeEngineStore';
import { appLanModels } from './appModels';
import { NATIVE_KNOWN_WITHIN_MS, nativeCoachAnswer, nativeCoachFor, nativeKnown, nativeOfferFor, nativeTranslator, nativeRecognizer, nativeRecognizerFor, nativeRecognizerRefusal, nativeShared, nativeTranslatorFor } from './nativeShare';
import { BEFORE_SLOT, NATIVE_TRANSLATORS, TEXT_SLOT, translatorRequest } from '../../providers/openai/nativeTranslators';

const downloaded = { state: 'downloaded' as const, received: 1, total: 1 };
const absent = { state: 'absent' as const, received: 0, total: 1 };
const status = (models: NativeEngineStatus['models'], run: Partial<NativeEngineStatus['run']> = {}): NativeEngineStatus => ({
  supported: true, engine: 'ready', engineBytes: 0, models, run: { state: 'stopped', model: null, port: 0, tail: '', ...run }, up: [],
});

/** A Windows PC with the downloaded recognizer and one translator; a Mac with the system's Japanese and English. */
const PC = status({ 'r2t2-q8': downloaded });
const MAC = status({ 'apple-speech:ja': downloaded, 'apple-speech:en': downloaded, 'apple-speech:zh': absent });
const TRANSLATORS = status({ 'index-translate-2b': downloaded, 'hy-mt2-1.8b': downloaded, 'hy-mt1.5-1.8b': absent });

beforeEach(() => {
  useModelStore.setState({ initialized: true, webgpuAvailable: true, deviceFeatures: [], modelStatuses: {} });
  useNativeEngineStore.setState({ status: NO_NATIVE_ENGINE, asked: true });
  useNativeTranslatorStore.setState({ status: NO_NATIVE_ENGINE, asked: true });
});

describe('what of the native engines is shared', () => {
  it('is nothing while nothing of theirs is downloaded', () => {
    expect(nativeShared()).toEqual([]);
    expect(nativeRecognizerFor('ja', '')).toBeNull();
    expect(nativeTranslatorFor('ja', 'zh', '')).toBeNull();
  });

  it('is each downloaded model, with what it is for and the languages it takes', () => {
    useNativeEngineStore.setState({ status: MAC });
    useNativeTranslatorStore.setState({ status: TRANSLATORS });
    expect(nativeShared()).toEqual([
      { id: 'apple-speech:ja', kind: 'asr', languages: ['ja'], bilingual: true },
      { id: 'apple-speech:en', kind: 'asr', languages: ['en'], bilingual: true },
      // Every language: none listed.
      { id: 'index-translate-2b', kind: 'translate', languages: [] },
      { id: 'hy-mt2-1.8b', kind: 'translate', languages: expect.arrayContaining(['ja', 'zh', 'en']) },
    ]);
  });

  it('shares native models even when old app models are still downloaded', () => {
    useNativeEngineStore.setState({ status: PC });
    useNativeTranslatorStore.setState({ status: TRANSLATORS });
    useModelStore.setState({ modelStatuses: { 'whisper-large-v3-turbo-webgpu': 'downloaded', 'hy-mt15-1.8b-translation': 'downloaded' } });
    expect(appLanModels.shared().map((m) => m.id)).toEqual(['r2t2-q8', 'index-translate-2b', 'hy-mt2-1.8b']);
  });

});

describe('the recognizer a device gets', () => {
  it('opens any installed Apple pair and refuses missing languages or a different engine', () => {
    useNativeEngineStore.setState({ status: status({ 'apple-speech:en': downloaded, 'apple-speech:fr': downloaded, 'apple-speech:ko': absent }) });
    expect(appLanModels.recognizer('en', 'apple-speech:en', 'fr')).toEqual({ modelId: 'apple-speech:en', streaming: true, also: 'fr' });
    expect(appLanModels.recognizer('fr', 'apple-speech:en', 'en')).toEqual({ modelId: 'apple-speech:fr', streaming: true, also: 'en' });
    for (const [first, wanted, second] of [['en', 'apple-speech:en', 'ko'], ['en', 'apple-speech:en', 'ru'], ['en', 'qwen3-asr-1.7b-q8', 'fr'], ['en', 'missing-model', 'fr']]) {
      expect(appLanModels.recognizer(first, wanted, second)).toBeNull();
    }
  });

  it('is the native one for a language it hears, when the choice is left to this computer', () => {
    useNativeEngineStore.setState({ status: PC });
    expect(appLanModels.recognizer('ja', '')).toEqual({ modelId: 'r2t2-q8', streaming: true });
    // A language no native model hears is unavailable.
    expect(appLanModels.recognizer('th', '')).toBeNull();
  });

  it('is the Mac\'s recognition by the model of the language spoken, whichever of its languages was named', () => {
    useNativeEngineStore.setState({ status: MAC });
    expect(nativeRecognizerFor('en', 'apple-speech:ja')).toEqual({ modelId: 'apple-speech:en', streaming: true });
    expect(nativeRecognizerFor('ja', '')).toEqual({ modelId: 'apple-speech:ja', streaming: true });
    // A language the system has not fetched is not shared.
    expect(nativeRecognizerFor('zh', 'apple-speech:ja')).toBeNull();
    expect(nativeRecognizerFor('zh', '')).toBeNull();
  });

  it('is, for a language to detect, never the Mac\'s recognition its own run hears its speaker in either language by (fork)', () => {
    const both = { 'apple-speech:zh': downloaded, 'apple-speech:ja': downloaded, 'qwen3-asr-1.7b-q8': downloaded };
    useNativeEngineStore.setState({ status: status(both) });
    preferNative({ asr: { model: 'apple-speech:zh', byLanguage: { zh: 'apple-speech:zh' }, either: { own: 'zh', others: ['ja'] } } });
    expect(nativeRecognizerFor('auto', '')).toEqual({ modelId: 'qwen3-asr-1.7b-q8', streaming: true });
    expect(nativeRecognizerFor('zh', '')).toEqual({ modelId: 'apple-speech:zh', streaming: true });
    preferNative({ asr: null });
  });

  it('treats a retired app recognizer as a stale remote selection', () => {
    useNativeEngineStore.setState({ status: PC });
    expect(appLanModels.recognizer('ja', 'whisper-large-v3-turbo-webgpu')).toEqual({ modelId: 'r2t2-q8', streaming: true });
  });

  it('is, of two downloaded for the engine, the one measured better — unless the other is running: starting another would stop it under whoever listens', () => {
    const both = { 'r2t2-q8': downloaded, 'qwen3-asr-1.7b-q8': downloaded };
    useNativeEngineStore.setState({ status: status(both) });
    expect(nativeRecognizerFor('ja', '')).toEqual({ modelId: 'qwen3-asr-1.7b-q8', streaming: true });
    expect(nativeRecognizerFor('ja', 'r2t2-q8')).toEqual({ modelId: 'r2t2-q8', streaming: true });
    // The one still up answers where none was named and it hears the language; nobody using it, one named is started.
    useNativeEngineStore.setState({ status: status(both, { state: 'ready', model: 'r2t2-q8', port: 5000 }) });
    expect(nativeRecognizerFor('ja', '')).toEqual({ modelId: 'r2t2-q8', streaming: true });
    expect(nativeRecognizerFor('ja', 'qwen3-asr-1.7b-q8')).toEqual({ modelId: 'qwen3-asr-1.7b-q8', streaming: true });
    // It does not hear Thai: the one that does.
    expect(nativeRecognizerFor('th', '')).toEqual({ modelId: 'qwen3-asr-1.7b-q8', streaming: true });
    // A model of the app that was named is still the app to run.
    expect(nativeRecognizerFor('ja', 'whisper-large-v3-turbo-webgpu')).toBeNull();
  });

  it('is the Mac\'s own recognition when that is named, though the downloaded engine is running a model that hears the language — and the other way round', () => {
    const both = { 'apple-speech:zh': downloaded, 'qwen3-asr-1.7b-q8': downloaded };
    useNativeEngineStore.setState({ status: status(both, { state: 'ready', model: 'qwen3-asr-1.7b-q8', port: 5000 }) });
    expect(nativeRecognizerFor('zh', 'apple-speech:zh')).toEqual({ modelId: 'apple-speech:zh', streaming: true });
    expect(nativeRecognizerFor('zh', '')).toEqual({ modelId: 'qwen3-asr-1.7b-q8', streaming: true });
    useNativeEngineStore.setState({ status: status(both, { state: 'ready', model: 'apple-speech:zh', port: 5000 }) });
    expect(nativeRecognizerFor('zh', 'qwen3-asr-1.7b-q8')).toEqual({ modelId: 'qwen3-asr-1.7b-q8', streaming: true });
  });

  it('is run by the native engine, which is held while a device listens through it', async () => {
    useNativeEngineStore.setState({ status: status({ 'r2t2-q8': downloaded }, { state: 'ready', model: 'r2t2-q8', port: 5000 }) });
    const stop = vi.fn();
    expect(nativeRecognizer({ modelId: 'whisper-large-v3-turbo-webgpu' })).toBeNull();
    const recognizer = nativeRecognizer({ modelId: 'r2t2-q8' })!;
    expect(recognizer).not.toBeNull();
    // Not yet listening: the app's own check may stop an engine that is no choice of this computer's.
    nativeIdle({ stop });
    expect(stop).toHaveBeenCalledTimes(1);
    // Listening: it may not. (The detector's worker cannot start in a test: the engine is held all the same.)
    void recognizer.init('r2t2-q8', { vadConfig: { threshold: 0.3, minSilenceDuration: 1.4, minSpeechDuration: 0.4, maxSpeechDuration: 15 }, language: 'ja' }).catch(() => undefined);
    nativeIdle({ stop });
    expect(stop).toHaveBeenCalledTimes(1);
    recognizer.dispose();
    nativeIdle({ stop });
    expect(stop).toHaveBeenCalledTimes(2);
  });
});

describe('the translator a device gets', () => {
  it('is the native one for a pair it translates: the one named, else the one already running, else the best downloaded', () => {
    useNativeTranslatorStore.setState({ status: TRANSLATORS });
    expect(appLanModels.translator('ja', 'zh', '')).toBe('index-translate-2b');
    expect(nativeTranslatorFor('ja', 'zh', 'hy-mt2-1.8b')).toBe('hy-mt2-1.8b');
    // Not downloaded, or not a pair it translates: not this one.
    expect(nativeTranslatorFor('ja', 'zh', 'hy-mt1.5-1.8b')).toBeNull();
    expect(nativeTranslatorFor('ja', 'sw', 'hy-mt2-1.8b')).toBeNull();
    useNativeTranslatorStore.setState({ status: { ...TRANSLATORS, run: { state: 'ready', model: 'hy-mt2-1.8b', port: 6000, tail: '' } } });
    expect(nativeTranslatorFor('ja', 'zh', '')).toBe('hy-mt2-1.8b');
    // Nobody is using it: a model named starts, though another is still up from a run before.
    expect(nativeTranslatorFor('ja', 'zh', 'index-translate-2b')).toBe('index-translate-2b');
    // The running one does not translate this pair: the one that does.
    expect(nativeTranslatorFor('ja', 'sw', '')).toBe('index-translate-2b');
  });

  it('asks the engine on this computer in the model\'s own form, and holds it meanwhile', async () => {
    const ready: NativeEngineStatus = { ...TRANSLATORS, run: { state: 'ready', model: 'index-translate-2b', port: 6000, tail: '' } };
    useNativeTranslatorStore.setState({ status: ready, start: async () => ready });
    const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ choices: [{ message: { content: ' 你好。 ' } }] }), { status: 200 });
    });
    const translator = nativeTranslator(fetch as unknown as typeof globalThis.fetch);
    await translator.init('ja', 'zh', 'index-translate-2b');
    const stop = vi.fn();
    translatorIdle({ stop });
    expect(stop).not.toHaveBeenCalled();
    expect(await translator.translate('こんにちは。', 'ignored', true)).toEqual({ translatedText: '你好。' });
    expect(sent[0].url).toBe('http://127.0.0.1:6000/v1/chat/completions');
    expect(sent[0].body).toMatchObject({ model: 'index-translate-2b', stream: false, temperature: 0 });
    expect(sent[0].body.messages).toEqual([{ role: 'user', content: '请将以下日语文本翻译为中文，直接输出翻译结果，不要进行任何解释。\n\nこんにちは。' }]);
    translator.dispose();
    translatorIdle({ stop });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('words the Traditional Chinese a client asks for, and the sentence it said before, into the request as this computer would', async () => {
    const ready: NativeEngineStatus = { ...TRANSLATORS, run: { state: 'ready', model: 'hy-mt2-1.8b', port: 6000, tail: '' } };
    useNativeTranslatorStore.setState({ status: ready, start: async () => ready });
    const sent: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: '好。' } }] }), { status: 200 });
    });
    const translator = nativeTranslator(fetch as unknown as typeof globalThis.fetch);
    await translator.init('ja', 'zh-TW', 'hy-mt2-1.8b');
    await translator.translate('はい。', 'ignored', true, '明日行く？');
    await translator.translate('はい。', 'ignored', true);
    const [withBefore, alone] = sent.map((body) => (body.messages as Array<{ content: string }>)[0].content);
    expect(withBefore).toBe(translatorRequest(NATIVE_TRANSLATORS.find((m) => m.id === 'hy-mt2-1.8b')!, 'ja', 'zh-TW').wrapAfter!.replace(BEFORE_SLOT, '明日行く？').replace(TEXT_SLOT, 'はい。'));
    expect(withBefore).toContain('繁体中文');
    expect(alone).not.toContain('明日行く？');
    translator.dispose();
  });

  it('rejects an app translator instead of starting a local worker', async () => {
    const translator = nativeTranslator();
    await expect(translator.init('ja', 'zh', 'hy-mt15-1.8b-translation')).rejects.toThrow('not a native model');
    translator.dispose();
  });

  it('says so when the engine does not come up', async () => {
    const down: NativeEngineStatus = { ...TRANSLATORS, run: { state: 'failed', model: 'index-translate-2b', port: 0, tail: 'no device' } };
    useNativeTranslatorStore.setState({ status: down, start: async () => down });
    const translator = nativeTranslator();
    await expect(translator.init('ja', 'zh', 'index-translate-2b')).rejects.toThrow('could not start');
    translator.dispose();
  });
});

describe('an engine that is someone\u2019s is not switched to another model', () => {
  const QUIET = { stop: { asr() {}, translation() {}, coach() {} }, setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>, clearTimer: () => {} };
  const BOTH = status({ 'r2t2-q8': downloaded, 'qwen3-asr-1.7b-q8': downloaded });

  it('gives a device that names no model this computer\u2019s own choice, so that its owner\u2019s next run switches nothing', () => {
    useNativeEngineStore.setState({ status: BOTH });
    // Nothing is known of the owner's choice: the first of the list that hears the language.
    preferNative({ asr: null });
    expect(nativeRecognizerFor('ja', '')).toEqual({ modelId: 'qwen3-asr-1.7b-q8', streaming: true });
    preferNative({ asr: { model: 'r2t2-q8' } });
    expect(nativeRecognizerFor('ja', '')).toEqual({ modelId: 'r2t2-q8', streaming: true });
    // A language the owner's model does not hear: the one that does.
    expect(nativeRecognizerFor('th', '')).toEqual({ modelId: 'qwen3-asr-1.7b-q8', streaming: true });
    preferNative({ asr: null });
  });

  it('leaves a recognizer that a run of this computer is using on its model: a device that needs another is given none of the engine\u2019s', () => {
    useNativeEngineStore.setState({ status: { ...BOTH, run: { state: 'ready', model: 'r2t2-q8', port: 4100, tail: '' }, up: ['r2t2-q8'] } });
    const done = holdNativeForRun(QUIET, { asr: true });
    try {
      // What it hears, it answers for, whichever of the engine's models was named.
      expect(nativeRecognizerFor('ja', 'qwen3-asr-1.7b-q8')).toEqual({ modelId: 'r2t2-q8', streaming: true });
      // Thai is not R2T2's: Qwen3-ASR would hear it, and starting it would stop the owner's session.
      expect(nativeRecognizerFor('th', '')).toBeNull();
      expect(nativeRecognizerFor('th', 'qwen3-asr-1.7b-q8')).toBeNull();
    } finally {
      done();
    }
    // Nobody's any more: the model that hears it may be started.
    expect(nativeRecognizerFor('th', '')).toEqual({ modelId: 'qwen3-asr-1.7b-q8', streaming: true });
  });

  it('does the same for the translation engine, held by a device or by a run', () => {
    useNativeTranslatorStore.setState({ status: { ...TRANSLATORS, run: { state: 'ready', model: 'hy-mt2-1.8b', port: 4200, tail: '' }, up: ['hy-mt2-1.8b'] } });
    // Nobody is using it: a model named starts, rather than the one still up from an earlier run.
    expect(nativeTranslatorFor('ja', 'zh', 'index-translate-2b')).toBe('index-translate-2b');
    const device = holdNative('translation', QUIET);
    try {
      expect(nativeTranslatorFor('ja', 'zh', '')).toBe('hy-mt2-1.8b');
      // Swahili is not Hunyuan's: Index-Translate takes it, but not while the engine is in use with Hunyuan.
      expect(nativeTranslatorFor('ja', 'sw', '')).toBeNull();
      expect(nativeTranslatorFor('ja', 'sw', 'index-translate-2b')).toBeNull();
    } finally {
      device();
    }
    expect(nativeTranslatorFor('ja', 'sw', '')).toBe('index-translate-2b');
    // The owner's own choice first, when nothing is running and none is named.
    useNativeTranslatorStore.setState({ status: TRANSLATORS });
    preferNative({ translation: 'hy-mt2-1.8b' });
    expect(nativeTranslatorFor('ja', 'zh', '')).toBe('hy-mt2-1.8b');
    preferNative({ translation: null });
    expect(nativeTranslatorFor('ja', 'zh', '')).toBe('index-translate-2b');
  });
});

describe('a name this computer shares nothing under', () => {
  it('is no name: the choice is this computer’s, as when a device names none', () => {
    // A device still has chosen a model this computer had once — a LocalAI’s "Apple Speech Transcriber", since removed.
    useNativeEngineStore.setState({ status: MAC });
    useNativeTranslatorStore.setState({ status: TRANSLATORS });
    expect(appLanModels.recognizer('ja', '')).toEqual({ modelId: 'apple-speech:ja', streaming: true });
    expect(appLanModels.recognizer('ja', 'apple-speech-transcriber')).toEqual({ modelId: 'apple-speech:ja', streaming: true });
    expect(appLanModels.translator('ja', 'zh', 'a-model-that-is-gone')).toBe(appLanModels.translator('ja', 'zh', ''));
    expect(appLanModels.translator('ja', 'zh', '')).not.toBeNull();
    // A name it does share is kept to.
    expect(appLanModels.translator('ja', 'zh', 'hy-mt2-1.8b')).toBe('hy-mt2-1.8b');
  });
});

describe('this computer\u2019s feedback model, lent', () => {
  const COACH_HERE = status({ 'gemma-4-e2b': downloaded });

  it('is listed among what is shared once it is downloaded, and found by its name alone', () => {
    const before = useNativeCoachStore.getState().status;
    try {
      useNativeCoachStore.setState({ status: NO_NATIVE_ENGINE });
      expect(nativeShared().some((m) => m.kind === 'feedback')).toBe(false);
      expect(nativeCoachFor('gemma-4-e2b')).toBeNull();
      useNativeCoachStore.setState({ status: COACH_HERE });
      expect(nativeShared().filter((m) => m.kind === 'feedback')).toEqual([{ id: 'gemma-4-e2b', kind: 'feedback', languages: [] }]);
      expect(nativeCoachFor('gemma-4-e2b')).toBe('gemma-4-e2b');
      // No other name is the feedback model's: a translation request is never taken for one.
      expect(nativeCoachFor('kotomimi')).toBeNull();
      expect(nativeCoachFor('index-translate-2b')).toBeNull();
      expect(nativeCoachFor('')).toBeNull();
    } finally {
      useNativeCoachStore.setState({ status: before });
    }
  });

  it('is asked on this computer with the key of its run, started first when it is not up', async () => {
    const before = useNativeCoachStore.getState();
    const up = { ...COACH_HERE, run: { state: 'ready' as const, model: 'gemma-4-e2b', port: 4300, tail: '', key: 'abcdef0123456789abcdef' }, up: ['gemma-4-e2b'] };
    const start = vi.fn(async () => { useNativeCoachStore.setState({ status: up }); return up; });
    useNativeCoachStore.setState({ status: COACH_HERE, start } as never);
    try {
      const calls: Array<{ url: string; init: RequestInit }> = [];
      const doFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), init: init ?? {} });
        return new Response(JSON.stringify({ choices: [{ message: { content: '<think>hm</think> 没问题。' } }] }), { status: 200 });
      }) as typeof fetch;
      expect(await nativeCoachAnswer('gemma-4-e2b', [{ role: 'user', content: 'x' }], { temperature: 0 }, doFetch)).toBe('没问题。');
      expect(start).toHaveBeenCalledWith('gemma-4-e2b');
      expect(calls[0].url).toBe('http://127.0.0.1:4300/v1/chat/completions');
      expect(new Headers(calls[0].init.headers).get('Authorization')).toBe('Bearer abcdef0123456789abcdef');
      expect(JSON.parse(String(calls[0].init.body))).toEqual({ temperature: 0, model: 'gemma-4-e2b', stream: false, messages: [{ role: 'user', content: 'x' }] });
    } finally {
      useNativeCoachStore.setState(before as never, true);
    }
  });
});

describe('two sessions of one device at once (fork)', () => {
  const BOTH = status({ 'sensevoice-small-q8': downloaded, 'qwen3-asr-1.7b-q8': downloaded }, { state: 'ready', model: 'sensevoice-small-q8', port: 5000 });
  const vad = { threshold: 0.3, minSilenceDuration: 1.4, minSpeechDuration: 0.4, maxSpeechDuration: 15 };

  it('give both the model named, not one still up from an earlier run, though the engine has not said it switched', () => {
    useNativeEngineStore.setState({ status: BOTH });
    // The other side, in Chinese: SenseVoice is up and hears it, but Qwen3-ASR was named and nobody uses SenseVoice.
    const first = nativeRecognizerFor('zh', 'qwen3-asr-1.7b-q8');
    expect(first).toEqual({ modelId: 'qwen3-asr-1.7b-q8', streaming: true });
    const recognizer = nativeRecognizer(first!)!;
    void recognizer.init(first!.modelId, { vadConfig: vad, language: 'zh' }).catch(() => undefined);
    try {
      // The speaker's, to be detected, asked before the engine's status names Qwen3-ASR.
      expect(nativeRecognizerFor('auto', 'qwen3-asr-1.7b-q8')).toEqual({ modelId: 'qwen3-asr-1.7b-q8', streaming: true });
      // Held with Qwen3-ASR, SenseVoice named is not started under it: Qwen3-ASR hears Chinese, and answers.
      expect(nativeRecognizerFor('zh', 'sensevoice-small-q8')).toEqual({ modelId: 'qwen3-asr-1.7b-q8', streaming: true });
    } finally {
      recognizer.dispose();
    }
  });

  it('are refused as busy, not as having no model, while the engine is held with one that does not hear the language', () => {
    // Held with a model that cannot tell languages apart: R2T2.
    useNativeEngineStore.setState({ status: { ...status({ 'r2t2-q8': downloaded, 'qwen3-asr-1.7b-q8': downloaded }, { state: 'ready', model: 'r2t2-q8', port: 5000 }), up: ['r2t2-q8'] } });
    const quiet = { stop: { asr() {}, translation() {}, coach() {} }, setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>, clearTimer: () => {} };
    // A run of this computer that hears by the Mac's own recognition leaves the engine's model free.
    const apple = holdNativeForRun(quiet);
    expect(nativeRecognizerFor('auto', 'qwen3-asr-1.7b-q8')).toEqual({ modelId: 'qwen3-asr-1.7b-q8', streaming: true });
    apple();
    const done = holdNativeForRun(quiet, { asr: true });
    try {
      expect(nativeRecognizerFor('auto', 'qwen3-asr-1.7b-q8')).toBeNull();
      expect(nativeRecognizerRefusal('auto', 'qwen3-asr-1.7b-q8')).toBe('busy');
      expect(nativeRecognizerRefusal('auto', '')).toBe('busy');
      // Nothing here hears Swahili at all: no model, not a busy one.
      expect(nativeRecognizerRefusal('sw', '')).toBeNull();
    } finally {
      done();
    }
  });

  it('answer a pair named of a model other than the Mac’s alone, to be refused as no pair rather than no model', () => {
    useNativeEngineStore.setState({ status: BOTH });
    expect(nativeRecognizerFor('zh', 'qwen3-asr-1.7b-q8', 'ko')).toEqual({ modelId: 'qwen3-asr-1.7b-q8', streaming: true });
  });
});

describe('the recognizer offered for a language a device found nothing here for (fork)', () => {
  const MAC_MORE = status({ 'apple-speech:ja': downloaded, 'apple-speech:ko': absent, 'qwen3-asr-1.7b-q8': absent, 'r2t2-q8': absent });

  it('is the one the device chose, in the language it asked, else the first this system offers that hears it', () => {
    useNativeEngineStore.setState({ status: MAC_MORE });
    // It chose the Mac's recognition, in Japanese: Korean is another of the Mac's languages.
    expect(nativeOfferFor('ko', 'apple-speech:ja')?.id).toBe('apple-speech:ko');
    expect(nativeOfferFor('ko', 'qwen3-asr-1.7b-q8')?.id).toBe('qwen3-asr-1.7b-q8');
    expect(nativeOfferFor('ko-KR', '')?.id).toBe('apple-speech:ko');
    expect(nativeOfferFor('auto', '')?.id).toBe('qwen3-asr-1.7b-q8');
  });

  it('is none where one that hears it is downloaded, or none here does', () => {
    useNativeEngineStore.setState({ status: MAC_MORE });
    expect(nativeOfferFor('ja', 'qwen3-asr-1.7b-q8')).toBeNull();
    expect(nativeOfferFor('sw', '')).toBeNull();
    useNativeEngineStore.setState({ status: { ...MAC_MORE, supported: false } });
    expect(nativeOfferFor('ko', '')).toBeNull();
  });
});

describe('a recognizer that tells languages apart, lent', () => {
  const QWEN = status({ 'qwen3-asr-1.7b-q8': downloaded, 'r2t2-q8': downloaded });

  it('says so to a device that asks: "auto" is among the languages it takes', () => {
    useNativeEngineStore.setState({ status: QWEN });
    const listed = nativeShared().filter((m) => m.kind === 'asr');
    expect(listed.find((m) => m.id === 'qwen3-asr-1.7b-q8')?.languages).toContain('auto');
    expect(listed.find((m) => m.id === 'r2t2-q8')?.languages).not.toContain('auto');
  });

  it('answers a session whose language is to be detected, and no other recognizer does', () => {
    useNativeEngineStore.setState({ status: QWEN });
    expect(nativeRecognizerFor('auto', '')).toEqual({ modelId: 'qwen3-asr-1.7b-q8', streaming: true });
    expect(nativeRecognizerFor('auto', 'qwen3-asr-1.7b-q8')).toEqual({ modelId: 'qwen3-asr-1.7b-q8', streaming: true });
    expect(nativeRecognizerFor('auto', 'r2t2-q8')).toBeNull();
    // None that detects is here: none answers.
    useNativeEngineStore.setState({ status: PC });
    expect(nativeRecognizerFor('auto', '')).toBeNull();
  });
});

describe('SenseVoice-Small, lent as the engine’s other models are', () => {
  it('is listed with its five languages, as one that tells them apart', () => {
    useNativeEngineStore.setState({ status: status({ 'sensevoice-small-q8': downloaded, 'qwen3-asr-0.6b-q8': absent }) });
    expect(nativeShared()).toEqual([{ id: 'sensevoice-small-q8', kind: 'asr', languages: ['zh', 'yue', 'en', 'ja', 'ko', 'auto'] }]);
    expect(appLanModels.shared()[0]).toEqual({ id: 'sensevoice-small-q8', kind: 'asr', languages: ['zh', 'yue', 'en', 'ja', 'ko', 'auto'] });
  });

  it('answers a device for a language it hears — named, or left to this computer — and for no other', () => {
    useNativeEngineStore.setState({ status: status({ 'sensevoice-small-q8': downloaded }) });
    for (const language of ['ja', 'zh', 'yue', 'en', 'ko']) {
      expect(nativeRecognizerFor(language, ''), language).toEqual({ modelId: 'sensevoice-small-q8', streaming: true });
      expect(nativeRecognizerFor(language, 'sensevoice-small-q8'), language).toEqual({ modelId: 'sensevoice-small-q8', streaming: true });
    }
    // Left to tell them apart, it does, among its five (measured 2026-11-06).
    expect(nativeRecognizerFor('auto', ''), 'auto').toEqual({ modelId: 'sensevoice-small-q8', streaming: true });
    // Told another language it would write the speech down as one of its five: it is not asked.
    for (const language of ['ru', 'fr']) {
      expect(nativeRecognizerFor(language, ''), language).toBeNull();
      expect(nativeRecognizerFor(language, 'sensevoice-small-q8'), language).toBeNull();
    }
    // Read live, a stretch begun again as often as on this computer's own runs.
    expect(nativeRecognizer({ modelId: 'sensevoice-small-q8' })).not.toBeNull();
  });

  it('is this computer’s choice after the more accurate models and before the small Qwen3 it is level with', () => {
    useNativeEngineStore.setState({ status: status({ 'qwen3-asr-0.6b-q8': downloaded, 'nemotron-asr-0.6b-q8': downloaded, 'sensevoice-small-q8': downloaded }) });
    expect(nativeRecognizerFor('ja', '')).toEqual({ modelId: 'sensevoice-small-q8', streaming: true });
    // A language of the small Qwen3's alone is that one's.
    expect(nativeRecognizerFor('ru', '')).toEqual({ modelId: 'qwen3-asr-0.6b-q8', streaming: true });
    useNativeEngineStore.setState({ status: status({ 'r2t2-q8': downloaded, 'sensevoice-small-q8': downloaded }) });
    expect(nativeRecognizerFor('ja', '')).toEqual({ modelId: 'r2t2-q8', streaming: true });
    expect(nativeRecognizerFor('yue', '')).toEqual({ modelId: 'sensevoice-small-q8', streaming: true });
    useNativeEngineStore.setState({ status: status({ 'qwen3-asr-1.7b-q8': downloaded, 'sensevoice-small-q8': downloaded }) });
    expect(nativeRecognizerFor('ja', '')).toEqual({ modelId: 'qwen3-asr-1.7b-q8', streaming: true });
  });
});

describe('sharing waits for the engines to say what they have (fork)', () => {
  it('opens once every engine has answered, and not before', async () => {
    useNativeEngineStore.setState({ asked: false });
    useNativeCoachStore.setState({ asked: false });
    let open = false;
    const known = nativeKnown().then(() => { open = true; });
    await Promise.resolve();
    expect(open).toBe(false);
    useNativeEngineStore.setState({ asked: true });
    await Promise.resolve();
    expect(open).toBe(false);
    useNativeCoachStore.setState({ asked: true });
    await known;
    expect(open).toBe(true);
  });

  it('opens all the same after a few seconds of no answer', async () => {
    vi.useFakeTimers();
    try {
      useNativeEngineStore.setState({ asked: false });
      let open = false;
      const known = nativeKnown().then(() => { open = true; });
      await vi.advanceTimersByTimeAsync(NATIVE_KNOWN_WITHIN_MS - 1);
      expect(open).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await known;
      expect(open).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a model named that cannot take the pair (fork)', () => {
  it('is refused as that, not answered by one of this computer\u2019s other models', () => {
    useNativeTranslatorStore.setState({ status: TRANSLATORS });
    useModelStore.setState({ modelStatuses: { 'translategemma-4b-translation': 'downloaded' } });
    // Greek is not Hunyuan MT 2's: the app has a model that takes it, and it is not put in the named model's place.
    expect(appLanModels.translator('ja', 'el', 'hy-mt2-1.8b')).toBeNull();
    expect(appLanModels.refusal!('ja', 'el', 'hy-mt2-1.8b')).toBe('unfit');
    // Left to this computer, the model that takes the pair answers.
    expect(appLanModels.translator('ja', 'el', '')).toBe('index-translate-2b');
    // The other way round, and a pair it does take: the named model stands.
    expect(appLanModels.translator('ja', 'zh', 'hy-mt2-1.8b')).toBe('hy-mt2-1.8b');
  });


});
