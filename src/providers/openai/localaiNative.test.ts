// Fork: on this computer, hearing can be the native engine's — a runtime the app downloads and runs beside itself.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionContext } from '../../lib/contract/adapter';
import { NO_NATIVE_ENGINE, nativeEngineStatus, nativeStreamEvent, type NativeEngineStatus } from '../../lib/native/nativeEngine';
import type { CheckContext, CheckResult } from '../../lib/provider/types';
import { useModelStore } from '../../stores/modelStore';
import { buildLocalAI, admitLocalAI, checkLocalAIWithNative, describeLocalAI, localaiProvider, LOCALAI_DEFAULTS, migrateLocalAISettings, type LocalAICredentials, type LocalAISettings } from './localai';
import { cutsSentencesHere, deviceChoices, deviceNeeds, hearsByLocalServer, hearsNatively } from './localaiDevice';
import type { LocalAIModel } from './localaiModels';
import { APPLE_PREFIX, NATIVE_DEFAULT_MODEL, nativeDownloaded, nativeGap, nativeHears, nativeModel, nativeModelFor, nativeReady } from './localaiNative';
import { SHARED } from './testing';

const SPEAKER: SessionContext = { direction: { source: 'ja', target: 'zh-CN' }, speech: false, turns: 'auto' };
const PAIR = { source: 'ja', target: 'zh-CN' };
const CTX: CheckContext = { pair: PAIR, legs: ['speaker'] };
const shared = { ...SHARED, reversed: (d: SessionContext['direction']) => d.source !== 'ja', models: [] as LocalAIModel[] };
const settings = (patch: Partial<LocalAISettings> = {}): LocalAISettings => ({ ...LOCALAI_DEFAULTS, ...patch });
const NONE: LocalAICredentials = { apiKey: '', endpoint: '' };
const NATIVE: Partial<LocalAISettings> = { asrVia: 'device', asrHere: 'native', translateAt: 'api', translateBaseUrl: 'https://api.example.com/v1', translateModel: 'some-model', translateNeedsKey: false };

const engine = (patch: Partial<NativeEngineStatus> = {}): NativeEngineStatus => ({
  supported: true,
  engine: 'ready',
  engineBytes: 60_000_000,
  models: { 'r2t2-q8': { state: 'downloaded', received: 2477512064, total: 2477512064 } },
  run: { state: 'stopped', model: null, port: 0, tail: '' },
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
    expect(odd).toEqual({ supported: true, engine: 'ready', engineBytes: 0, models: { b: { state: 'failed', received: 0, total: 5, error: 'no disk' } }, run: { state: 'stopped', model: null, port: 0, tail: '' } });
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
  it('is kept as stored, with its model, and is only the hearing stage\'s', () => {
    expect(LOCALAI_DEFAULTS).toMatchObject({ asrHere: 'app', asrNativeModel: NATIVE_DEFAULT_MODEL });
    const kept = migrateLocalAISettings({ asrHere: 'native', asrNativeModel: 'r2t2-q8', coachHere: 'native' }, { legacy: {}, credentials: {} });
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

  it('refuses a language its model does not hear', () => {
    const config = buildLocalAI({ ...SPEAKER, direction: { source: 'th', target: 'zh-CN' } }, settings(NATIVE), shared);
    expect(config).toMatchObject({ refused: expect.stringContaining('th'), code: 'no_asr' });
  });

  it('knows a model by its id, and falls to the first for one it no longer has', () => {
    expect(nativeModel('r2t2-q8').name).toBe('Confucius4 R2T2');
    expect(nativeModel('gone').id).toBe(NATIVE_DEFAULT_MODEL);
    expect(nativeHears(nativeModel('r2t2-q8'), 'zh-CN')).toBe(true);
    expect(nativeHears(nativeModel('r2t2-q8'), 'th')).toBe(false);
  });
});

describe('the system recognizer of a Mac, one model to a language', () => {
  const APPLE: NativeEngineStatus = {
    supported: true,
    engine: 'ready',
    engineBytes: 0,
    models: { [`${APPLE_PREFIX}ja`]: { state: 'downloaded', received: 0, total: 0 }, [`${APPLE_PREFIX}zh`]: { state: 'absent', received: 0, total: 0 } },
    run: { state: 'stopped', model: null, port: 0, tail: '' },
  };
  const asked = (status: NativeEngineStatus, heard: string[]) => {
    const start = vi.fn();
    return { start, gap: nativeGap(`${APPLE_PREFIX}ja`, heard, { status: async () => status, start }) };
  };

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
    expect(await asked(APPLE, ['ja', 'ru']).gap).toMatchObject({ ok: false, code: 'no_asr', params: { source: 'ru' } });
  });

  it('is asked for once and is then ready for every language of its own', async () => {
    const down = asked(APPLE, ['ja']);
    expect(await down.gap).toMatchObject({ ok: false, code: 'native_warming' });
    expect(down.start).toHaveBeenCalledWith(`${APPLE_PREFIX}ja`);
    const both: NativeEngineStatus = { ...APPLE, models: { ...APPLE.models, [`${APPLE_PREFIX}zh`]: { state: 'downloaded', received: 0, total: 0 } }, run: { state: 'ready', model: `${APPLE_PREFIX}ja`, port: 0, tail: '' } };
    expect(await asked(both, ['ja', 'zh-CN']).gap).toBeNull();
    expect(nativeReady(both, `${APPLE_PREFIX}zh`)).toBe(true);
    expect(nativeReady(both, 'r2t2-q8')).toBe(false);
  });
});

describe('whether a run that hears by the engine can start', () => {
  const asked = (status: NativeEngineStatus, heard: string[] = ['ja']) => {
    const start = vi.fn();
    return { start, gap: nativeGap('r2t2-q8', heard, { status: async () => status, start }) };
  };

  it('can, once the engine is up with its model', async () => {
    const { gap, start } = asked(READY);
    expect(await gap).toBeNull();
    expect(start).not.toHaveBeenCalled();
    expect(nativeReady(READY, 'r2t2-q8')).toBe(true);
    expect(nativeDownloaded(READY, 'r2t2-q8')).toBe(true);
  });

  it('cannot where the system has no engine, or the model is not downloaded — and starts nothing', async () => {
    const none = asked(NO_NATIVE_ENGINE);
    expect(await none.gap).toMatchObject({ ok: false, code: 'native_unsupported' });
    const absent = asked(engine({ models: { 'r2t2-q8': { state: 'absent', received: 0, total: 2477512064 } } }));
    expect(await absent.gap).toMatchObject({ ok: false, code: 'native_missing', params: { name: 'Confucius4 R2T2' } });
    const noRuntime = asked(engine({ engine: 'absent' }));
    expect(await noRuntime.gap).toMatchObject({ ok: false, code: 'native_missing' });
    expect(none.start).not.toHaveBeenCalled();
    expect(absent.start).not.toHaveBeenCalled();
  });

  it('cannot for a language the model does not hear', async () => {
    expect(await asked(READY, ['ja', 'th']).gap).toMatchObject({ ok: false, code: 'no_asr', params: { source: 'th' } });
  });

  it('brings the engine up when it is down, and says it is warming until it is ready', async () => {
    const down = asked(engine());
    expect(await down.gap).toMatchObject({ ok: false, code: 'native_warming' });
    expect(down.start).toHaveBeenCalledWith('r2t2-q8');
    // Already coming up: asked nothing more.
    const warming = asked(engine({ run: { state: 'warming', model: 'r2t2-q8', port: 4100, tail: '' } }));
    expect(await warming.gap).toMatchObject({ ok: false, code: 'native_warming' });
    expect(warming.start).not.toHaveBeenCalled();
  });

  it('does not try a failed start again by itself', async () => {
    const failed = asked(engine({ run: { state: 'failed', model: 'r2t2-q8', port: 0, tail: 'loading\nno vulkan device' } }));
    expect(await failed.gap).toMatchObject({ ok: false, code: 'native_failed', reason: expect.stringContaining('no vulkan device') });
    expect(failed.start).not.toHaveBeenCalled();
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

  it('asks the engine for the language each leg hears, and passes when both it and the servers do', async () => {
    const gap = vi.fn(async () => null);
    const idle = vi.fn();
    const check = vi.fn(async () => OK);
    expect(await checkLocalAIWithNative(NONE, settings(NATIVE), { pair: PAIR, legs: ['speaker', 'participant'] }, check, { gap, idle })).toBe(OK);
    expect(gap).toHaveBeenCalledWith('r2t2-q8', ['ja', 'zh-CN']);
    expect(idle).not.toHaveBeenCalled();
    // A coached speaker speaks the target language.
    await checkLocalAIWithNative(NONE, settings({ ...NATIVE, coach: true }), CTX, check, { gap, idle });
    expect(gap).toHaveBeenLastCalledWith('r2t2-q8', ['zh-CN']);
  });

  it('refuses in the engine\'s words, with what the servers listed', async () => {
    const refusal = { ok: false as const, reason: 'The native recognition engine is warming up.', code: 'native_warming' };
    const result = await checkLocalAIWithNative(NONE, settings(NATIVE), CTX, async () => OK, { gap: async () => refusal, idle: () => undefined });
    expect(result).toEqual({ ...refusal, models: OK.models });
  });

  it('refuses in the servers\' words first: the engine is still asked, so that it warms meanwhile', async () => {
    const gap = vi.fn(async () => ({ ok: false as const, reason: 'warming', code: 'native_warming' }));
    const refused: CheckResult = { ok: false, reason: 'The server refused the key.', code: 'api_key_refused' };
    expect(await checkLocalAIWithNative(NONE, settings(NATIVE), CTX, async () => refused, { gap, idle: () => undefined })).toBe(refused);
    expect(gap).toHaveBeenCalledTimes(1);
  });

  it('is told of the engine\'s model among what decides the check', () => {
    expect(localaiProvider.checkReads).toContain('asrNativeModel');
    expect(localaiProvider.checkReads).toContain('asrHere');
  });
});
