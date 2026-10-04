/**
 * Fork: Finish for the Kotomimi provider, bound to the real provider store —
 * an Electron-only provider, so this file's environment is Electron's. What
 * the step's one answer writes is `applySetup.test.ts`'s; this is what lands.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const { stored, getSetting, setSetting } = vi.hoisted(() => {
  const stored = new Map<string, unknown>();
  return {
    stored,
    getSetting: vi.fn(async (key: string, def: unknown) => (stored.has(key) ? stored.get(key) : def)),
    setSetting: vi.fn(async (key: string, value: unknown) => {
      stored.set(key, value);
      return { success: true };
    }),
  };
});
vi.mock('../../services/ServiceFactory', () => ({ ServiceFactory: { getSettingsService: () => ({ getSetting, setSetting }) } }));
vi.mock('../../utils/environment', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../utils/environment')>()), getEnvironment: () => 'electron' }));

import type { ProviderType } from '../../types/Provider';
import { readCredentials } from '../../lib/provider/credentials';
import { localaiProvider, type LocalAISettings } from '../../providers/openai/localai';
import { useProviderStore } from '../../stores/providerStore';
import { useApplySetup } from './useApplySetup';
import { initialDraft, type SetupDraft } from './setupDraft';

const noAuth = { signedIn: false, getToken: async () => null };
const draft = (over: Partial<SetupDraft>): SetupDraft => ({
  ...initialDraft(), step: 5, scenario: 'be-heard', providerPath: 'own-key', provider: 'localai' as ProviderType,
  credentials: {}, credentialsValidated: true, sourceLanguage: 'zh-CN', targetLanguage: 'ja',
  credentialChoice: { setting: 'asrVia', value: 'server' }, ...over,
});

beforeEach(() => {
  stored.clear();
  useProviderStore.setState({ entries: {}, selected: null, selectionLocked: false, intent: undefined });
});
afterEach(async () => {
  await useProviderStore.getState().flush();
});

describe('Finish for the Kotomimi provider', () => {
  it('keeps the access key the step was given, and asks the device with it from then on', async () => {
    const { result } = renderHook(() => useApplySetup());
    await result.current(draft({ credentials: { endpoint: '192.168.1.20:8790', serverKey: 's3cret' } }));
    const entry = useProviderStore.getState().entries.localai!;
    expect((entry.settings as { serverNeedsKey: boolean }).serverNeedsKey).toBe(true);
    expect(readCredentials(localaiProvider, entry.settings as LocalAISettings, entry.credentials, noAuth)).toMatchObject({ apiKey: 's3cret', endpoint: 'ws://192.168.1.20:8790/v1/realtime' });
    expect(setSetting).toHaveBeenCalledWith('settings.localai.serverNeedsKey', true);
  });

  it('asks for no key where none was given', async () => {
    const { result } = renderHook(() => useApplySetup());
    await result.current(draft({ credentials: { endpoint: '192.168.1.20:8790' } }));
    expect((useProviderStore.getState().entries.localai!.settings as { serverNeedsKey: boolean }).serverNeedsKey).toBe(false);
  });
});
