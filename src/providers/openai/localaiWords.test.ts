import { beforeEach, describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import type { SessionContext } from '../../lib/contract/adapter';
import { noticeText } from '../../lib/view/noticeText';
import zhCN from '../../locales/zh_CN/translation.json';
import zhTW from '../../locales/zh_TW/translation.json';
import { useModelStore } from '../../stores/modelStore';
import { buildLocalAI, createLocalAICheck, LOCALAI_DEFAULTS, type LocalAISettings } from './localai';
import { SHARED } from './testing';

/**
 * What a person reads when the Kotomimi provider cannot start: the words of
 * the catalog the app shows, looked up as the app looks them up
 * (`noticeText`). Each refusal names what to fix, in the words the cards use.
 */

type Catalog = Record<string, unknown>;
/** i18next as far as a notice uses it: the key looked up in one catalog, `{{name}}` filled in. */
const tIn = (catalog: Catalog) => ((key: string, options: Record<string, unknown> = {}) => {
  const found = key.split('.').reduce<unknown>((at, part) => (at as Catalog | undefined)?.[part], catalog);
  const text = typeof found === 'string' ? found : String(options.defaultValue ?? key);
  return text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options[name]));
}) as unknown as TFunction;

const settings = (patch: Partial<LocalAISettings>): LocalAISettings => ({ ...LOCALAI_DEFAULTS, ...patch });
const SPEAKER: SessionContext = { direction: { source: 'zh-CN', target: 'en' }, speech: false, turns: 'auto' };
const ctx = { pair: { source: 'zh-CN', target: 'en' }, legs: ['speaker'] as const, signal: new AbortController().signal };
/** Another Kotomimi: it shares recognizers and translation models, and no chat model. */
const KOTOMIMI = [{ id: 'kotomimi', kind: 'pipeline' as const, host: 'kotomimi' as const }, { id: 'sensevoice-int8', kind: 'asr' as const, host: 'kotomimi' as const }];
const noServer = createLocalAICheck({ fetch: (async () => new Response('{"data":[]}', { status: 200 })) as unknown as typeof fetch });

beforeEach(() => {
  useModelStore.setState({ initialized: true, webgpuAvailable: true, deviceFeatures: [], modelStatuses: { 'sensevoice-int8': 'downloaded' } });
});

describe('the words for a stage with nothing to run', () => {
  const HERE = { asrVia: 'device', translateAt: 'device' } as const;
  const cases = [
    { stage: 'asrUnnamed', patch: { ...HERE, asrVia: 'api' } as Partial<LocalAISettings> },
    { stage: 'translateUnnamed', patch: { ...HERE, translateAt: 'api' } as Partial<LocalAISettings> },
    { stage: 'coachUnnamed', patch: { ...HERE, coach: true, coachAt: 'api' } as Partial<LocalAISettings> },
  ] as const;

  for (const { stage, patch } of cases) {
    it(`${stage}: the check and the start say which card to fill, not to validate an API key`, async () => {
      const checked = await noServer({ apiKey: '', endpoint: '' }, settings(patch), ctx);
      const built = buildLocalAI(SPEAKER, settings(patch), { ...SHARED, models: [] });
      expect(checked.ok).toBe(false);
      expect('refused' in built).toBe(true);
      for (const [catalog, words] of [[zhCN, (zhCN as Catalog as { providers: { localai: Record<string, string> } }).providers.localai[stage]], [zhTW, (zhTW as Catalog as { providers: { localai: Record<string, string> } }).providers.localai[stage]]] as const) {
        expect(words).toBeTruthy();
        if (checked.ok || !('refused' in built)) continue;
        expect(noticeText(tIn(catalog as Catalog), { code: checked.code, params: checked.params, message: checked.reason })).toBe(words);
        expect(noticeText(tIn(catalog as Catalog), { code: built.code, params: built.params, message: built.refused })).toBe(words);
      }
    });
  }

  it('grammar feedback on another Kotomimi, which shares no chat model, is named the same way', () => {
    const built = buildLocalAI(SPEAKER, settings({ coach: true, coachAt: 'server' }), { ...SHARED, reversed: () => false, models: KOTOMIMI });
    expect(built).toMatchObject({ code: 'coach_unnamed' });
  });
});
