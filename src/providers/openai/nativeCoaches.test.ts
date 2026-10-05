// Fork: the native feedback engine as what gives the grammar feedback on this computer.
import { describe, expect, it, vi } from 'vitest';
import type { CheckResult, SessionContext } from '../../lib/provider/types';
import type { NativeEngineStatus } from '../../lib/native/nativeEngine';
import { buildLocalAI, checkLocalAIWithNative, LOCALAI_DEFAULTS, localaiProvider, migrateLocalAISettings, type LocalAISettings } from './localai';
import { coachGap, coachIdle } from './localaiNative';
import { deviceChoices } from './localaiDevice';
import { NATIVE_COACHES, NATIVE_DEFAULT_COACH, nativeCoach } from './nativeCoaches';
import { SHARED } from './testing';
import { useNativeCoachStore } from '../../stores/nativeEngineStore';

const SPEAKER: SessionContext = { direction: { source: 'zh-CN', target: 'ja' }, speech: false, turns: 'auto' };
const shared = { ...SHARED, reversed: (d: SessionContext['direction']) => d.source !== 'zh-CN', models: [] };
// The speaker practises Japanese; what hears and what translates are APIs here, so that only the feedback is this computer's.
const COACHED: Partial<LocalAISettings> = { coach: true, coachAt: 'device', coachHere: 'native', asrVia: 'api', asrApiBaseUrl: 'https://api.example.com/v1', asrApiModel: 'whisper-x', asrApiNeedsKey: false, translateAt: 'api', translateBaseUrl: 'https://api.example.com/v1', translateModel: 'some-model', translateNeedsKey: false };
const settings = (patch: Partial<LocalAISettings> = {}): LocalAISettings => ({ ...LOCALAI_DEFAULTS, ...COACHED, ...patch });

const engine = (patch: Partial<NativeEngineStatus> = {}): NativeEngineStatus => ({
  supported: true,
  engine: 'ready',
  engineBytes: 33_000_000,
  models: { 'gemma-4-e2b': { state: 'downloaded', received: 3106738272, total: 3106738272 } },
  run: { state: 'stopped', model: null, port: 0, tail: '' },
  up: [],
  ...patch,
});
const READY = engine({ run: { state: 'ready', model: 'gemma-4-e2b', port: 4300, tail: '' }, up: ['gemma-4-e2b'] });

describe('the models of the native feedback engine', () => {
  it('are a small chat model that reads any language, and the default for a name the app no longer has', () => {
    expect(NATIVE_COACHES.map((m) => m.id)).toEqual(['gemma-4-e2b']);
    expect(nativeCoach('gone').id).toBe(NATIVE_DEFAULT_COACH);
    expect(nativeCoach('gemma-4-e2b')).toMatchObject({ name: 'Gemma 4 E2B', languages: 'any' });
  });
});

describe('the native feedback engine as what gives the feedback on this computer', () => {
  it('is a third runner of the stage here, kept as stored with its model', () => {
    expect(LOCALAI_DEFAULTS).toMatchObject({ coachHere: 'app', coachNativeModel: NATIVE_DEFAULT_COACH });
    const kept = migrateLocalAISettings({ coachHere: 'native', coachNativeModel: 'gemma-4-e2b' }, { legacy: {}, credentials: {} });
    expect(kept).toMatchObject({ coachHere: 'native', coachNativeModel: 'gemma-4-e2b' });
    expect(localaiProvider.checkReads).toContain('coachNativeModel');
    // None of the app's own models is asked for the feedback then.
    expect(deviceChoices({ ...settings(), selections: {} }).coachAt).toBe('api');
  });

  it('is asked as an API model is, at its address on this computer, with the prompt and its worked examples', () => {
    useNativeCoachStore.setState({ status: READY, asked: true });
    const config = buildLocalAI(SPEAKER, settings(), shared);
    if ('refused' in config) throw new Error(config.refused);
    expect(config.stages?.speech).toMatchObject({ kind: 'coach', baseUrl: 'http://127.0.0.1:4300/v1', model: 'gemma-4-e2b', language: 'zh-CN' });
    const speech = config.stages?.speech as { system: string; shots?: readonly unknown[]; key?: string };
    expect(speech.system).toContain('日语口语教练');
    expect(speech.shots).toHaveLength(7);
    expect(speech.key).toBeUndefined();
    // What the speaker types is still translated, by the stage that translates.
    expect(config.stages?.typed).toMatchObject({ kind: 'translate', model: 'some-model' });
  });
});

describe('whether a run whose feedback the engine gives can start', () => {
  const asked = (status: NativeEngineStatus) => { const start = vi.fn(); return { start, gap: coachGap('gemma-4-e2b', { status: async () => status, start }) }; };

  it('can once its model is downloaded and the engine is up', async () => {
    expect(await asked(READY).gap).toBeNull();
  });

  it('cannot where the engine is not published, or its model is not downloaded, in words of its own', async () => {
    expect(await asked(engine({ supported: false, engine: 'unsupported', models: {} })).gap).toMatchObject({ ok: false, code: 'native_coach_unsupported' });
    const absent = asked(engine({ models: { 'gemma-4-e2b': { state: 'absent', received: 0, total: 3106738272 } } }));
    expect(await absent.gap).toMatchObject({ ok: false, code: 'native_coach_missing', params: { name: 'Gemma 4 E2B' } });
    expect(absent.start).not.toHaveBeenCalled();
  });

  it('brings the engine up when it is down, waits while it comes, and does not try a failed start again by itself', async () => {
    const down = asked(engine());
    expect(await down.gap).toMatchObject({ ok: false, code: 'native_coach_warming' });
    expect(down.start).toHaveBeenCalledWith('gemma-4-e2b');
    const coming = asked(engine({ run: { state: 'warming', model: 'gemma-4-e2b', port: 4300, tail: '' } }));
    expect(await coming.gap).toMatchObject({ ok: false, code: 'native_coach_warming' });
    expect(coming.start).not.toHaveBeenCalled();
    const failed = asked(engine({ run: { state: 'failed', model: 'gemma-4-e2b', port: 0, tail: 'loading\nno vulkan device' } }));
    expect(await failed.gap).toMatchObject({ ok: false, code: 'native_coach_failed', reason: expect.stringContaining('no vulkan device') });
    expect(failed.start).not.toHaveBeenCalled();
  });

  it('lets the engine rest when it is not this run\u2019s', () => {
    const stop = vi.fn();
    useNativeCoachStore.setState({ status: READY, asked: true });
    coachIdle({ stop });
    expect(stop).toHaveBeenCalledTimes(1);
    useNativeCoachStore.setState({ status: engine(), asked: true });
    coachIdle({ stop });
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe('the check of the provider, with the feedback engine', () => {
  const OK: CheckResult = { ok: true };
  const CTX = { pair: { source: 'zh-CN', target: 'ja' }, legs: ['speaker' as const], signal: new AbortController().signal };
  const deps = () => ({ gap: vi.fn(async () => null), idle: vi.fn(), translatorGap: vi.fn(async () => null), translatorIdle: vi.fn(), coachGap: vi.fn(async () => null), coachIdle: vi.fn() });

  it('asks the engine when the speaker is coached by it, and lets it rest otherwise', async () => {
    const native = deps();
    const check = vi.fn(async () => OK);
    expect(await checkLocalAIWithNative({ endpoint: '' }, settings(), CTX, check, native)).toBe(OK);
    expect(native.coachGap).toHaveBeenCalledWith('gemma-4-e2b');
    expect(native.coachIdle).not.toHaveBeenCalled();
    // Not coached, or coached by another runner, or only the other side runs: it rests.
    for (const other of [settings({ coach: false }), settings({ coachHere: 'app' }), settings({ coachAt: 'api' })]) {
      const rest = deps();
      await checkLocalAIWithNative({ endpoint: '' }, other, CTX, check, rest);
      expect(rest.coachGap).not.toHaveBeenCalled();
      expect(rest.coachIdle).toHaveBeenCalledTimes(1);
    }
    const heard = deps();
    await checkLocalAIWithNative({ endpoint: '' }, settings(), { ...CTX, legs: ['participant'] }, check, heard);
    expect(heard.coachGap).not.toHaveBeenCalled();
  });

  it('says what the engine lacks when everything else passes', async () => {
    const native = { ...deps(), coachGap: vi.fn(async () => ({ ok: false as const, reason: 'Gemma 4 E2B is not downloaded.', code: 'native_coach_missing', params: { name: 'Gemma 4 E2B' } })) };
    expect(await checkLocalAIWithNative({ endpoint: '' }, settings(), CTX, vi.fn(async () => OK), native)).toMatchObject({ ok: false, code: 'native_coach_missing' });
  });
});
