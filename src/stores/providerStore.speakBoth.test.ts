import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnyProvider } from '../lib/provider/types';

const { saved } = vi.hoisted(() => ({ saved: new Map<string, unknown>() }));
vi.mock('../services/ServiceFactory', () => ({
  ServiceFactory: { getSettingsService: () => ({
    getSetting: async (key: string, fallback: unknown) => saved.has(key) ? saved.get(key) : fallback,
    setSetting: async (key: string, value: unknown) => { saved.set(key, value); return { success: true }; },
  }) },
}));

import { localaiProvider, type LocalAISettings } from '../providers/openai/localai';
import { useProviderStore } from './providerStore';

const provider = localaiProvider as unknown as AnyProvider;
const restart = () => useProviderStore.setState({ entries: {}, selected: null, intent: undefined, selectionLocked: false });

beforeEach(() => { saved.clear(); restart(); });

describe('the remembered bilingual speaker preference', () => {
  it.each([true, false])('restores %s after saving and loading a fresh store entry', async (enabled) => {
    saved.set(`settings.${provider.settings.key}.speakBoth`, !enabled);
    await useProviderStore.getState().load(provider);
    useProviderStore.getState().updateSettings(provider, { speakBoth: enabled });
    expect(await useProviderStore.getState().flush(provider)).toBe(true);
    restart();
    await useProviderStore.getState().load(provider);
    expect((useProviderStore.getState().entries.localai.settings as LocalAISettings).speakBoth).toBe(enabled);
  });

  it('keeps the preference when changing the conversation languages', async () => {
    await useProviderStore.getState().load(provider);
    useProviderStore.getState().updateSettings(provider, { speakBoth: true });
    useProviderStore.getState().setPair(provider, { source: 'en', target: 'ja' });
    await useProviderStore.getState().flush(provider);
    restart();
    await useProviderStore.getState().load(provider);
    expect((useProviderStore.getState().entries.localai.settings as LocalAISettings).speakBoth).toBe(true);
  });
});
