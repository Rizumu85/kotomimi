import { describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';
import type { SessionContext } from '../../lib/contract/adapter';
import { noticeText } from '../../lib/view/noticeText';
import zhCN from '../../locales/zh_CN/translation.json';
import { coachPrompt } from './coachPrompt';
import {
  buildLocalAI, createLocalAICheck, hasTranscriptionLeg, LOCALAI_DEFAULTS, localaiProvider, migrateLocalAISettings, phoneWarms, prepareLocalAI, settled,
  type LocalAICredentials, type LocalAISettings, type NativeUps,
} from './localai';
import { coachesAtOwnDevice, needsServer, translatePlace, translatesAtOwnDevice } from './localaiDevice';
import { NATIVE_COACH_EXTRA } from './nativeCoaches';
import { nativeTranslator, translatorRequest } from './nativeTranslators';
import { SHARED } from './testing';

/**
 * A phone that lends its text models (`android/`, 0.8.0 on) as the translation's or the feedback's own "another
 * device": what is stored, how every reader past the cards reads it, and the request the phone is asked.
 */

const PHONE = '192.168.4.28:8792';
const BASE = 'http://192.168.4.28:8792/v1';
const SHARED_DEVICE: LocalAICredentials = { apiKey: '', endpoint: 'ws://192.168.1.10:8790/v1/realtime' };
const settings = (patch: Partial<LocalAISettings>): LocalAISettings => ({ ...LOCALAI_DEFAULTS, ...patch });
/** "I read Chinese, the other side speaks Japanese". */
const SPEAKER: SessionContext = { direction: { source: 'zh-CN', target: 'ja' }, speech: false, turns: 'auto' };
const PARTICIPANT: SessionContext = { direction: { source: 'ja', target: 'zh-CN' }, speech: false, turns: 'auto' };
const shared = { ...SHARED, reversed: (d: SessionContext['direction']) => d.source === 'ja', models: [] };
/** Every stage on a phone: hearing too, as `cf3efc01d` made it. */
const ON_PHONE: Partial<LocalAISettings> = {
  asrVia: 'server', asrOther: PHONE, asrOtherModel: 'sensevoice-small-q8',
  translateAt: 'server', translateOther: PHONE, translateOtherModel: 'index-translate-2b',
  coach: false, coachAt: 'server', coachOther: PHONE, coachOtherModel: 'gemma-4-e2b',
};

describe('the settings of a text stage on a phone', () => {
  it('are read back as stored, blank where never stored, and are no migration of anything', () => {
    const inputs = { legacy: {}, credentials: {} };
    const stored = { translateOther: PHONE, translateOtherModel: 'hy-mt2-1.8b', coachOther: PHONE, coachOtherModel: 'gemma-4-e2b' };
    expect(migrateLocalAISettings({ ...LOCALAI_DEFAULTS, ...stored }, inputs)).toMatchObject(stored);
    expect(migrateLocalAISettings({}, inputs)).toMatchObject({ translateOther: '', translateOtherModel: '', coachOther: '', coachOtherModel: '' });
    expect(migrateLocalAISettings({ translateOther: 7, coachOtherModel: null }, inputs)).toMatchObject({ translateOther: '', coachOtherModel: '' });
  });

  it('are among what the check reads: a change of phone or model asks again', () => {
    for (const key of ['translateOther', 'translateOtherModel', 'coachOther', 'coachOtherModel']) expect(localaiProvider.checkReads).toContain(key);
  });
});

describe('a text stage on a phone, as everything past the cards reads it', () => {
  it('is no stage of the shared device: with every stage on a phone no address is asked for, and no key', () => {
    const all = settings({ ...ON_PHONE, coach: true });
    expect(translatesAtOwnDevice(all)).toBe(true);
    expect(coachesAtOwnDevice(all)).toBe(true);
    expect(translatePlace(all)).toBe('api');
    expect(needsServer(all)).toBe(false);
    expect(localaiProvider.credentials.fields(all)).toEqual([]);
    // One stage left on the shared device asks for its address as ever.
    expect(localaiProvider.credentials.fields({ ...all, coachOther: '' }).map((f) => f.key)).toEqual(['endpoint']);
    expect(localaiProvider.credentials.fields({ ...all, translateOther: '  ' }).map((f) => f.key)).toEqual(['endpoint']);
  });

  it('counts for nothing once the stage is placed elsewhere, or the feedback is off', () => {
    expect(translatesAtOwnDevice(settings({ ...ON_PHONE, translateAt: 'device' }))).toBe(false);
    expect(coachesAtOwnDevice(settings(ON_PHONE))).toBe(false);
    expect(coachesAtOwnDevice(settings({ ...ON_PHONE, coach: true, coachAt: 'api' }))).toBe(false);
  });

  it('is left as it is by `settled`, which reads only the hearing phone as an API', () => {
    const read = settled(settings({ ...ON_PHONE, coach: true }));
    expect(read).toMatchObject({ asrVia: 'api', asrApiBaseUrl: BASE, translateAt: 'server', translateOther: PHONE, coachAt: 'server', coachOther: PHONE });
  });

  it('makes the leg the shared device hears one that only transcribes there', () => {
    expect(hasTranscriptionLeg(settings({ asrVia: 'server', translateAt: 'server', translateOther: PHONE }))).toBe(true);
    expect(hasTranscriptionLeg(settings({ asrVia: 'server', translateAt: 'server' }))).toBe(false);
    const built = buildLocalAI(PARTICIPANT, settings({ asrVia: 'server', translateAt: 'server', translateOther: PHONE, translateOtherModel: 'hy-mt2-1.8b' }), { ...shared, models: [{ id: 'gpt-realtime' }] });
    expect(built).toMatchObject({ transcribeOnly: true });
  });
});

describe('the request a phone is asked', () => {
  const build = (context: SessionContext, patch: Partial<LocalAISettings>) => buildLocalAI(context, settled(settings({ ...ON_PHONE, ...patch })), shared);

  it('is this computer’s native translator’s, in that model’s own form, at the phone’s address — never this computer’s engine', () => {
    const built = build(SPEAKER, {});
    if ('refused' in built) throw new Error(built.refused);
    const index = translatorRequest(nativeTranslator('index-translate-2b'), 'zh-CN', 'ja');
    expect(built.stages?.speech).toEqual({ kind: 'translate', baseUrl: BASE, model: 'index-translate-2b', phone: true, system: '', ...index });
    expect(built.stages?.speech).not.toHaveProperty('engine');
    // Hunyuan MT takes the sentence said before, in its own form.
    const hunyuan = build(PARTICIPANT, { translateOtherModel: 'hy-mt2-1.8b' });
    if ('refused' in hunyuan) throw new Error(hunyuan.refused);
    expect(hunyuan.stages?.speech).toMatchObject({ baseUrl: BASE, model: 'hy-mt2-1.8b', phone: true, system: '', ...translatorRequest(nativeTranslator('hy-mt2-1.8b'), 'ja', 'zh-CN') });
  });

  it('is an API’s, with the provider’s instructions, for a model this computer does not know', () => {
    const built = build(SPEAKER, { translateOtherModel: 'later-mt-3b' });
    if ('refused' in built) throw new Error(built.refused);
    const speech = built.stages?.speech as { system: string; wrap?: string; baseUrl: string; phone?: boolean };
    expect(speech).toMatchObject({ baseUrl: BASE, phone: true });
    expect(speech.system).not.toBe('');
    expect(speech.wrap).toBeUndefined();
  });

  it('is refused where the model does not translate the pair, by its name, and where none is chosen', () => {
    const swahili: SessionContext = { ...SPEAKER, direction: { source: 'sw', target: 'ja' } };
    expect(build(swahili, { translateOtherModel: 'hy-mt2-1.8b' })).toMatchObject({ code: 'phone_translator_unfit', params: { name: 'Hunyuan MT 2 1.8B' } });
    expect(build(SPEAKER, { translateOtherModel: '' })).toMatchObject({ code: 'translate_unnamed' });
  });

  it('is the native feedback model’s for a coached speaker: its instructions and worked examples, at the phone', () => {
    const built = build(SPEAKER, { coach: true });
    if ('refused' in built) throw new Error(built.refused);
    const prompt = coachPrompt('ja', 'zh-CN', '');
    expect(built.stages?.speech).toEqual({ kind: 'coach', baseUrl: BASE, model: 'gemma-4-e2b', phone: true, extra: NATIVE_COACH_EXTRA, system: prompt.system, shots: prompt.shots, language: 'zh-CN' });
    // What they type is still translated, by the phone's translator.
    expect(built.stages?.typed).toMatchObject({ kind: 'translate', baseUrl: BASE, model: 'index-translate-2b' });
    expect(build(SPEAKER, { coach: true, coachOtherModel: '' })).toMatchObject({ code: 'coach_unnamed' });
  });
});

describe('the check of a text stage on a phone', () => {
  const ctx = { pair: { source: 'zh-CN', target: 'ja' }, legs: ['speaker', 'participant'] as Array<'speaker' | 'participant'>, signal: new AbortController().signal };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'X-Kotomimi-Node': 'engine' } });
  const LENT = { object: 'list', data: [{ id: 'sensevoice-small-q8' }], text: [{ id: 'index-translate-2b', kind: 'translate', name: 'Index-Translate 2B', loaded: false }, { id: 'hy-mt2-1.8b', kind: 'translate', name: 'Hunyuan MT 2 1.8B', loaded: true }] };
  /** Only the phone answers: the shared device is never asked. */
  const phoneOnly = (list: unknown) => vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === `${BASE}/models`) return json(list);
    throw new Error(`asked ${String(input)}`);
  });
  const check = (fetch: typeof globalThis.fetch, patch: Partial<LocalAISettings> = {}) => createLocalAICheck({ fetch })(SHARED_DEVICE, settled(settings({ ...ON_PHONE, ...patch })), ctx);
  const t = ((key: string, options: Record<string, unknown> = {}) => {
    const found = key.split('.').reduce<unknown>((at, part) => (at as Record<string, unknown> | undefined)?.[part], zhCN);
    return (typeof found === 'string' ? found : key).replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options[name]));
  }) as unknown as TFunction;

  it('passes where the phone lends the model chosen, and asks nothing of the shared device', async () => {
    const fetch = phoneOnly(LENT);
    await expect(check(fetch)).resolves.toMatchObject({ ok: true });
    expect(fetch.mock.calls.every(([url]) => String(url) === `${BASE}/models`)).toBe(true);
  });

  it('reads what the phone lends of text models in `text`: a name in `data` is its recognizer', async () => {
    const refused = await check(phoneOnly({ ...LENT, data: [{ id: 'index-translate-2b' }], text: [] }));
    expect(refused).toMatchObject({ ok: false, code: 'phone_model_gone', params: { address: PHONE, name: 'Index-Translate 2B' } });
    if (refused.ok) return;
    expect(noticeText(t, { code: refused.code, params: refused.params, message: refused.reason })).toBe('手机（192.168.4.28:8792）现在没有借出 Index-Translate 2B。请在卡片里换一个模型。');
  });

  it('refuses a model the phone has not the memory for now, and says where to look', async () => {
    const small = { ...LENT, data: [{ id: 'sensevoice-small-q8', holds_mb: 250 }], text: [{ id: 'index-translate-2b', kind: 'translate', name: 'Index-Translate 2B', holds_mb: 1541, loaded: false }, { id: 'hy-mt2-1.8b', kind: 'translate', name: 'Hunyuan MT 2 1.8B', holds_mb: 1210, loaded: false }], memory_mb: { total: 3843, available: 1160 } };
    const refused = await check(phoneOnly(small));
    expect(refused).toMatchObject({ ok: false, code: 'phone_model_too_big', params: { address: PHONE, name: 'Index-Translate 2B' } });
    if (refused.ok) return;
    expect(noticeText(t, { code: refused.code, params: refused.params, message: refused.reason })).toBe('手机（192.168.4.28:8792）现在内存不够运行 Index-Translate 2B。请在卡片里换一个小一点的模型，或关掉手机上的其他应用。');
    await expect(check(phoneOnly(small), { translateOtherModel: 'hy-mt2-1.8b' })).resolves.toMatchObject({ ok: true });
  });

  it('refuses a feedback model the phone does not lend: a translator of the same name is no feedback model', async () => {
    const refused = await check(phoneOnly(LENT), { coach: true, coachOtherModel: 'hy-mt2-1.8b' });
    expect(refused).toMatchObject({ ok: false, code: 'phone_model_gone' });
  });

  it('says a phone that does not answer is that phone, in the words for one', async () => {
    const unreachable = async () => { throw new TypeError('Failed to fetch'); };
    const thrown = await check(unreachable as unknown as typeof fetch).then(() => null, (error: unknown) => error as { code?: string; params?: Record<string, string>; message: string });
    expect(thrown).toMatchObject({ code: 'phone_unreachable', params: { address: PHONE } });
    expect(noticeText(t, { code: thrown?.code, params: thrown?.params, message: thrown?.message ?? '' })).toBe('手机（192.168.4.28:8792）连不上。请确认它开着共享，并且和这台电脑在同一个 Wi-Fi 下。');
    // The hearing stage's phone too, though past the cards it is read as an API.
    const hearingOnly = await check(unreachable as unknown as typeof fetch, { translateAt: 'device', translateHere: 'native' }).then(() => null, (error: unknown) => error as { code?: string });
    expect(hearingOnly).toMatchObject({ code: 'phone_unreachable' });
  });

  it('refuses a translator that does not translate a leg’s pair, by its name', async () => {
    const refused = await createLocalAICheck({ fetch: phoneOnly(LENT) })(SHARED_DEVICE, settled(settings({ ...ON_PHONE, translateOtherModel: 'hy-mt2-1.8b' })), { ...ctx, pair: { source: 'zh-CN', target: 'sw' } });
    expect(refused).toMatchObject({ ok: false, code: 'phone_translator_unfit', params: { name: 'Hunyuan MT 2 1.8B' } });
    if (refused.ok) return;
    expect(noticeText(t, { code: refused.code, params: refused.params, message: refused.reason })).toBe('Hunyuan MT 2 1.8B 不支持你选的这两种语言，请换一个模型。');
  });
});

describe('a run with a text stage on a phone', () => {
  const ups = (): NativeUps => ({ hears: vi.fn(async () => undefined), translates: vi.fn(async () => undefined), coaches: vi.fn(async () => undefined), rest: vi.fn() }) as never;
  const BOTH = { pair: { source: 'zh-CN', target: 'ja' }, legs: ['speaker', 'participant'] as const };

  it('asks the phone to load its models as it begins, and does not wait for it', async () => {
    const run = new AbortController();
    const warm = vi.fn((_wanted: unknown, _signal: AbortSignal) => new Promise<void>(() => {}));
    await expect(prepareLocalAI(BOTH, settings({ ...ON_PHONE, coach: true }), ups(), run.signal, warm)).resolves.toEqual({});
    expect(warm).toHaveBeenCalledTimes(1);
    const [wanted, signal] = warm.mock.calls[0];
    expect(signal).toBe(run.signal);
    const prompt = coachPrompt('ja', 'zh-CN', '');
    expect(wanted).toEqual([
      { address: PHONE, model: 'index-translate-2b', messages: [], extra: translatorRequest(nativeTranslator('index-translate-2b'), 'zh-CN', 'ja').extra },
      { address: PHONE, model: 'gemma-4-e2b', extra: NATIVE_COACH_EXTRA, messages: [{ role: 'system', content: prompt.system }, ...prompt.shots.flatMap((shot) => [{ role: 'user', content: shot.said }, { role: 'assistant', content: shot.answer }])] },
    ]);
  });

  it('warms the feedback model with what every real request begins with, byte for byte: the phone reads it once', () => {
    // As the session asks it (`pipeline.ts` `complete` → `completeText`): the system message, then each example as two turns.
    for (const coachPromptText of ['', 'Check {{SPOKEN}} for a speaker of {{NATIVE}}.']) {
      const s = settled(settings({ ...ON_PHONE, coach: true, coachPrompt: coachPromptText }));
      const built = buildLocalAI(SPEAKER, s, shared);
      if ('refused' in built) throw new Error(built.refused);
      const stage = built.stages?.speech as { system: string; shots?: Array<{ said: string; answer: string }>; extra?: unknown };
      const asked = [{ role: 'system', content: stage.system }, ...(stage.shots ?? []).flatMap((shot) => [{ role: 'user', content: shot.said }, { role: 'assistant', content: shot.answer }])];
      const warm = phoneWarms(s, BOTH.pair, BOTH.legs).find((w) => w.model === 'gemma-4-e2b');
      expect(JSON.stringify(warm?.messages)).toBe(JSON.stringify(asked));
      expect(warm?.extra).toEqual(stage.extra);
    }
  });

  it('asks nothing where no text stage is on a phone, and no feedback model of a run without the speaker', async () => {
    const warm = vi.fn(async () => undefined);
    await prepareLocalAI(BOTH, settings({ asrVia: 'server', asrOther: PHONE }), ups(), undefined, warm);
    expect(warm).not.toHaveBeenCalled();
    expect(phoneWarms(settings({ ...ON_PHONE, coach: true }), BOTH.pair, ['participant']).map((w) => w.model)).toEqual(['index-translate-2b']);
  });
});
