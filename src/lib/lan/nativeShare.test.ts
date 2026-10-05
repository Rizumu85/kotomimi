// Fork: this computer's native engines, as the sharing host lends them.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_NATIVE_ENGINE, type NativeEngineStatus } from '../native/nativeEngine';
import { nativeIdle, translatorIdle } from '../../providers/openai/localaiNative';
import { useModelStore } from '../../stores/modelStore';
import { useNativeEngineStore, useNativeTranslatorStore } from '../../stores/nativeEngineStore';
import { appLanModels } from './appModels';
import { nativeOrOwnTranslator, nativeRecognizer, nativeRecognizerFor, nativeShared, nativeTranslatorFor } from './nativeShare';
import type { Translator } from './translator';

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
      { id: 'apple-speech:ja', kind: 'asr', languages: ['ja'] },
      { id: 'apple-speech:en', kind: 'asr', languages: ['en'] },
      // Every language: none listed.
      { id: 'index-translate-2b', kind: 'translate', languages: [] },
      { id: 'hy-mt2-1.8b', kind: 'translate', languages: expect.arrayContaining(['ja', 'zh', 'en']) },
    ]);
  });

  it('is listed before the app\'s own models, each kind with its own', () => {
    useNativeEngineStore.setState({ status: PC });
    useNativeTranslatorStore.setState({ status: TRANSLATORS });
    useModelStore.setState({ modelStatuses: { 'whisper-large-v3-turbo-webgpu': 'downloaded', 'hy-mt15-1.8b-translation': 'downloaded' } });
    const shared = appLanModels.shared().map((m) => `${m.kind}:${m.id}`);
    expect(shared.indexOf('asr:r2t2-q8')).toBe(0);
    expect(shared.indexOf('asr:r2t2-q8')).toBeLessThan(shared.indexOf('asr:whisper-large-v3-turbo-webgpu'));
    expect(shared.indexOf('translate:index-translate-2b')).toBeLessThan(shared.indexOf('translate:hy-mt15-1.8b-translation'));
    expect(shared.indexOf('asr:whisper-large-v3-turbo-webgpu')).toBeLessThan(shared.indexOf('translate:index-translate-2b'));
  });
});

describe('the recognizer a device gets', () => {
  it('is the native one for a language it hears, when the choice is left to this computer', () => {
    useNativeEngineStore.setState({ status: PC });
    expect(appLanModels.recognizer('ja', '')).toEqual({ modelId: 'r2t2-q8', streaming: true });
    // A language it does not hear is the app's own models' to answer: none downloaded here.
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

  it('is the app\'s own model when that is the one named, though a native one is there', () => {
    useNativeEngineStore.setState({ status: PC });
    useModelStore.setState({ modelStatuses: { 'whisper-large-v3-turbo-webgpu': 'downloaded' } });
    expect(appLanModels.recognizer('ja', 'whisper-large-v3-turbo-webgpu')).toEqual({ modelId: 'whisper-large-v3-turbo-webgpu', streaming: false });
  });

  it('is, of two downloaded for the engine, the one measured better — unless the other is running: starting another would stop it under whoever listens', () => {
    const both = { 'r2t2-q8': downloaded, 'qwen3-asr-1.7b-q8': downloaded };
    useNativeEngineStore.setState({ status: status(both) });
    expect(nativeRecognizerFor('ja', '')).toEqual({ modelId: 'qwen3-asr-1.7b-q8', streaming: true });
    expect(nativeRecognizerFor('ja', 'r2t2-q8')).toEqual({ modelId: 'r2t2-q8', streaming: true });
    // The one running answers for either, where it hears the language.
    useNativeEngineStore.setState({ status: status(both, { state: 'ready', model: 'r2t2-q8', port: 5000 }) });
    expect(nativeRecognizerFor('ja', '')).toEqual({ modelId: 'r2t2-q8', streaming: true });
    expect(nativeRecognizerFor('ja', 'qwen3-asr-1.7b-q8')).toEqual({ modelId: 'r2t2-q8', streaming: true });
    // It does not hear Thai: the one that does.
    expect(nativeRecognizerFor('th', '')).toEqual({ modelId: 'qwen3-asr-1.7b-q8', streaming: true });
    // A model of the app that was named is still the app to run.
    expect(nativeRecognizerFor('ja', 'whisper-large-v3-turbo-webgpu')).toBeNull();
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
    // The engine runs one model at a time: the one running answers for another of its models that was named.
    expect(nativeTranslatorFor('ja', 'zh', 'index-translate-2b')).toBe('hy-mt2-1.8b');
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
    const own = vi.fn();
    const translator = nativeOrOwnTranslator(own as unknown as () => Translator, fetch as unknown as typeof globalThis.fetch);
    await translator.init('ja', 'zh', 'index-translate-2b');
    expect(own).not.toHaveBeenCalled();
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

  it('is the app\'s own engine for any other model, used as it always was', async () => {
    const engine: Translator = { onError: null, init: vi.fn(async () => undefined), translate: vi.fn(async () => ({ translatedText: '译文' })), dispose: vi.fn() };
    const translator = nativeOrOwnTranslator(() => engine);
    await translator.init('ja', 'zh', 'hy-mt15-1.8b-translation');
    expect(engine.init).toHaveBeenCalledWith('ja', 'zh', 'hy-mt15-1.8b-translation');
    expect(await translator.translate('text', 'prompt', true)).toEqual({ translatedText: '译文' });
    expect(engine.translate).toHaveBeenCalledWith('text', 'prompt', true);
    translator.dispose();
    expect(engine.dispose).toHaveBeenCalledTimes(1);
  });

  it('says so when the engine does not come up', async () => {
    const down: NativeEngineStatus = { ...TRANSLATORS, run: { state: 'failed', model: 'index-translate-2b', port: 0, tail: 'no device' } };
    useNativeTranslatorStore.setState({ status: down, start: async () => down });
    const translator = nativeOrOwnTranslator(vi.fn() as unknown as () => Translator);
    await expect(translator.init('ja', 'zh', 'index-translate-2b')).rejects.toThrow('could not start');
    translator.dispose();
  });
});
