// Fork: the tour's steps for the Kotomimi provider. Every other provider's
// tour is upstream's, and `steps.test.ts` holds it as it was.
import { describe, it, expect } from 'vitest';
import en from '../../locales/en/translation.json';
import zh from '../../locales/zh_CN/translation.json';
import { BASICS_STEPS, bulletKey, contentKey, titleKey, visibleSteps } from './steps';
import { buildTourCtx } from './tourContext';
import type { TourCtx } from './tourContext';
import type { ProviderType } from '../../types/Provider';
import { Provider } from '../../types/Provider';

const electron = { isElectron: true, isExtension: false, isLinux: false, isMacOS: false, isWindows: true };
const ctx = (provider: string, extra: Partial<Parameters<typeof buildTourCtx>[0]> = {}): TourCtx => buildTourCtx({
  record: { scenario: 'two-way-text' }, provider: provider as ProviderType, mode: 'both', textOnly: true, isSignedIn: false, apiKeyValid: true, env: electron, ...extra,
});
const ids = (c: TourCtx) => visibleSteps(c).map((s) => s.id);
const at = (catalog: unknown, key: string) => key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog);

describe('the tour for the Kotomimi provider', () => {
  it('adds the reading aids and the tips before Start, and nothing for any other provider', () => {
    expect(ids(ctx('localai'))).toEqual(['welcome', 'mode-picker', 'microphone', 'participant-source', 'subtitle', 'provider-settings', 'reading-aids', 'kotomimi-tips', 'start', 'done']);
    expect(ids(ctx(Provider.OPENAI))).toEqual(['welcome', 'mode-picker', 'microphone', 'participant-source', 'subtitle', 'provider-settings', 'start', 'done']);
  });

  it('shows where the models are downloaded while a stage runs on this computer', () => {
    expect(ids(ctx('localai', { deviceStages: true }))).toContain('models');
    expect(ids(ctx('localai'))).not.toContain('models');
    // The flag is the Kotomimi provider's: the offline path has its own rule.
    expect(ids(ctx(Provider.LOCAL_INFERENCE))).toContain('models');
  });

  it('says of its provider step where the stages run, not where a key goes', () => {
    const step = BASICS_STEPS.find((s) => s.id === 'provider-settings')!;
    expect(contentKey(step, ctx('localai', { apiKeyValid: null }))).toBe('tour.steps.provider-settings.content_kotomimi');
    expect(contentKey(step, ctx(Provider.OPENAI, { apiKeyValid: null }))).toBe('tour.steps.provider-settings.content_pending');
  });

  it('has every word it shows, in English and in Chinese', () => {
    const c = ctx('localai', { deviceStages: true });
    for (const step of visibleSteps(c).filter((s) => ['provider-settings', 'reading-aids', 'kotomimi-tips'].includes(s.id))) {
      const keys = [titleKey(step), contentKey(step, c), ...(step.bullets ?? []).map((b) => bulletKey(step, b))];
      for (const key of keys) {
        expect(typeof at(en, key), `en ${key}`).toBe('string');
        expect(typeof at(zh, key), `zh_CN ${key}`).toBe('string');
      }
    }
  });
});
