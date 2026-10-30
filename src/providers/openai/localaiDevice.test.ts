import { describe, expect, it, vi } from 'vitest';
import { buildLocalAI, checkLocalAIWithNative, createLocalAICheck, LOCALAI_DEFAULTS, localaiLanguages, migrateLocalAISettings } from './localai';
import { canDetectOther, cutsSentencesHere, deviceNeeds, heardBy, hearingPlace, hearsAtOwnDevice, needsServer, speaksBoth } from './localaiDevice';
import { nativeGap, translatorGap } from './localaiNative';
import { NO_NATIVE_ENGINE, type NativeEngineStatus } from '../../lib/native/nativeEngine';
import { SHARED } from './testing';
import { useModelStore } from '../../stores/modelStore';

const PAIR = { source: 'zh-CN', target: 'ja' };
const INPUTS = { legacy: {}, credentials: {} };
const settings = (patch = {}) => ({ ...LOCALAI_DEFAULTS, ...patch });
const context = { direction: PAIR, speech: false, turns: 'auto' as const };
const shared = { ...SHARED, models: [], reversed: (d: typeof PAIR) => d.source === 'ja' };

describe('native-only local stages', () => {
  it.each(['app', 'localai', 'native', undefined])('migrates the legacy runner %s without changing stage locations or native choices', (old) => {
    const migrated = migrateLocalAISettings({
      ...LOCALAI_DEFAULTS,
      asrVia: 'device', translateAt: 'api', coachAt: 'server', coach: true,
      asrHere: old, translateHere: old, coachHere: old,
      asrNativeModel: 'sensevoice-small-q8', asrNativeByLanguage: { auto: 'sensevoice-small-q8' },
      selections: { 'zh→ja': { translation: { modelId: 'bing-translator' } } }, coachDeviceModel: 'qwen3-4b',
      vadThreshold: 0.6, speakBoth: true,
    }, { legacy: { translateAt: 'api', coachAt: 'server' }, credentials: {} });
    expect(migrated).toMatchObject({ asrVia: 'device', translateAt: 'api', coachAt: 'server', coach: true,
      asrHere: 'native', translateHere: 'native', coachHere: 'native', asrNativeModel: 'sensevoice-small-q8',
      asrNativeByLanguage: { auto: 'sensevoice-small-q8' }, vadThreshold: 0.6, speakBoth: true });
    expect(migrated).not.toHaveProperty('selections');
    expect(migrated).not.toHaveProperty('coachDeviceModel');
  });

  it('builds native recognition, translation, and feedback without consulting the browser model store', () => {
    const resolve = vi.spyOn(useModelStore.getState(), 'resolve');
    try {
      const s = migrateLocalAISettings({ asrVia: 'device', translateAt: 'device', coachAt: 'device', coach: true, speakBoth: true, asrHere: 'app' }, INPUTS);
      const built = buildLocalAI(context, s, shared);
      expect(built).toMatchObject({ device: { native: { model: s.asrNativeModel } }, stages: {
        speech: { engine: 'translator', model: s.translateNativeModel },
        feedback: { stage: { engine: 'coach', model: s.coachNativeModel } },
      } });
      expect(JSON.stringify(built)).not.toContain('bing-translator');
      expect(resolve).not.toHaveBeenCalled();
    } finally { resolve.mockRestore(); }
  });

  it('reports a missing native download instead of using a browser model or online fallback', async () => {
    const s = settings({ asrVia: 'device', translateAt: 'api', translateBaseUrl: 'https://example.com/v1', translateModel: 'translator' });
    const result = await checkLocalAIWithNative({ apiKey: '', endpoint: '' }, s, { pair: PAIR, legs: ['speaker'] }, async () => ({ ok: true }), {
      gap: (pick, heard) => nativeGap(pick, heard, { status: async () => ({ ...NO_NATIVE_ENGINE, supported: true, engine: 'ready' }) }),
      idle: vi.fn(), translatorIdle: vi.fn(), coachIdle: vi.fn(),
    });
    expect(result).toMatchObject({ ok: false, code: 'native_missing' });
  });

  it.each([
    { supported: false, anotherDownloaded: false, code: 'native_translator_unsupported' },
    { supported: true, anotherDownloaded: false, code: 'native_translator_missing' },
    { supported: true, anotherDownloaded: true, code: 'native_translator_missing' },
  ])('refuses unavailable native translation without a Bing request: $code, another model=$anotherDownloaded', async ({ supported, anotherDownloaded, code }) => {
    const s = migrateLocalAISettings({
      ...LOCALAI_DEFAULTS, asrVia: 'device', translateAt: 'device', translateHere: 'app',
      translateNativeModel: 'hy-mt2-1.8b',
      selections: { 'zh→ja': { translation: { modelId: 'bing-translator' } } },
    }, { legacy: { translateAt: 'device' }, credentials: {} });
    const fetch = vi.fn<typeof globalThis.fetch>();
    const resolve = vi.spyOn(useModelStore.getState(), 'resolve');
    const status: NativeEngineStatus = { ...NO_NATIVE_ENGINE, supported, engine: 'ready', models: {} };
    if (anotherDownloaded) status.models['index-translate-2b'] = { state: 'downloaded', received: 1, total: 1 };
    try {
      const result = await checkLocalAIWithNative({ apiKey: '', endpoint: '' }, s, { pair: PAIR, legs: ['speaker', 'participant'] }, createLocalAICheck({ fetch }), {
        gap: async () => null, idle: vi.fn(), translatorIdle: vi.fn(), coachIdle: vi.fn(),
        translatorGap: (id, pairs) => translatorGap(id, pairs, { status: async () => status }),
      });
      expect(result).toMatchObject({ ok: false, code });
      expect(buildLocalAI(context, s, shared)).toMatchObject({ stages: { speech: { engine: 'translator', model: 'hy-mt2-1.8b' } } });
      expect(fetch).not.toHaveBeenCalled();
      expect(resolve).not.toHaveBeenCalled();
    } finally { resolve.mockRestore(); }
  });

  it('keeps bilingual speech and feedback independent', () => {
    const s = settings({ asrVia: 'api', coach: true, speakBoth: true });
    expect(speaksBoth(s, [], PAIR)).toBe(true);
    expect(heardBy(s, PAIR, 'speaker')).toBe('auto');
    expect(heardBy(s, PAIR, 'participant')).toBe('ja');
    expect(localaiLanguages.detection?.(s, [], PAIR).both.turn(false)).toEqual({ speakBoth: false });
  });

  it('projects both translation directions when only the bilingual speaker runs', () => {
    for (const coach of [false, true]) {
      const slots = deviceNeeds(settings({ asrVia: 'device', translateAt: 'device', speakBoth: true, coach }), PAIR, ['speaker']);
      expect(slots.filter((s) => s.stage === 'translation').map((s) => s.dir)).toEqual(['zh→ja', 'ja→zh']);
      expect(slots.find((s) => s.stage === 'asr')?.source).toBe('zh-CN');
    }
  });
});

describe('independent stage locations', () => {
  it('needs the shared device only while a stage actually runs there', () => {
    expect(needsServer(settings({ asrVia: 'device', translateAt: 'api', coach: false }))).toBe(false);
    expect(needsServer(settings({ asrVia: 'device', translateAt: 'server' }))).toBe(true);
    expect(needsServer(settings({ asrVia: 'api', translateAt: 'device', coach: true, coachAt: 'server' }))).toBe(true);
  });

  it('treats a phone as the hearing stage’s own device without requiring the shared server', () => {
    const s = settings({ asrVia: 'server', asrOther: '192.168.4.28:8792', translateAt: 'device' });
    expect(hearsAtOwnDevice(s)).toBe(true);
    expect(hearingPlace(s)).toBe('api');
    expect(cutsSentencesHere(s)).toBe(true);
    expect(needsServer(s)).toBe(false);
    expect(canDetectOther(s)).toBe(true);
  });
});
