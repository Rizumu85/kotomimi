import { beforeEach, describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import type { SessionContext } from '../../lib/contract/adapter';
import { noticeText } from '../../lib/view/noticeText';
import zhCN from '../../locales/zh_CN/translation.json';
import zhTW from '../../locales/zh_TW/translation.json';
import { useModelStore } from '../../stores/modelStore';
import { buildLocalAI, createLocalAICheck, LOCALAI_DEFAULTS, localaiCredentials, type LocalAISettings } from './localai';
import type { LocalAIModel } from './localaiModels';
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

describe('the words for another device not chosen yet', () => {
  const noAuth = { signedIn: false, getToken: async () => null };
  const localai = (catalog: unknown) => (catalog as { providers: { localai: Record<string, string> } }).providers.localai;
  /** What a missing credential reads as: its own code, else the runner's `credentials_missing` (`providerStore.refreshReadiness`, `run.ts`). */
  const said = (catalog: unknown, values: Record<string, string>) => {
    const read = localaiCredentials.read(values, noAuth);
    if (!('missing' in read)) throw new Error('nothing is missing');
    return noticeText(tIn(catalog as Catalog), { code: read.code ?? 'credentials_missing', params: read.params, message: read.missing });
  };

  it('asks for the device, not for an API key: every stage starts on it, with no address', () => {
    for (const catalog of [zhCN, zhTW]) {
      expect(localai(catalog).addressMissing).toBeTruthy();
      expect(said(catalog, { endpoint: '' })).toBe(localai(catalog).addressMissing);
    }
  });

  it('asks for the access key by the name its field has', () => {
    for (const catalog of [zhCN, zhTW]) {
      expect(localai(catalog).serverKeyMissing).toBeTruthy();
      expect(said(catalog, { endpoint: '192.168.1.10:8790', serverKey: ' ' })).toBe(localai(catalog).serverKeyMissing);
    }
  });
});

describe('the words for Auto Detect where nothing detects the language', () => {
  const AUTO_PAIR = { source: 'auto', target: 'en' };
  const autoCtx = { ...ctx, pair: AUTO_PAIR };
  const AUTO_SPEAKER: SessionContext = { ...SPEAKER, direction: AUTO_PAIR };
  const localai = (catalog: unknown) => (catalog as { providers: { localai: Record<string, string> } }).providers.localai;
  /** A LocalAI hears: whether its recognizer detects the language is its own business. */
  const localaiServer = createLocalAICheck({ fetch: (async (url: RequestInfo | URL) => new Response(JSON.stringify(String(url).endsWith('/capabilities')
    ? { data: [{ id: 'gpt-realtime', capabilities: [] }, { id: 'whisper', capabilities: ['transcript'] }] }
    : { data: [{ id: 'gpt-realtime' }, { id: 'whisper' }] }), { status: 200 })) as unknown as typeof fetch });
  /** Another Kotomimi hears: its recognizers are told the language, and refuse a session that does not say it (`src/lib/lan/transcriber.ts`). */
  const kotomimiServer = createLocalAICheck({ fetch: (async (url: RequestInfo | URL) => new Response(JSON.stringify(String(url).endsWith('/capabilities')
    ? { data: [{ id: 'kotomimi', capabilities: null }, { id: 'sensevoice-int8', capabilities: ['transcript'] }] }
    : { data: [{ id: 'kotomimi', owned_by: 'kotomimi' }, { id: 'sensevoice-int8', owned_by: 'kotomimi' }] }), { status: 200 })) as unknown as typeof fetch });
  const SERVER = { apiKey: '', endpoint: 'ws://192.168.1.10:8790/v1/realtime' };

  it('this computer translating asks for the language, not for a download no model can answer', async () => {
    const s = settings({ translateAt: 'device' });
    const checked = await localaiServer(SERVER, s, autoCtx);
    const built = buildLocalAI(AUTO_SPEAKER, s, { ...SHARED, models: [{ id: 'gpt-realtime', kind: 'pipeline' as const }] as LocalAIModel[] });
    expect(checked).toMatchObject({ ok: false, code: 'source_auto' });
    expect(built).toMatchObject({ code: 'source_auto' });
    for (const catalog of [zhCN, zhTW]) {
      expect(localai(catalog).sourceAuto).toBeTruthy();
      if (!checked.ok) expect(noticeText(tIn(catalog as Catalog), { code: checked.code, message: checked.reason })).toBe(localai(catalog).sourceAuto);
    }
  });

  it('another Kotomimi listening is refused before Start, not at it in its English', async () => {
    const s = settings({});
    expect(await kotomimiServer(SERVER, s, autoCtx)).toMatchObject({ ok: false, code: 'source_auto' });
    expect(buildLocalAI(AUTO_SPEAKER, s, { ...SHARED, models: KOTOMIMI })).toMatchObject({ code: 'source_auto' });
  });

  it('leaves Auto Detect to what can detect: a LocalAI listening, an API, and the language named', async () => {
    expect(await localaiServer(SERVER, settings({}), autoCtx)).toMatchObject({ ok: true });
    expect(await noServer({ apiKey: '', endpoint: '' }, settings({ asrVia: 'api', asrApiBaseUrl: 'http://x/v1', asrApiModel: 'm', translateAt: 'api', translateBaseUrl: 'http://x/v1', translateModel: 'm' }), autoCtx)).toMatchObject({ ok: true });
    // The language named: this computer translates it (by the online translator, while nothing is downloaded).
    expect(await localaiServer(SERVER, settings({ translateAt: 'device' }), ctx)).toMatchObject({ ok: true });
  });
});
