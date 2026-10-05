// Fork: on this computer, hearing can be the native engine's — a runtime the app downloads and runs beside itself.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionContext } from '../../lib/contract/adapter';
import { NO_NATIVE_ENGINE, nativeEngineStatus, nativeStreamEvent, type NativeEngineStatus } from '../../lib/native/nativeEngine';
import type { CheckContext, CheckResult } from '../../lib/provider/types';
import { useModelStore } from '../../stores/modelStore';
import { detectsOther, heardBy } from './localaiDevice';
import { AdapterStartError } from '../../lib/contract/adapter';
import { useNativeCoachStore, useNativeEngineStore, useNativeTranslatorStore } from '../../stores/nativeEngineStore';
import { buildLocalAI, admitLocalAI, checkLocalAIWithNative, describeLocalAI, localaiProvider, prepareLocalAI, primeNativeOnce, type NativeUps, LOCALAI_DEFAULTS, migrateLocalAISettings, type LocalAICredentials, type LocalAISettings } from './localai';
import { cutsSentencesHere, deviceChoices, deviceNeeds, hearsByLocalServer, hearsNatively } from './localaiDevice';
import type { LocalAIModel } from './localaiModels';
import { APPLE_PREFIX, NATIVE_DEFAULT_MODEL, NATIVE_MODELS, chooseNative, nativePicked, nativeDownloaded, holdNative, holdNativeForRun, nativeGap, nativeHears, nativeIdle, nativeModel, nativeModelFor, nativeReady, nativeUp, nativeWaits, restNative, translatorUp } from './localaiNative';
import { SHARED } from './testing';

const SPEAKER: SessionContext = { direction: { source: 'ja', target: 'zh-CN' }, speech: false, turns: 'auto' };
const PAIR = { source: 'ja', target: 'zh-CN' };
const CTX: CheckContext = { pair: PAIR, legs: ['speaker'] };
const shared = { ...SHARED, reversed: (d: SessionContext['direction']) => d.source !== 'ja', models: [] as LocalAIModel[] };
const settings = (patch: Partial<LocalAISettings> = {}): LocalAISettings => ({ ...LOCALAI_DEFAULTS, ...patch });
const NONE: LocalAICredentials = { apiKey: '', endpoint: '' };
const NATIVE: Partial<LocalAISettings> = { asrVia: 'device', asrHere: 'native', asrNativeModel: 'r2t2-q8', translateAt: 'api', translateBaseUrl: 'https://api.example.com/v1', translateModel: 'some-model', translateNeedsKey: false };

const engine = (patch: Partial<NativeEngineStatus> = {}): NativeEngineStatus => ({
  supported: true,
  engine: 'ready',
  engineBytes: 60_000_000,
  models: { 'r2t2-q8': { state: 'downloaded', received: 2477512064, total: 2477512064 } },
  run: { state: 'stopped', model: null, port: 0, tail: '' },
  up: [],
  ...patch,
});
const READY = engine({ run: { state: 'ready', model: 'r2t2-q8', port: 4100, tail: '' } });

beforeEach(() => useModelStore.setState({ initialized: true, webgpuAvailable: true, deviceFeatures: [], modelStatuses: {} }));

describe('what the main process says of the engine, held to its shape', () => {
  it('reads a well-formed answer as it is', () => {
    expect(nativeEngineStatus(READY)).toEqual(READY);
  });

  it('reads anything else as no engine here', () => {
    expect(nativeEngineStatus(null)).toEqual(NO_NATIVE_ENGINE);
    expect(nativeEngineStatus({ engine: 'nonsense' })).toEqual(NO_NATIVE_ENGINE);
    const odd = nativeEngineStatus({ supported: true, engine: 'ready', engineBytes: -3, models: { a: { state: 'nonsense' }, b: { state: 'failed', received: 'x', total: 5, error: 'no disk' } }, run: { state: 'flying', model: 7, port: 99999, tail: 3 } });
    expect(odd).toEqual({ supported: true, engine: 'ready', engineBytes: 0, models: { b: { state: 'failed', received: 0, total: 5, error: 'no disk' } }, run: { state: 'stopped', model: null, port: 0, tail: '' }, up: [] });
    // The models that can hear now: names, and nothing else.
    expect(nativeEngineStatus({ engine: 'ready', up: ['a', 3, null, 'b'] }).up).toEqual(['a', 'b']);
    expect(nativeEngineStatus({ engine: 'ready', up: 'a' }).up).toEqual([]);
  });

  it('reads a recognition\'s events, and nothing that is not one', () => {
    expect(nativeStreamEvent({ id: 3, type: 'delta', text: 'あ' })).toEqual({ id: 3, type: 'delta', text: 'あ' });
    expect(nativeStreamEvent({ id: 3, type: 'done' })).toEqual({ id: 3, type: 'done', text: '' });
    expect(nativeStreamEvent({ id: 3, type: 'error' })).toEqual({ id: 3, type: 'error', message: 'The engine failed.' });
    expect(nativeStreamEvent({ id: 'x', type: 'delta', text: 'あ' })).toBeNull();
    expect(nativeStreamEvent({ id: 3, type: 'other' })).toBeNull();
  });
});

describe('the native engine as what hears on this computer', () => {
  it('is kept as stored, with its model', () => {
    expect(LOCALAI_DEFAULTS).toMatchObject({ asrHere: 'app', asrNativeModel: NATIVE_DEFAULT_MODEL });
    const kept = migrateLocalAISettings({ asrHere: 'native', asrNativeModel: 'r2t2-q8', coachHere: 'nonsense' }, { legacy: {}, credentials: {} });
    expect(kept).toMatchObject({ asrHere: 'native', asrNativeModel: 'r2t2-q8', coachHere: 'app' });
  });

  it('cuts the sentences here, with no Realtime session, and asks nothing of the app\'s own models', () => {
    const s = settings(NATIVE);
    expect(hearsNatively(s)).toBe(true);
    expect(hearsByLocalServer(s)).toBe(false);
    expect(cutsSentencesHere(s)).toBe(true);
    expect(deviceNeeds(deviceChoices(s), PAIR, ['speaker', 'participant'])).toEqual([]);
  });

  it('builds a leg that hears by the engine, with this computer\'s own turn detection', () => {
    const config = buildLocalAI(SPEAKER, settings(NATIVE), shared);
    if ('refused' in config) throw new Error(config.refused);
    expect(config.device).toMatchObject({ modelId: 'r2t2-q8', streaming: true, native: { model: 'r2t2-q8' }, vad: { minSilenceDuration: LOCALAI_DEFAULTS.vadMinSilenceDuration, maxSpeechDuration: 15 } });
    expect(config.device?.api).toBeUndefined();
    expect(config.model).toBe('');
    expect(describeLocalAI(config).asrModel).toBe('r2t2-q8');
    // Its memory is not the app's own models' to count.
    expect(admitLocalAI({ speaker: config })).toBe(true);
  });

  it('has no model for a language the one in use does not hear, and says so: none is taken in its place', () => {
    const config = buildLocalAI({ ...SPEAKER, direction: { source: 'th', target: 'zh-CN' } }, settings(NATIVE), shared);
    expect(config).toMatchObject({ refused: expect.stringContaining('th'), code: 'native_unchosen', params: { source: 'th' } });
    // Chosen for that language, it is heard by that one, whatever is in use.
    const chosen = buildLocalAI({ ...SPEAKER, direction: { source: 'th', target: 'zh-CN' } }, settings({ ...NATIVE, asrNativeByLanguage: { th: 'qwen3-asr-1.7b-q8' } }), shared);
    expect(chosen).toMatchObject({ device: { modelId: 'qwen3-asr-1.7b-q8' } });
    // And the language the model in use hears is still heard by it.
    expect(buildLocalAI(SPEAKER, settings({ ...NATIVE, asrNativeByLanguage: { th: 'qwen3-asr-1.7b-q8' } }), shared)).toMatchObject({ device: { modelId: 'r2t2-q8' } });
  });

  it('knows a model by its id, and falls to the default for one it no longer has', () => {
    expect(nativeModel('r2t2-q8').name).toBe('Confucius4 R2T2 GGUF');
    expect(nativeModel('gone').id).toBe(NATIVE_DEFAULT_MODEL);
    expect(nativeHears(nativeModel('r2t2-q8'), 'zh-CN')).toBe(true);
    expect(nativeHears(nativeModel('r2t2-q8'), 'th')).toBe(false);
  });

  it('has, as its default, the model every system can run — which hears thirty languages, and is read a stretch at a time', () => {
    expect(NATIVE_DEFAULT_MODEL).toBe('qwen3-asr-1.7b-q8');
    const qwen = nativeModel(NATIVE_DEFAULT_MODEL);
    expect(qwen.languages).toHaveLength(30);
    for (const language of ['ja', 'ru', 'th', 'ko-KR', 'yue']) expect(nativeHears(qwen, language)).toBe(true);
    expect(nativeHears(qwen, 'sw')).toBe(false);
    // Begun again sooner than a model that writes as it listens, and waited for longer at its end.
    expect(qwen.limits).toMatchObject({ rollAfter: 8, rollAt: 8, lastWordsMs: 15_000 });
    const config = buildLocalAI({ ...SPEAKER, direction: { source: 'ru', target: 'zh-CN' } }, settings({ ...NATIVE, asrNativeModel: NATIVE_DEFAULT_MODEL }), shared);
    expect(config).toMatchObject({ device: { modelId: 'qwen3-asr-1.7b-q8', streaming: true, native: { model: 'qwen3-asr-1.7b-q8', limits: { rollAfter: 8 } } } });
  });

  it('lists the models in the order they were measured: the recognition of the system itself, then the one read a stretch at a time, then the one that writes as it listens', () => {
    const families = NATIVE_MODELS.map((m) => m.name).filter((name, at, all) => all.indexOf(name) === at);
    expect(families).toEqual(['Apple Speech', 'Qwen3-ASR 1.7B GGUF', 'Confucius4 R2T2 GGUF', 'Qwen3-ASR 0.6B GGUF', 'Nemotron 3.5 ASR 0.6B GGUF']);
  });

  it('has, last of all, the smallest: read a stretch at a time, told the language by a locale, never left to detect it', () => {
    const smallest = nativeModel('nemotron-asr-0.6b-q8');
    expect(NATIVE_MODELS[NATIVE_MODELS.length - 1]).toBe(smallest);
    expect(smallest.bytes).toBeLessThan(nativeModel('qwen3-asr-0.6b-q8').bytes);
    expect(smallest.limits).toMatchObject({ rollAfter: 8, rollAt: 8 });
    for (const language of ['ja', 'zh-CN', 'en-GB', 'ko', 'uk', 'no']) expect(nativeHears(smallest, language)).toBe(true);
    expect(nativeHears(smallest, 'id')).toBe(false);
    expect(nativeHears(smallest, 'auto')).toBe(false);
    expect(nativePicked({ model: 'nemotron-asr-0.6b-q8' }, 'auto')).toBeNull();
    const config = buildLocalAI(SPEAKER, settings({ ...NATIVE, asrNativeModel: 'nemotron-asr-0.6b-q8' }), shared);
    expect(config).toMatchObject({ device: { modelId: 'nemotron-asr-0.6b-q8', streaming: true, native: { model: 'nemotron-asr-0.6b-q8', limits: { rollAfter: 8 } } } });
  });

  it('has a small model before it, for a computer that runs a game beside it: read as the large one is, and never left to detect the language', () => {
    const small = nativeModel('qwen3-asr-0.6b-q8');
    const large = nativeModel('qwen3-asr-1.7b-q8');
    expect(NATIVE_MODELS[NATIVE_MODELS.length - 2]).toBe(small);
    expect(small.bytes).toBeLessThan(large.bytes / 2);
    expect(small.languages).toEqual(large.languages);
    expect(small.limits).toEqual(large.limits);
    expect(nativeHears(small, 'ru')).toBe(true);
    expect(nativeHears(small, 'auto')).toBe(false);
    expect(nativePicked({ model: 'qwen3-asr-0.6b-q8' }, 'auto')).toBeNull();
    const config = buildLocalAI(SPEAKER, settings({ ...NATIVE, asrNativeModel: 'qwen3-asr-0.6b-q8' }), shared);
    expect(config).toMatchObject({ device: { modelId: 'qwen3-asr-0.6b-q8', streaming: true, native: { model: 'qwen3-asr-0.6b-q8', limits: { rollAfter: 8 } } } });
  });
});

describe('the native recognizer, language by language', () => {
  it('is the one chosen for a language; else the one in use, where it hears it; else none', () => {
    const pick = { model: 'r2t2-q8', byLanguage: { ru: 'qwen3-asr-1.7b-q8' } };
    expect(nativePicked(pick, 'ru')?.id).toBe('qwen3-asr-1.7b-q8');
    expect(nativePicked(pick, 'ja-JP')?.id).toBe('r2t2-q8');
    expect(nativePicked(pick, 'th')).toBeNull();
    // A name the app no longer has, or one that does not hear the language after all, is no choice.
    expect(nativePicked({ model: 'r2t2-q8', byLanguage: { ja: 'gone' } }, 'ja')?.id).toBe('r2t2-q8');
    expect(nativePicked({ model: 'qwen3-asr-1.7b-q8', byLanguage: { th: 'r2t2-q8' } }, 'th')?.id).toBe('qwen3-asr-1.7b-q8');
  });

  it('remembers a choice for the languages it was made for, and leaves the other language heard as it was', () => {
    // Japanese by the Mac's own recognition; Russian has none, and Qwen3-ASR is chosen for it.
    const before = { model: `${APPLE_PREFIX}ja`, byLanguage: {} };
    expect(nativePicked(before, 'ru')).toBeNull();
    const after = chooseNative(before, 'qwen3-asr-1.7b-q8', ['ru'], ['ja', 'ru']);
    expect(after).toEqual({ model: 'qwen3-asr-1.7b-q8', byLanguage: { ja: `${APPLE_PREFIX}ja`, ru: 'qwen3-asr-1.7b-q8' } });
    expect(nativePicked(after, 'ja')?.id).toBe(`${APPLE_PREFIX}ja`);
    // A language met later, with no choice of its own, follows the one in use — it hears Korean.
    expect(nativePicked(after, 'ko')?.id).toBe('qwen3-asr-1.7b-q8');
    // The system's recognition chosen for a language is that language's model of it.
    expect(chooseNative(after, `${APPLE_PREFIX}ja`, ['ko'], ['ko']).byLanguage.ko).toBe(`${APPLE_PREFIX}ko`);
    // Chosen for a language it does not hear, nothing is written for that language.
    expect(chooseNative({ model: 'qwen3-asr-1.7b-q8' }, 'r2t2-q8', ['th', 'ja'], ['th', 'ja']).byLanguage).toEqual({ ja: 'r2t2-q8' });
  });

  it('is kept across a restart as a map of language to model, and nothing else', () => {
    const kept = migrateLocalAISettings({ asrNativeByLanguage: { ru: 'qwen3-asr-1.7b-q8', ja: 7, ko: '' } }, { legacy: {}, credentials: {} });
    expect(kept.asrNativeByLanguage).toEqual({ ru: 'qwen3-asr-1.7b-q8' });
    expect(migrateLocalAISettings({ asrNativeByLanguage: ['x'] }, { legacy: {}, credentials: {} }).asrNativeByLanguage).toEqual({});
    expect(LOCALAI_DEFAULTS.asrNativeByLanguage).toEqual({});
  });
});

describe('the other side\u2019s language left to be detected', () => {
  const PARTICIPANT: SessionContext = { direction: { source: 'zh-CN', target: 'ja' }, speech: false, turns: 'auto' };
  const DETECT: Partial<LocalAISettings> = { ...NATIVE, asrNativeModel: 'qwen3-asr-1.7b-q8', asrDetectOther: true, translateAt: 'device', translateHere: 'native', translateNativeModel: 'index-translate-2b' };

  it('counts only where what hears can detect a language: the native engine, or an API', () => {
    expect(LOCALAI_DEFAULTS.asrDetectOther).toBe(false);
    expect(detectsOther(settings(DETECT))).toBe(true);
    expect(detectsOther(settings({ ...DETECT, asrVia: 'api' }))).toBe(true);
    expect(detectsOther(settings({ ...DETECT, asrHere: 'app' }))).toBe(false);
    expect(detectsOther(settings({ ...DETECT, asrVia: 'server' }))).toBe(false);
    expect(detectsOther(settings({ ...DETECT, asrDetectOther: false }))).toBe(false);
    expect(migrateLocalAISettings({ asrDetectOther: true }, { legacy: {}, credentials: {} }).asrDetectOther).toBe(true);
    expect(localaiProvider.checkReads).toContain('asrDetectOther');
  });

  it('leaves the speaker\u2019s own language as chosen: only the other side\u2019s is detected', () => {
    const pair = { source: 'zh-CN', target: 'ja' };
    expect(heardBy(settings(DETECT), pair, 'speaker')).toBe('zh-CN');
    expect(heardBy(settings(DETECT), pair, 'participant')).toBe('auto');
    expect(heardBy(settings({ ...DETECT, asrDetectOther: false }), pair, 'participant')).toBe('ja');
    // A coached speaker is heard in the language they practise, detected or not.
    expect(heardBy(settings({ ...DETECT, coach: true }), pair, 'speaker')).toBe('ja');
  });

  it('is heard by a native model that detects one, and by no other', () => {
    expect(nativePicked({ model: 'qwen3-asr-1.7b-q8' }, 'auto')?.id).toBe('qwen3-asr-1.7b-q8');
    expect(nativePicked({ model: 'r2t2-q8' }, 'auto')).toBeNull();
    expect(nativePicked({ model: `${APPLE_PREFIX}ja` }, 'auto')).toBeNull();
    // Chosen for it by name, as for any language.
    expect(nativePicked({ model: 'r2t2-q8', byLanguage: { auto: 'qwen3-asr-1.7b-q8' } }, 'auto')?.id).toBe('qwen3-asr-1.7b-q8');
    expect(chooseNative({ model: 'r2t2-q8' }, 'qwen3-asr-1.7b-q8', ['auto'], ['ja', 'auto']).byLanguage).toEqual({ ja: 'r2t2-q8', auto: 'qwen3-asr-1.7b-q8' });
  });

  it('builds the other side\u2019s leg with no language to hear, and a translation that is told no source', () => {
    // The pair is Chinese → Japanese: the other side's leg is its reverse, and `reversed` says so.
    const other = { ...PARTICIPANT, direction: { source: 'ja', target: 'zh-CN' } };
    const reversed = { ...shared, reversed: (d: SessionContext['direction']) => d.target === 'zh-CN' };
    const config = buildLocalAI(other, settings(DETECT), reversed);
    if ('refused' in config) throw new Error(config.refused);
    expect(config.device).toMatchObject({ modelId: 'qwen3-asr-1.7b-q8', native: { model: 'qwen3-asr-1.7b-q8' } });
    expect(config.stages).toMatchObject({ heard: 'auto', speech: { kind: 'translate', model: 'index-translate-2b' } });
    const wrap = (config.stages?.speech as { wrap?: string }).wrap ?? '';
    expect(wrap).toContain('请将以下文本翻译为中文');
    expect(wrap).not.toContain('日语');
    // The speaker's own leg is built as ever.
    const mine = buildLocalAI(PARTICIPANT, settings(DETECT), reversed);
    if ('refused' in mine) throw new Error(mine.refused);
    expect(mine.stages?.heard).toBeUndefined();
    expect((mine.stages?.speech as { wrap?: string }).wrap).toContain('请将以下中文文本翻译为日语');
  });

  it('is refused in words of its own where the model in use does not detect, or the translation has to be told the pair', () => {
    const other = { ...PARTICIPANT, direction: { source: 'ja', target: 'zh-CN' } };
    const reversed = { ...shared, reversed: (d: SessionContext['direction']) => d.target === 'zh-CN' };
    expect(buildLocalAI(other, settings({ ...DETECT, asrNativeModel: 'r2t2-q8' }), reversed)).toMatchObject({ code: 'native_unchosen', params: { source: 'auto' } });
    expect(buildLocalAI(other, settings({ ...DETECT, translateHere: 'app' }), reversed)).toMatchObject({ code: 'source_auto' });
  });

  it('asks the engine for a model that detects, for the other side\u2019s leg', async () => {
    const gap = vi.fn(async () => null);
    const check = vi.fn(async () => ({ ok: true as const }));
    await checkLocalAIWithNative(NONE, settings(DETECT), { pair: PAIR, legs: ['speaker', 'participant'] }, check, { gap, idle: vi.fn(), translatorGap: vi.fn(async () => null), translatorIdle: vi.fn(), coachGap: vi.fn(async () => null), coachIdle: vi.fn() });
    expect(gap).toHaveBeenCalledWith({ model: 'qwen3-asr-1.7b-q8', byLanguage: {} }, ['ja', 'auto']);
  });
});

describe('the system recognizer of a Mac, one model to a language', () => {
  const APPLE: NativeEngineStatus = {
    supported: true,
    engine: 'ready',
    engineBytes: 0,
    models: { [`${APPLE_PREFIX}ja`]: { state: 'downloaded', received: 0, total: 0 }, [`${APPLE_PREFIX}zh`]: { state: 'absent', received: 0, total: 0 } },
    run: { state: 'stopped', model: null, port: 0, tail: '' },
    up: [],
  };
  const asked = (status: NativeEngineStatus, heard: string[]) => ({ gap: nativeGap(`${APPLE_PREFIX}ja`, heard, { status: async () => status }) });

  it('is named once, and resolved to the model of the language each leg hears', () => {
    expect(nativeModelFor(`${APPLE_PREFIX}ja`, 'ja')?.id).toBe(`${APPLE_PREFIX}ja`);
    expect(nativeModelFor(`${APPLE_PREFIX}ja`, 'zh-CN')?.id).toBe(`${APPLE_PREFIX}zh`);
    expect(nativeModelFor(`${APPLE_PREFIX}ja`, 'ru')).toBeNull();
    // Another engine's model is the same for every language it hears.
    expect(nativeModelFor('r2t2-q8', 'zh-CN')?.id).toBe('r2t2-q8');
    expect(nativeModelFor('r2t2-q8', 'th')).toBeNull();
    expect(nativeModel(`${APPLE_PREFIX}ja`).limits).toMatchObject({ rollAfter: 10, rollAt: 20 });
  });

  it('builds each leg with the model of its own language, and its own limits on how long a recognition runs', () => {
    const speaker = buildLocalAI(SPEAKER, settings({ ...NATIVE, asrNativeModel: `${APPLE_PREFIX}ja` }), shared);
    if ('refused' in speaker) throw new Error(speaker.refused);
    expect(speaker.device).toMatchObject({ modelId: `${APPLE_PREFIX}ja`, native: { model: `${APPLE_PREFIX}ja`, limits: { rollAfter: 10 } } });
    const participant = buildLocalAI({ ...SPEAKER, direction: { source: 'zh-CN', target: 'ja' } }, settings({ ...NATIVE, asrNativeModel: `${APPLE_PREFIX}ja` }), shared);
    if ('refused' in participant) throw new Error(participant.refused);
    expect(participant.device).toMatchObject({ modelId: `${APPLE_PREFIX}zh`, native: { model: `${APPLE_PREFIX}zh` } });
  });

  it('needs the language of every leg installed, and names the one that is not', async () => {
    expect(await asked(APPLE, ['ja', 'zh-CN']).gap).toMatchObject({ ok: false, code: 'native_missing' });
    expect(await asked(APPLE, ['ja', 'ru']).gap).toMatchObject({ ok: false, code: 'native_unchosen', params: { source: 'ru' } });
  });

  it('can start with its languages installed, up or not — and one start brings it up for every language of its own', async () => {
    expect(await asked(APPLE, ['ja']).gap).toBeNull();
    const both: NativeEngineStatus = { ...APPLE, models: { ...APPLE.models, [`${APPLE_PREFIX}zh`]: { state: 'downloaded', received: 0, total: 0 } }, run: { state: 'ready', model: `${APPLE_PREFIX}ja`, port: 0, tail: '' } };
    expect(await asked(both, ['ja', 'zh-CN']).gap).toBeNull();
    const start = vi.fn(async () => both);
    await nativeUp(`${APPLE_PREFIX}ja`, ['ja', 'zh-CN'], { start });
    expect(start.mock.calls).toEqual([[`${APPLE_PREFIX}ja`]]);
    expect(nativeReady(both, `${APPLE_PREFIX}zh`)).toBe(true);
    expect(nativeReady(both, 'r2t2-q8')).toBe(false);
  });
});

describe('whether a run that hears by the engine can start', () => {
  const asked = (status: NativeEngineStatus, heard: string[] = ['ja']) => ({ gap: nativeGap('r2t2-q8', heard, { status: async () => status }) });

  it('can with its model downloaded: the engine does not have to be up, and the check does not bring it up', async () => {
    expect(await asked(READY).gap).toBeNull();
    expect(await asked(engine()).gap).toBeNull();
    expect(await asked(engine({ run: { state: 'warming', model: 'r2t2-q8', port: 4100, tail: '' } })).gap).toBeNull();
    expect(nativeReady(READY, 'r2t2-q8')).toBe(true);
    expect(nativeReady(engine(), 'r2t2-q8')).toBe(false);
    expect(nativeDownloaded(READY, 'r2t2-q8')).toBe(true);
    // Nothing is asked of the engine but its state.
    const start = vi.spyOn(useNativeEngineStore.getState(), 'start');
    await nativeGap('r2t2-q8', ['ja'], { status: async () => engine() });
    expect(start).not.toHaveBeenCalled();
    start.mockRestore();
  });

  it('cannot where the system has no engine, or the model is not downloaded', async () => {
    expect(await asked(NO_NATIVE_ENGINE).gap).toMatchObject({ ok: false, code: 'native_unsupported' });
    const absent = asked(engine({ models: { 'r2t2-q8': { state: 'absent', received: 0, total: 2477512064 } } }));
    expect(await absent.gap).toMatchObject({ ok: false, code: 'native_missing', params: { name: 'Confucius4 R2T2 GGUF' } });
    expect(await asked(engine({ engine: 'absent' })).gap).toMatchObject({ ok: false, code: 'native_missing' });
  });

  it('cannot for a language the model does not hear', async () => {
    expect(await asked(READY, ['ja', 'th']).gap).toMatchObject({ ok: false, code: 'native_unchosen', params: { source: 'th' } });
  });

  it('cannot with two models of the engine the app downloads: it runs one at a time', async () => {
    const both = engine({ models: { 'r2t2-q8': { state: 'downloaded', received: 1, total: 1 }, 'qwen3-asr-1.7b-q8': { state: 'downloaded', received: 1, total: 1 } } });
    const gap = await nativeGap({ model: 'r2t2-q8', byLanguage: { zh: 'qwen3-asr-1.7b-q8' } }, ['ja', 'zh-CN'], { status: async () => both });
    expect(gap).toMatchObject({ ok: false, code: 'native_two_models', params: { name: 'Confucius4 R2T2 GGUF', other: 'Qwen3-ASR 1.7B GGUF' } });
  });

  it('can with the system\u2019s recognition for one language and the downloaded engine for another', async () => {
    const models = { [`${APPLE_PREFIX}zh`]: { state: 'downloaded' as const, received: 0, total: 0 }, 'qwen3-asr-1.7b-q8': { state: 'downloaded' as const, received: 1, total: 1 } };
    const pick = { model: `${APPLE_PREFIX}zh`, byLanguage: { ru: 'qwen3-asr-1.7b-q8' } };
    expect(await nativeGap(pick, ['zh-CN', 'ru'], { status: async () => engine({ models }) })).toBeNull();
  });

  it('says a start that failed, and does not try it again by itself', async () => {
    const failed = asked(engine({ run: { state: 'failed', model: 'r2t2-q8', port: 0, tail: 'loading\nno vulkan device' } }));
    expect(await failed.gap).toMatchObject({ ok: false, code: 'native_failed', reason: expect.stringContaining('no vulkan device') });
  });
});

describe('the engines a run brings up', () => {
  it('are started when the run begins, and waited for', async () => {
    let up: (status: NativeEngineStatus) => void = () => {};
    const start = vi.fn(() => new Promise<NativeEngineStatus>((resolve) => { up = resolve; }));
    let done = false;
    const coming = nativeUp('r2t2-q8', ['ja'], { start }).then(() => { done = true; });
    await Promise.resolve();
    expect(start.mock.calls).toEqual([['r2t2-q8']]);
    expect(done).toBe(false);
    up(READY);
    await coming;
    expect(done).toBe(true);
  });

  it('are each started once: the system\u2019s recognition, and the engine the app downloads', async () => {
    const models = { [`${APPLE_PREFIX}zh`]: { state: 'downloaded' as const, received: 0, total: 0 }, [`${APPLE_PREFIX}ja`]: { state: 'downloaded' as const, received: 0, total: 0 }, 'qwen3-asr-1.7b-q8': { state: 'downloaded' as const, received: 1, total: 1 } };
    const up = engine({ models, run: { state: 'ready', model: `${APPLE_PREFIX}zh`, port: 0, tail: '' }, up: [`${APPLE_PREFIX}zh`, 'qwen3-asr-1.7b-q8'] });
    const start = vi.fn(async (_id: string) => up);
    await nativeUp({ model: `${APPLE_PREFIX}zh`, byLanguage: { ru: 'qwen3-asr-1.7b-q8' } }, ['zh-CN', 'ja', 'ru'], { start });
    expect(start.mock.calls.map((call) => call[0])).toEqual([`${APPLE_PREFIX}zh`, 'qwen3-asr-1.7b-q8']);
  });

  it('end the start in words of their own when one does not come up', async () => {
    const failed = engine({ run: { state: 'failed', model: 'r2t2-q8', port: 0, tail: 'loading\nno vulkan device' } });
    const refused = await nativeUp('r2t2-q8', ['ja'], { start: async () => failed }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(AdapterStartError);
    expect(refused).toMatchObject({ code: 'native_failed', message: expect.stringContaining('no vulkan device') });
    const translator = await translatorUp('index-translate-2b', { start: async () => engine({ models: {}, run: { state: 'failed', model: 'index-translate-2b', port: 0, tail: 'out of memory' } }) }).catch((error: unknown) => error);
    expect(translator).toMatchObject({ code: 'native_translator_failed' });
  });
});

describe('the engines at rest', () => {
  const fake = () => {
    let fire: (() => void) | null = null;
    const stop = { asr: vi.fn(), translation: vi.fn(), coach: vi.fn() };
    const set = vi.fn((run: () => void, ms: number) => { fire = run; return ms as unknown as ReturnType<typeof setTimeout>; });
    const clear = vi.fn(() => { fire = null; });
    return { stop, set, clear, deps: { stop, setTimer: set, clearTimer: clear }, pass: () => { const run = fire; fire = null; run?.(); }, waiting: () => fire !== null };
  };

  it('give their memory back a minute after the last run ends, and not before', () => {
    const t = fake();
    const done = holdNativeForRun(t.deps);
    expect(t.waiting()).toBe(false);
    done();
    expect(t.set).toHaveBeenLastCalledWith(expect.any(Function), 60_000);
    expect(t.stop.asr).not.toHaveBeenCalled();
    t.pass();
    expect(t.stop.asr).toHaveBeenCalledTimes(1);
    expect(t.stop.translation).toHaveBeenCalledTimes(1);
    expect(t.stop.coach).toHaveBeenCalledTimes(1);
    // Let go once: a second call of the same release is nothing.
    done();
    expect(t.waiting()).toBe(false);
  });

  it('stay up when a run begins again within the minute, and while either of two legs is open', () => {
    const t = fake();
    const first = holdNativeForRun(t.deps);
    first();
    const again = holdNativeForRun(t.deps);
    t.pass();
    expect(t.stop.asr).not.toHaveBeenCalled();
    const other = holdNativeForRun(t.deps);
    again();
    t.pass();
    expect(t.stop.asr).not.toHaveBeenCalled();
    other();
    t.pass();
    expect(t.stop.asr).toHaveBeenCalledTimes(1);
  });

  it('are not taken from a device that is listening or translating through one', () => {
    const t = fake();
    const listening = holdNative('asr', t.deps);
    restNative(t.deps);
    t.pass();
    expect(t.stop.asr).not.toHaveBeenCalled();
    expect(t.stop.translation).toHaveBeenCalledTimes(1);
    expect(t.stop.coach).toHaveBeenCalledTimes(1);
    listening();
    t.pass();
    expect(t.stop.asr).toHaveBeenCalledTimes(1);
  });

  it('are not stopped by the check while a run is open, whatever the settings say meanwhile', () => {
    const t = fake();
    const stop = vi.fn();
    useNativeEngineStore.setState({ status: READY, asked: true });
    const done = holdNativeForRun(t.deps);
    nativeIdle({ stop });
    expect(stop).not.toHaveBeenCalled();
    done();
    nativeIdle({ stop });
    expect(stop).toHaveBeenCalledTimes(1);
    useNativeEngineStore.setState({ status: NO_NATIVE_ENGINE });
  });

  it('stop only what is up, by the stores, when nothing else is said', () => {
    vi.useFakeTimers();
    try {
      const stops = [useNativeEngineStore, useNativeTranslatorStore, useNativeCoachStore].map((store) => vi.spyOn(store.getState(), 'stop').mockResolvedValue(undefined));
      useNativeEngineStore.setState({ status: READY });
      useNativeTranslatorStore.setState({ status: engine({ models: {} }) });
      useNativeCoachStore.setState({ status: engine({ models: {} }) });
      restNative();
      vi.advanceTimersByTime(59_000);
      expect(stops[0]).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1_000);
      expect(stops.map((stop) => stop.mock.calls.length)).toEqual([1, 0, 0]);
      for (const stop of stops) stop.mockRestore();
      useNativeEngineStore.setState({ status: NO_NATIVE_ENGINE });
      useNativeTranslatorStore.setState({ status: NO_NATIVE_ENGINE });
      useNativeCoachStore.setState({ status: NO_NATIVE_ENGINE });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a run\u2019s first step', () => {
  const ups = (): NativeUps & { [K in keyof NativeUps]: ReturnType<typeof vi.fn> } => ({ hears: vi.fn(async () => undefined), translates: vi.fn(async () => undefined), coaches: vi.fn(async () => undefined), rest: vi.fn() }) as never;
  const BOTH = { pair: PAIR, legs: ['speaker', 'participant'] as const };
  const ALL: Partial<LocalAISettings> = { ...NATIVE, translateAt: 'device', translateHere: 'native', translateNativeModel: 'index-translate-2b', coach: true, coachAt: 'device', coachHere: 'native', coachNativeModel: 'gemma-4-e2b' };

  it('brings up the engines the run needs, side by side, and waits for all of them', async () => {
    const u = ups();
    let heard: () => void = () => {};
    u.hears.mockImplementation(() => new Promise<void>((resolve) => { heard = resolve; }));
    let done = false;
    const preparing = prepareLocalAI(BOTH, settings(ALL), u).then(() => { done = true; });
    await Promise.resolve();
    await Promise.resolve();
    // A coached speaker is heard in the language they practise; the other side in its own.
    expect(u.hears).toHaveBeenCalledWith({ model: 'r2t2-q8', byLanguage: {} }, ['zh-CN', 'zh-CN']);
    expect(u.translates).toHaveBeenCalledWith('index-translate-2b');
    expect(u.coaches).toHaveBeenCalledWith('gemma-4-e2b');
    expect(done).toBe(false);
    heard();
    await preparing;
    expect(done).toBe(true);
    // Let go again a minute on if the run never opens: a run that opens holds them.
    expect(u.rest).toHaveBeenCalledTimes(1);
  });

  it('brings up only what the stages name, and nothing where none is the engine\u2019s', async () => {
    const hearing = ups();
    await prepareLocalAI(BOTH, settings(NATIVE), hearing);
    expect(hearing.hears).toHaveBeenCalledWith({ model: 'r2t2-q8', byLanguage: {} }, ['ja', 'zh-CN']);
    expect(hearing.translates).not.toHaveBeenCalled();
    expect(hearing.coaches).not.toHaveBeenCalled();
    const none = ups();
    await prepareLocalAI(BOTH, settings({ asrVia: 'api' }), none);
    expect(none.hears).not.toHaveBeenCalled();
    expect(none.rest).not.toHaveBeenCalled();
    // The feedback is the speaker's: a run of the other side alone does not load it.
    const other = ups();
    await prepareLocalAI({ pair: PAIR, legs: ['participant'] }, settings(ALL), other);
    expect(other.coaches).not.toHaveBeenCalled();
    expect(other.hears).toHaveBeenCalledWith({ model: 'r2t2-q8', byLanguage: {} }, ['zh-CN']);
  });

  it('ends the start with the engine\u2019s own notice when one does not come up, and still lets the others go', async () => {
    const u = ups();
    u.translates.mockRejectedValue(new AdapterStartError('The engine could not start: out of memory', 'native_translator_failed'));
    await expect(prepareLocalAI(BOTH, settings(ALL), u)).rejects.toMatchObject({ code: 'native_translator_failed' });
    expect(u.rest).toHaveBeenCalledTimes(1);
  });

  it('is the provider\u2019s, before anything is built', () => {
    expect(localaiProvider.session?.prepare).toBeTypeOf('function');
  });

  it('is done once, ahead of time, for a start in the background: with what the check next says the settings need', async () => {
    const u = ups();
    primeNativeOnce(u);
    // Nothing is known yet of what to load, or it is what the check last saw: either way the next check settles it.
    await checkLocalAIWithNative(NONE, settings(NATIVE), CTX, async () => ({ ok: true as const }), { gap: async () => null, idle: () => undefined });
    await Promise.resolve();
    await Promise.resolve();
    primeNativeOnce(u);
    await Promise.resolve();
    await Promise.resolve();
    expect(u.hears).toHaveBeenCalledWith({ model: 'r2t2-q8', byLanguage: {} }, ['ja']);
    expect(u.rest).toHaveBeenCalled();
  });
});

describe('the provider\'s check, with the engine', () => {
  const OK: CheckResult = { ok: true, models: [{ id: 'some-model' }] };

  it('lets the engine rest when it does not hear, and asks nothing of it', async () => {
    const gap = vi.fn(async () => null);
    const idle = vi.fn();
    const check = vi.fn(async () => OK);
    expect(await checkLocalAIWithNative(NONE, settings({ asrVia: 'api' }), CTX, check, { gap, idle })).toBe(OK);
    expect(idle).toHaveBeenCalledTimes(1);
    expect(gap).not.toHaveBeenCalled();
  });

  it('says "not chosen", not "not downloaded", where the app\u2019s own models hear nothing and one of the engine\u2019s is on the computer', async () => {
    const none: CheckResult = { ok: false, reason: 'No speech recognition model is downloaded for ja.', code: 'no_asr', params: { source: 'ja' } };
    const deps = { gap: vi.fn(async () => null), idle: vi.fn() };
    const here = { asrVia: 'device' as const, asrHere: 'app' as const };
    expect(await checkLocalAIWithNative(NONE, settings(here), CTX, vi.fn(async () => none), { ...deps, waits: (language: string) => language === 'ja' })).toMatchObject({ ok: false, code: 'native_unchosen', params: { source: 'ja' } });
    // Nothing of the engine's either: it is as it was.
    expect(await checkLocalAIWithNative(NONE, settings(here), CTX, vi.fn(async () => none), { ...deps, waits: () => false })).toBe(none);
    // And the question itself: a downloaded model that hears the language, with the runtime that runs it.
    expect(nativeWaits('ja', READY)).toBe(true);
    expect(nativeWaits('zh-CN', READY)).toBe(true);
    expect(nativeWaits('th', READY)).toBe(false);
    expect(nativeWaits('ja', engine({ engine: 'absent' }))).toBe(false);
    expect(nativeWaits('ja', engine({ models: { 'r2t2-q8': { state: 'absent', received: 0, total: 1 } } }))).toBe(false);
  });

  it('asks the engine for the language each leg hears, and passes when both it and the servers do', async () => {
    const gap = vi.fn(async () => null);
    const idle = vi.fn();
    const check = vi.fn(async () => OK);
    expect(await checkLocalAIWithNative(NONE, settings(NATIVE), { pair: PAIR, legs: ['speaker', 'participant'] }, check, { gap, idle })).toBe(OK);
    expect(gap).toHaveBeenCalledWith({ model: 'r2t2-q8', byLanguage: {} }, ['ja', 'zh-CN']);
    expect(idle).not.toHaveBeenCalled();
    // A coached speaker speaks the target language.
    await checkLocalAIWithNative(NONE, settings({ ...NATIVE, coach: true }), CTX, check, { gap, idle });
    expect(gap).toHaveBeenLastCalledWith({ model: 'r2t2-q8', byLanguage: {} }, ['zh-CN']);
  });

  it('refuses in the engine\'s words, with what the servers listed', async () => {
    const refusal = { ok: false as const, reason: 'The native recognition engine could not start: no vulkan device', code: 'native_failed' };
    const result = await checkLocalAIWithNative(NONE, settings(NATIVE), CTX, async () => OK, { gap: async () => refusal, idle: () => undefined });
    expect(result).toEqual({ ...refusal, models: OK.models });
  });

  it('refuses in the servers\' words first', async () => {
    const gap = vi.fn(async () => ({ ok: false as const, reason: 'not downloaded', code: 'native_missing' }));
    const refused: CheckResult = { ok: false, reason: 'The server refused the key.', code: 'api_key_refused' };
    expect(await checkLocalAIWithNative(NONE, settings(NATIVE), CTX, async () => refused, { gap, idle: () => undefined })).toBe(refused);
    expect(gap).toHaveBeenCalledTimes(1);
  });

  it('is told of the engine\'s model among what decides the check', () => {
    expect(localaiProvider.checkReads).toContain('asrNativeModel');
    expect(localaiProvider.checkReads).toContain('asrHere');
  });
});

// Review of 6c76dd6 (REVIEW-engine-lifecycle.md): what the minute's rest must not take from a run that is starting.
// Both fail on 6c76dd6: nothing holds the engines between a run's first step and its legs' own holds.
describe('the engines a starting run loads, against the minute’s rest (review)', () => {
  it('are not stopped by a rest that comes due while the run’s first step is still loading them (F1)', async () => {
    vi.useFakeTimers();
    const stop = { asr: vi.fn(), translation: vi.fn(), coach: vi.fn() };
    const timer: { fire: (() => void) | null } = { fire: null };
    const deps = { stop, setTimer: (run: () => void) => { timer.fire = run; return 0 as unknown as ReturnType<typeof setTimeout>; }, clearTimer: () => { timer.fire = null; } };
    let loaded: () => void = () => {};
    try {
      // The last run ended a little under a minute ago: its rest is due soon.
      holdNativeForRun(deps)();
      const due = timer.fire;
      expect(due).not.toBeNull();
      // Start is pressed with another model chosen, which takes longer to load than what is left of the minute.
      const u: NativeUps = { hears: vi.fn(() => new Promise<void>((resolve) => { loaded = resolve; })), translates: vi.fn(async () => undefined), coaches: vi.fn(async () => undefined), rest: vi.fn() };
      const preparing = prepareLocalAI({ pair: PAIR, legs: ['speaker'] }, settings(NATIVE), u);
      await Promise.resolve();
      expect(u.hears).toHaveBeenCalled();
      due!();
      // The engine this run is waiting for is not stopped under it.
      expect(stop.asr).not.toHaveBeenCalled();
      loaded();
      await preparing;
    } finally {
      loaded();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('stay held from the run’s first step until the run ends, whether or not a leg ever opens (F2)', async () => {
    useNativeEngineStore.setState({ status: READY, asked: true });
    const start = vi.spyOn(useNativeEngineStore.getState(), 'start').mockResolvedValue(READY);
    const stop = vi.spyOn(useNativeEngineStore.getState(), 'stop').mockResolvedValue(undefined);
    vi.useFakeTimers();
    const run = new AbortController();
    try {
      await localaiProvider.session!.prepare!({ pair: PAIR, legs: ['speaker'] } as never, settings(NATIVE), run.signal);
      expect(start).toHaveBeenCalledWith('r2t2-q8');
      // A minute goes by before any leg takes its hold: a slow source, a picker left open. The translation and the
      // feedback were built with these engines' addresses: stopping them now breaks the run that is about to open.
      vi.advanceTimersByTime(61_000);
      expect(stop).not.toHaveBeenCalled();
      // The run ends without a leg ever opening (a build or admit refusal, a source that failed): let go a minute later.
      run.abort();
      vi.advanceTimersByTime(61_000);
      expect(stop).toHaveBeenCalledTimes(1);
    } finally {
      run.abort();
      vi.clearAllTimers();
      vi.useRealTimers();
      start.mockRestore();
      stop.mockRestore();
      useNativeEngineStore.setState({ status: NO_NATIVE_ENGINE });
    }
  });
});

describe('a run and a device that want different models of one engine', () => {
  const QUIET = { stop: { asr() {}, translation() {}, coach() {} }, setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>, clearTimer: () => {} };

  it('ends the run\u2019s start with the model the device is using, and starts nothing under it', async () => {
    useNativeEngineStore.setState({ status: engine({ models: { 'r2t2-q8': { state: 'downloaded', received: 1, total: 1 }, 'qwen3-asr-1.7b-q8': { state: 'downloaded', received: 1, total: 1 } }, run: { state: 'ready', model: 'qwen3-asr-1.7b-q8', port: 4100, tail: '' }, up: ['qwen3-asr-1.7b-q8'] }), asked: true });
    const device = holdNative('asr', QUIET);
    const start = vi.fn(async (_id: string) => READY);
    try {
      await expect(nativeUp('r2t2-q8', ['ja'], { start })).rejects.toMatchObject({ code: 'native_busy', params: { name: 'Qwen3-ASR 1.7B GGUF' } });
      expect(start).not.toHaveBeenCalled();
    } finally {
      device();
    }
    // The device is done: the run's own model is started.
    await nativeUp('r2t2-q8', ['ja'], { start });
    expect(start).toHaveBeenCalledWith('r2t2-q8');
    useNativeEngineStore.setState({ status: NO_NATIVE_ENGINE });
  });

  it('tells a start that was interrupted apart from one that failed', async () => {
    const stopped = engine();
    const failed = engine({ run: { state: 'failed', model: 'r2t2-q8', port: 0, tail: 'no vulkan device' } });
    await expect(nativeUp('r2t2-q8', ['ja'], { start: async () => stopped })).rejects.toMatchObject({ code: 'native_interrupted' });
    await expect(nativeUp('r2t2-q8', ['ja'], { start: async () => failed })).rejects.toMatchObject({ code: 'native_failed' });
    // Up, but with another model: the same as stopped, to the one who asked for this one.
    const other = engine({ run: { state: 'ready', model: 'qwen3-asr-1.7b-q8', port: 4100, tail: '' }, up: ['qwen3-asr-1.7b-q8'] });
    await expect(nativeUp('r2t2-q8', ['ja'], { start: async () => other })).rejects.toMatchObject({ code: 'native_interrupted' });
  });
});
