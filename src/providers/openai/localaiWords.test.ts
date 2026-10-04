import { beforeEach, describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import type { SessionContext } from '../../lib/contract/adapter';
import { noticeText } from '../../lib/view/noticeText';
import zhCN from '../../locales/zh_CN/translation.json';
import zhTW from '../../locales/zh_TW/translation.json';
import { createVirtualClock } from '../../lib/contract/clock';
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

describe('the words for another device or an API that does not answer as it should', () => {
  const DEVICE = { apiKey: '', endpoint: 'ws://192.168.1.20:8790/v1/realtime' };
  const localai = (catalog: unknown) => (catalog as { providers: { localai: Record<string, string> } }).providers.localai;
  /** The catalog's sentence, its `{{name}}`s filled in: what the person reads. */
  const filled = (text: string, params: Record<string, string | number> = {}) => text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(params[name]));
  type Answer = Response | Error | 'never';
  /** The other device answers with `device`, any API with `api`. */
  const checkWith = (device: Answer, api: Answer = new Response('{"data":[{"id":"m"}]}', { status: 200 }), clock = createVirtualClock(0)) => createLocalAICheck({
    clock,
    fetch: (async (url: RequestInfo | URL, init?: RequestInit) => {
      const answer = String(url).startsWith('http://192.168.1.20:8790') ? device : api;
      // As a real fetch does: no answer, until it is aborted.
      if (answer === 'never') return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
      if (answer instanceof Error) throw answer;
      return answer.clone();
    }) as unknown as typeof fetch,
  });
  /** What a check that answered or threw says, in each Chinese catalog: as the store holds it, and `noticeText` words it. */
  async function said(run: Promise<unknown>): Promise<{ code?: string; params?: Record<string, string | number>; zh: string[] }> {
    let notice: { code?: string; params?: Record<string, string | number>; message: string };
    try {
      const result = (await run) as { ok: boolean; code?: string; params?: Record<string, string | number>; reason?: string };
      notice = { code: result.code, params: result.params, message: result.reason ?? '' };
    } catch (error) {
      const e = error as { code?: unknown; params?: Record<string, string | number>; message: string };
      notice = { code: typeof e.code === 'string' ? e.code : undefined, params: e.params, message: e.message };
    }
    return { code: notice.code, params: notice.params, zh: [zhCN, zhTW].map((catalog) => noticeText(tIn(catalog as Catalog), notice)) };
  }
  const expectWords = (got: { code?: string; params?: Record<string, string | number>; zh: string[] }, key: string, params: Record<string, string | number> = {}) => {
    expect(got.params ?? {}).toEqual(params);
    expect(got.zh).toEqual([zhCN, zhTW].map((catalog) => {
      expect(localai(catalog)[key], key).toBeTruthy();
      return filled(localai(catalog)[key], params);
    }));
  };

  it('a device that does not answer: where it is, and what to look at — not "Failed to fetch"', async () => {
    expectWords(await said(checkWith(new TypeError('Failed to fetch'))(DEVICE, settings({}), ctx)), 'serverUnreachable', { address: '192.168.1.20:8790' });
  });

  it('a check that takes too long, a device that answers with an error, one with nothing to offer', async () => {
    const clock = createVirtualClock(0);
    const slow = said(checkWith('never', undefined, clock)(DEVICE, settings({}), ctx));
    await Promise.resolve();
    clock.advance(15_000);
    expectWords(await slow, 'checkSlow', { seconds: 15 });
    expectWords(await said(checkWith(new Response('', { status: 500 }))(DEVICE, settings({}), ctx)), 'serverHttp', { status: 500 });
    expectWords(await said(checkWith(new Response('{"data":[]}', { status: 200 }))(DEVICE, settings({}), ctx)), 'serverNoModels');
  });

  it('an access key the device asks for, or does not take', async () => {
    expectWords(await said(checkWith(new Response('', { status: 401 }))(DEVICE, settings({}), ctx)), 'serverKeyNeeded');
    expectWords(await said(checkWith(new Response('', { status: 401 }))({ ...DEVICE, apiKey: 'wrong' }, settings({ serverNeedsKey: true }), ctx)), 'serverKeyRefused');
  });

  it('an API of a stage: unreachable, or asking for a key it was not given, or refusing the one it was', async () => {
    const API = { asrVia: 'device', translateAt: 'api', translateBaseUrl: 'https://api.example.com/v1', translateModel: 'm' } as const;
    const ok = new Response('{"data":[]}', { status: 200 });
    expectWords(await said(checkWith(ok, new TypeError('Failed to fetch'))({ apiKey: '', endpoint: '' }, settings({ ...API, translateNeedsKey: false }), ctx)), 'apiUnreachable', { address: 'https://api.example.com/v1' });
    expectWords(await said(checkWith(ok, new Response('', { status: 401 }))({ apiKey: '', endpoint: '' }, settings({ ...API, translateNeedsKey: false }), ctx)), 'apiKeyNeeded', { address: 'https://api.example.com/v1' });
    expectWords(await said(checkWith(ok, new Response('', { status: 401 }))({ apiKey: '', endpoint: '', translateKey: 'sk-wrong' }, settings({ ...API, translateNeedsKey: true }), ctx)), 'apiKeyRefused', { address: 'https://api.example.com/v1' });
  });
});
