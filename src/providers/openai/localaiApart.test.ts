/**
 * Fork: the user's own side heard in a place of its own (`asrMine`, `hearingOf`): each leg is checked, built and
 * loaded by where it is heard, and everything else reads the settings as it always did.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SessionContext } from '../../lib/contract/adapter';
import { buildLocalAI, checkLocalAIWithNative, createLocalAICheck, LOCALAI_DEFAULTS, localaiCredentials, localaiLanguages, migrateLocalAISettings, runHearing, settled, type LocalAIConfig, type LocalAISettings } from './localai';
import { alsoLit, alsoSpoken, deviceNeeds, heardBy, hearingOf, mineReach, speaksBoth, type HearingChoice } from './localaiDevice';
import type { LocalAIModel } from './localaiModels';
import { SHARED } from './testing';

const PAIR = { source: 'zh-CN', target: 'ja' };
const SPEAKER: SessionContext = { direction: PAIR, speech: false, turns: 'auto' };
const PARTICIPANT: SessionContext = { direction: { source: 'ja', target: 'zh-CN' }, speech: false, turns: 'auto' };
const MODELS: LocalAIModel[] = [{ id: 'gpt-realtime' }, { id: 'hy-mt2-1.8b' }];
const shared = { ...SHARED, reversed: (d: SessionContext['direction']) => d.source === 'ja', models: MODELS };
const HERE: HearingChoice = { asrVia: 'device', asrModel: '', asrApiBaseUrl: '', asrApiModel: '', asrApiNeedsKey: true, asrOther: '', asrOtherModel: '' };
const API: HearingChoice = { ...HERE, asrVia: 'api', asrApiBaseUrl: 'https://api.example.com/v1', asrApiModel: 'whisper-large-v3' };
/** The other side on the shared device, the translation by a model named there. */
const THERE: Partial<LocalAISettings> = { asrVia: 'server', translateAt: 'server', translateServerModel: 'hy-mt2-1.8b' };
const settings = (patch: Partial<LocalAISettings> = {}): LocalAISettings => ({ ...LOCALAI_DEFAULTS, ...patch });
const built = (context: SessionContext, patch: Partial<LocalAISettings>): LocalAIConfig => {
  const config = buildLocalAI(context, settled(settings(patch)), shared);
  if ('refused' in config) throw new Error(config.refused);
  return config;
};

describe('a side’s own hearing', () => {
  it('is the settings as they are, unless the user’s own is heard apart: then the speaker’s leg reads that, once', () => {
    const one = settings(THERE);
    expect(hearingOf(one, 'speaker')).toBe(one);
    expect(hearingOf(one, 'participant')).toBe(one);
    const apart = settings({ ...THERE, asrMine: API });
    // Each knows it is heard without the other (`asrAlone`).
    expect(hearingOf(apart, 'participant')).toMatchObject({ asrVia: 'server', asrAlone: 'participant' });
    const mine = hearingOf(apart, 'speaker');
    expect(mine).toMatchObject({ asrVia: 'api', asrApiModel: 'whisper-large-v3', translateAt: 'server', asrMine: null, asrAlone: 'speaker' });
    expect(hearingOf(mine, 'speaker')).toBe(mine);
    // Both on this computer are one engine's two rows: read whole, as with no place apart.
    const here = settings({ asrVia: 'device', asrMine: HERE });
    expect(hearingOf(here, 'speaker')).toBe(here);
    expect(hearingOf(here, 'participant')).toBe(here);
  });

  it('is read from what was stored, held to its shape', () => {
    const read = (asrMine: unknown) => migrateLocalAISettings({ ...LOCALAI_DEFAULTS, asrMine }, { legacy: {}, credentials: {} }).asrMine;
    expect(read({ asrVia: 'device' })).toEqual(HERE);
    expect(read({ asrVia: 'api', asrApiBaseUrl: 'https://x/v1', asrApiModel: 'm', asrApiNeedsKey: false })).toMatchObject({ asrVia: 'api', asrApiBaseUrl: 'https://x/v1', asrApiNeedsKey: false });
    for (const none of [undefined, null, 'device', { asrVia: 'moon' }, 7]) expect(read(none)).toBeNull();
  });

  it('on a phone of its own is the API it is asked as, as the shared one is', () => {
    const s = settled(settings({ ...THERE, asrMine: { ...HERE, asrVia: 'server', asrOther: '192.168.1.23:8792', asrOtherModel: 'apple-speech' } }));
    expect(s.asrMine).toMatchObject({ asrVia: 'api', asrApiModel: 'apple-speech', asrApiNeedsKey: false });
    expect(s.asrVia).toBe('server');
  });
});

describe('a run with the user’s own side heard apart', () => {
  it('tells the legs of a pair of one language apart by the leg the request names', () => {
    const same = { source: 'zh-CN', target: 'zh-CN' };
    const patch = { ...THERE, asrMine: API };
    const config = (leg: 'speaker' | 'participant') => buildLocalAI({ leg, direction: same, speech: false, turns: 'auto' }, settled(settings(patch)), { ...shared, reversed: () => true });
    expect(config('speaker')).toMatchObject({ device: { modelId: 'whisper-large-v3' } });
    expect((config('participant') as LocalAIConfig).device).toBeUndefined();
  });

  it('picks this computer’s recognizer for the side it hears, not for what the other side’s takes', () => {
    // The other side is left to be detected, on the shared device; the user's own, one language, on this computer.
    const s = settings({ ...THERE, asrDetectOther: true, theyAlso: ['en'], theyLit: 'en', asrMine: HERE });
    expect(runHearing(hearingOf(s, 'speaker'), PAIR, MODELS)).not.toHaveProperty('detecting');
    // Both here, the run's one pick is for both, as ever.
    expect(runHearing(settings({ asrVia: 'device', asrDetectOther: true, theyAlso: ['en'], theyLit: 'en' }), PAIR, MODELS)).toMatchObject({ detecting: true });
  });

  it('asks a phone lent to one side with its own key, not the recognition API’s of the other', async () => {
    const asked: Array<{ url: string; auth: string | null }> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      asked.push({ url: String(input), auth: new Headers(init?.headers).get('Authorization') });
      return new Response(JSON.stringify({ data: [] }));
    });
    const check = createLocalAICheck({ fetch: fetch as unknown as typeof globalThis.fetch });
    // The other side on a phone of its own, the user's own on an API that wants a key.
    const s = settled(settings({ asrVia: 'server', asrOther: '192.168.1.23:8792', asrOtherModel: 'apple-speech', translateAt: 'device', asrMine: API }));
    await check({ apiKey: '', endpoint: '', asrKey: 'cloud-key' }, s, { pair: PAIR, legs: ['speaker', 'participant'] }).catch(() => undefined);
    const phone = asked.filter((one) => one.url.includes('192.168.1.23'));
    expect(phone.length).toBeGreaterThan(0);
    expect(phone.every((one) => !one.auth?.includes('cloud-key'))).toBe(true);
    expect(asked.some((one) => one.url.startsWith('https://api.example.com') && one.auth?.includes('cloud-key'))).toBe(true);
  });

  it('builds each leg by where it is heard: the speaker’s by the API, the other side’s on the shared device', () => {
    const patch = { ...THERE, asrMine: API };
    const mine = built(SPEAKER, patch);
    expect(mine.device).toMatchObject({ modelId: 'whisper-large-v3', api: { baseUrl: 'https://api.example.com/v1', model: 'whisper-large-v3', key: 'asrKey' } });
    // Its translation is still the shared device's, asked over chat.
    expect(mine.stages?.speech).toMatchObject({ kind: 'translate', model: 'hy-mt2-1.8b' });
    const theirs = built(PARTICIPANT, patch);
    expect(theirs.device).toBeUndefined();
    expect(theirs.transcribeOnly).toBe(true);
    // Not apart, both are the shared device's.
    expect(built(SPEAKER, THERE).device).toBeUndefined();
  });

  it('asks for what either side needs: the shared device’s address, and the recognition API’s key', () => {
    const keys = (patch: Partial<LocalAISettings>) => localaiCredentials.fields(settled(settings(patch))).map((f) => f.key);
    // The other side alone is on the shared device; the user's own alone is on the API.
    expect(keys({ asrVia: 'server', translateAt: 'device', asrMine: API })).toEqual(['endpoint', 'asrKey']);
    // The other way round.
    expect(keys({ ...API, translateAt: 'device', asrMine: { ...HERE, asrVia: 'server' } })).toEqual(['endpoint', 'asrKey']);
    expect(keys({ asrVia: 'device', translateAt: 'device', asrMine: HERE })).toEqual([]);
  });

  it('loads this computer’s recognizer for the leg it hears, and for no other', async () => {
    const gap = vi.fn(async (_pick: unknown, _heard: readonly string[]) => null);
    const idle = vi.fn();
    const native = { gap, idle, translatorGap: vi.fn(async () => null), translatorIdle: vi.fn(), coachGap: vi.fn(async () => null), coachIdle: vi.fn() };
    const check = vi.fn(async () => ({ ok: true as const }));
    // The user's own on this computer, the other side on the shared device.
    await checkLocalAIWithNative({ apiKey: '', endpoint: '' }, settings({ ...THERE, asrMine: HERE }), { pair: PAIR, legs: ['speaker', 'participant'] }, check, native);
    expect(gap).toHaveBeenCalledTimes(1);
    expect(gap.mock.calls[0][1]).toEqual(['zh-CN']);
    // Neither here: the engine is told it is idle.
    gap.mockClear();
    await checkLocalAIWithNative({ apiKey: '', endpoint: '' }, settings({ ...THERE, asrMine: API }), { pair: PAIR, legs: ['speaker', 'participant'] }, check, native);
    expect(gap).not.toHaveBeenCalled();
    expect(idle).toHaveBeenCalled();
    // The other side's leg alone in the run: the speaker's recognizer is not asked for.
    await checkLocalAIWithNative({ apiKey: '', endpoint: '' }, settings({ ...THERE, asrMine: HERE }), { pair: PAIR, legs: ['participant'] }, check, native);
    expect(gap).not.toHaveBeenCalled();
  });

  it('counts this computer’s recognizer among a run’s models for the leg it hears alone', () => {
    const needs = (patch: Partial<LocalAISettings>) => deviceNeeds(settings(patch), PAIR, ['speaker', 'participant']).filter((n) => n.stage === 'asr').map((n) => n.leg);
    expect(needs({ ...THERE, asrMine: HERE })).toEqual(['speaker']);
    expect(needs({ asrVia: 'device', asrMine: API })).toEqual(['participant']);
    expect(needs({ asrVia: 'device' })).toEqual(['speaker', 'participant']);
  });

  it('judges the speaker’s two languages by what hears the speaker, and the other side’s detection by what hears them', () => {
    // The shared device tells no languages apart (it lists no recognizer); this computer's own can try.
    const apart = settings({ ...THERE, speakAlso: ['ja'], asrMine: HERE });
    expect(speaksBoth(apart, MODELS, PAIR)).toBe(true);
    expect(speaksBoth(settings({ ...THERE, speakAlso: ['ja'] }), MODELS, PAIR)).toBe(false);
    const detection = localaiLanguages.detection!(apart, MODELS, PAIR);
    expect(detection.both).toMatchObject({ on: true, available: true });
    expect(detection.other).toMatchObject({ on: false, available: false });
  });
});

describe('the user’s languages in use, by what their own recognizer hears (fork)', () => {
  // Japanese is the other side's language, and one the user speaks too.
  const base = { asrVia: 'device' as const, translateAt: 'device' as const, speakAlso: ['ja', 'ko'] };

  it('are those the other side has lit, less the ones a recognizer chosen for their own language does not hear', () => {
    const open = settings(base);
    expect(alsoLit(open, PAIR)).toEqual(['ja']);
    expect(mineReach(open, PAIR)).toBeNull();
    expect(alsoSpoken(open, PAIR)).toEqual(['ja']);
    // X-ASR, Chinese and English: Japanese steps aside, and the speaker is heard in their own language alone.
    const narrow = settings({ ...base, asrNativeByLanguage: { zh: 'x-asr-zh-en' } });
    expect(mineReach(narrow, PAIR)).toMatchObject({ model: 'x-asr-zh-en', languages: ['zh', 'en'] });
    expect(alsoLit(narrow, PAIR)).toEqual(['ja']);
    expect(alsoSpoken(narrow, PAIR)).toEqual([]);
    expect(speaksBoth(narrow, [], PAIR)).toBe(false);
    expect(heardBy(narrow, PAIR, 'speaker')).toBe('zh-CN');
    // A recognizer that hears it keeps it in use.
    const wide = settings({ ...base, asrNativeByLanguage: { zh: 'qwen3-asr-0.6b-q8' } });
    expect(alsoSpoken(wide, PAIR)).toEqual(['ja']);
    expect(heardBy(wide, PAIR, 'speaker')).toBe('auto');
  });

  it('are not narrowed by a recognizer the user’s own side does not use', () => {
    // Their side is heard elsewhere: what is chosen for Chinese on this computer is not what hears them.
    const elsewhere = settings({ ...base, asrNativeByLanguage: { zh: 'x-asr-zh-en' }, asrMine: API });
    expect(mineReach(elsewhere, PAIR)).toBeNull();
    expect(alsoSpoken(elsewhere, PAIR)).toEqual(['ja']);
    // The Mac's recognition has its own way with a second language.
    expect(mineReach(settings({ ...base, asrNativeByLanguage: { zh: 'apple-speech:zh' } }), PAIR)).toBeNull();
  });
});
