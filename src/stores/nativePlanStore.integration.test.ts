import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const { stored, setSetting } = vi.hoisted(() => {
  const stored = new Map<string, unknown>();
  return { stored, setSetting: vi.fn(async (key: string, value: unknown) => {
    stored.set(key, value);
    return { success: true };
  }) };
});
vi.mock('../services/ServiceFactory', () => ({ ServiceFactory: { getSettingsService: () => ({
  getSetting: async (key: string, fallback: unknown) => stored.has(key) ? stored.get(key) : fallback,
  setSetting,
}) } }));
vi.mock('../utils/environment', async (original) => ({ ...(await original<typeof import('../utils/environment')>()),
  getEnvironment: () => 'electron', isMacOS: () => false, isWindows: () => true,
}));
vi.mock('../app/session', () => ({ getAppSession: () => ({ runner: { retarget: async () => {} } }) }));

import { nativePlanStore } from './nativePlanStore';
import { useProviderStore } from './providerStore';
import { useNativeEngineStore, useNativeTranslatorStore } from './nativeEngineStore';
import { NO_NATIVE_ENGINE, type NativeEngineStatus } from '../lib/native/nativeEngine';
import { buildLocalAI, localaiProvider, runSideHearing, type LocalAISettings } from '../providers/openai/localai';
import { alsoSpoken, heardBy, theirLitLanguages } from '../providers/openai/localaiDevice';
import { nativePicked } from '../providers/openai/localaiNative';
import { nativePlans } from '../providers/openai/nativePlans';
import { SHARED } from '../providers/openai/testing';
import { useApplySetup } from '../components/SetupWizard/useApplySetup';
import { initialDraft } from '../components/SetupWizard/setupDraft';
import type { ProviderType } from '../types/Provider';

const x = 'x-asr-zh-en';
const qwen = 'qwen3-asr-0.6b-q8';
const index = 'index-translate-2b';
const pair = { source: 'zh-CN', target: 'en' };
const status = (ids: string[]): NativeEngineStatus => ({ ...NO_NATIVE_ENGINE, supported: true, engine: 'ready',
  models: Object.fromEntries(ids.map((id) => [id, { state: 'downloaded', received: 1, total: 1 }])) });
const settings = () => useProviderStore.getState().entries.localai.settings as LocalAISettings;

beforeEach(() => {
  stored.clear();
  setSetting.mockClear();
  useProviderStore.setState({ entries: {}, selected: null, selectionLocked: false, intent: undefined });
  useNativeEngineStore.setState({ status: status([x, qwen]) });
  useNativeTranslatorStore.setState({ status: status([index]) });
});
afterEach(async () => {
  nativePlanStore.getState().cancel();
  await useProviderStore.getState().flush();
  vi.restoreAllMocks();
  useNativeEngineStore.setState({ status: NO_NATIVE_ENGINE });
  useNativeTranslatorStore.setState({ status: NO_NATIVE_ENGINE });
});

describe('native plans through the live provider store', () => {
  it.each([false, true])('keeps two auto legs on separate engines after applying balanced (download delayed: %s)', async (delayed) => {
    const store = useProviderStore.getState();
    await store.load(localaiProvider);
    store.setPair(localaiProvider, pair);
    store.select('localai');
    store.updateSettings(localaiProvider, { asrVia: 'device', translateAt: 'device', coach: false,
      speakAlso: ['en'], theyAlso: [], asrDetectOther: true, asrNativeByLanguage: {},
    });
    await store.flush(localaiProvider);
    expect(alsoSpoken(settings(), pair)).toEqual(['en']);
    expect(theirLitLanguages(settings(), pair)).toEqual(['en']);
    if (delayed) useNativeEngineStore.setState({ status: status([x]) });
    const download = vi.spyOn(useNativeEngineStore.getState(), 'download').mockResolvedValue(undefined);
    const plan = nativePlans({ settings: settings(), pair, platform: 'win32', memoryMB: 8192, lending: false,
      downloaded: delayed ? [x, index] : [x, qwen, index],
    }).plans.find((p) => p.id === 'balanced')!;
    expect(plan.speaker.model).toBe(x);
    expect(plan.participant.model).toBe(qwen);
    nativePlanStore.getState().apply(plan);
    if (delayed) {
      expect(download).toHaveBeenCalledWith(qwen);
      expect(settings().asrNativeByLanguage.zh).toBe(x);
      expect(settings().asrNativeByLanguage.auto).not.toBe(qwen);
      expect(nativePlanStore.getState().pending?.stages.map((stage) => stage.stage)).toEqual(['participant']);
      useNativeEngineStore.setState({ status: status([x, qwen]) });
    }
    // The speaker is keyed by their own language, even when both runtime legs hear auto.
    expect(settings().asrNativeByLanguage).toEqual({ zh: x, auto: qwen });
    expect(nativePlanStore.getState().pending).toBeNull();
    const shared = { ...SHARED, models: [], reversed: (direction: { source: string }) => direction.source === pair.target };
    for (const [side, model] of [['speaker', x], ['participant', qwen]] as const) {
      expect(heardBy(settings(), pair, side)).toBe('auto');
      expect(nativePicked(runSideHearing(settings(), pair, side), 'auto')?.id).toBe(model);
      const direction = side === 'speaker' ? pair : { source: pair.target, target: pair.source };
      expect(buildLocalAI({ direction, speech: false, turns: 'auto' }, settings(), shared)).toMatchObject({ device: { modelId: model } });
    }
    await store.flush(localaiProvider);
    expect(stored.get('settings.localai.asrNativeByLanguage')).toEqual({ zh: x, auto: qwen });
  });

  it('applies Finish immediately after its provider writes are flushed, without a render or another load', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const write = setSetting.getMockImplementation()!;
    setSetting.mockImplementation(async (key, value) => {
      if (key === 'settings.common.provider') await gate;
      return write(key, value);
    });
    const { result, unmount } = renderHook(() => useApplySetup());
    const finished = result.current({ ...initialDraft(), step: 5, scenario: 'be-heard', providerPath: 'own-key',
      provider: 'localai' as ProviderType, credentialsValidated: true,
      sourceLanguage: 'zh-CN', targetLanguage: 'en', credentialChoice: { setting: 'asrVia', value: 'device' }, plan: 'balanced',
    });
    try {
      await waitFor(() => expect(useProviderStore.getState().selected).toBe('localai'));
      expect(settings()).toMatchObject({ asrVia: 'device', translateAt: 'device', asrNativeByLanguage: {} });
      expect(nativePlanStore.getState().pending).toBeNull();
    } finally {
      release();
      await finished;
      setSetting.mockImplementation(write);
      unmount();
    }
    expect(settings()).toMatchObject({ asrNativeByLanguage: { zh: x, en: x }, translateNativeModel: index });
    expect(nativePlanStore.getState().pending).toBeNull();
    await useProviderStore.getState().flush(localaiProvider);
    expect(stored.get('settings.localai.asrNativeByLanguage')).toEqual({ zh: x, en: x });
  });
});
