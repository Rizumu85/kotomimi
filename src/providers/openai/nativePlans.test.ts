import { describe, expect, it } from 'vitest';
import { LOCALAI_DEFAULTS } from './localai';
import { NATIVE_MODELS } from './localaiNative';
import { NATIVE_TRANSLATORS } from './nativeTranslators';
import { currentNativeModels, nativeLanguageGap, nativeModelFit, nativePlans, nativeSideLanguages, planRecognizer, planTranslator, recommendedNativePlan, type NativePlanInputs } from './nativePlans';
import { recommendNativeModel } from './nativeRecommendation';

const qwen = 'qwen3-asr-0.6b-q8';
const big = 'qwen3-asr-1.7b-q8';
const sense = 'sensevoice-small-q8';
const x = 'x-asr-zh-en';
const index = 'index-translate-2b';
const plamo = 'plamo-3-translate-0.8b';
export const input = (over: Partial<NativePlanInputs> = {}): NativePlanInputs => ({
  settings: { ...LOCALAI_DEFAULTS, asrVia: 'device', translateAt: 'device', coach: false },
  pair: { source: 'zh-CN', target: 'ja' }, platform: 'win32', memoryMB: null, lending: false, downloaded: [], ...over,
});

describe('native plans', () => {
  it.each([
    [undefined, false, 'balanced'], [null, false, 'balanced'], [0, false, 'light'], [7679, false, 'light'],
    [7680, false, 'balanced'], [15359, false, 'balanced'], [15360, false, 'accurate'], [0, true, 'accurate'],
  ] as const)('recommends at %s MB, lending %s', (memory, lending, expected) => {
    expect(recommendedNativePlan(memory, lending)).toBe(expected);
  });

  it('keeps only spoken languages currently in use, and treats open-ended detection as unknown', () => {
    const s = { ...input().settings, speakAlso: ['en', 'ja', 'fr'], theyAlso: ['en'], theyLit: 'en', asrDetectOther: true };
    expect(nativeSideLanguages(s, input().pair, 'speaker')).toEqual(['zh', 'en', 'ja']);
    expect(nativeSideLanguages(s, input().pair, 'participant')).toEqual(['ja', 'en']);
    expect(nativeSideLanguages({ ...s, theyAlso: [], theyLit: 'auto' }, input().pair, 'participant')).toBeNull();
  });

  it.each([
    ['light', ['en-US', 'zh-TW'], x], ['balanced', ['en'], x], ['light', ['ja', 'yue'], sense],
    ['light', ['fr'], qwen], ['balanced', ['ja'], qwen], ['accurate', ['zh'], big],
    ['light', null, qwen], ['balanced', null, qwen], ['light', ['uk'], 'nemotron-asr-0.6b-q8'], ['accurate', ['xx'], null],
  ] as const)('selects %s recognition for %j', (plan, languages, model) => {
    expect(planRecognizer(plan, languages, 'win32')).toBe(model);
  });

  it('uses separate CPU and GPU engines and counts shared assets only once', () => {
    const { plans } = nativePlans(input());
    expect(plans.map((p) => [p.speaker.model, p.participant.model, p.translation])).toEqual([
      [x, sense, plamo], [x, qwen, index], [big, big, index],
    ]);
    expect(plans[2].vramMB).toBe(3072 + 1536);
    expect(plans[2].downloadBytes).toBe(NATIVE_MODELS.find((m) => m.id === big)!.bytes + NATIVE_TRANSLATORS[0].bytes);
    expect(nativePlans(input({ downloaded: [big, index] })).plans[2].downloadBytes).toBe(0);
  });

  it('promotes two audio.cpp sides to the larger model which hears their union', () => {
    const { plans } = nativePlans(input({ pair: { source: 'ja', target: 'fr' } }));
    expect(plans[0].speaker.model).toBe(qwen);
    expect(plans[0].participant.model).toBe(qwen);
    expect(plans[0].vramMB).toBe(1843 + 614);
  });

  it('does not put an unknown language inside SenseVoice or X-ASR language sets', () => {
    const settings = { ...input().settings, asrDetectOther: true };
    const { plans } = nativePlans(input({ settings, pair: { source: 'ja', target: 'en' } }));
    expect(plans[0].participant.languages).toBeNull();
    expect(plans[0].speaker.model).toBe(qwen);
    expect(plans[0].participant.model).toBe(qwen);
  });

  it('uses Apple for every supported side and includes each language asset', () => {
    const settings = { ...input().settings, speakAlso: ['ja'], speakBoth: true };
    const { plans } = nativePlans(input({ settings, platform: 'darwin' }));
    for (const p of plans) {
      expect(p.speaker.model).toBe('apple-speech:zh');
      expect(p.speaker.models).toEqual(['apple-speech:zh', 'apple-speech:ja']);
      expect(p.participant.model).toBe('apple-speech:ja');
      expect(p.vramMB).toBe(NATIVE_TRANSLATORS.find((m) => m.id === p.translation)!.vramMB);
    }
    expect(nativePlans(input({ settings: { ...settings, asrDetectOther: true }, platform: 'darwin' })).plans[0].participant.model).toBe(qwen);
  });

  it('serves all required translation directions including secondary lit languages', () => {
    expect(planTranslator('light', [{ source: 'ja', target: 'en' }])).toBe(plamo);
    expect(planTranslator('light', [{ source: 'yue', target: 'en' }])).toBe(index);
    expect(planTranslator('balanced', [])).toBe(index);
    const settings = { ...input().settings, theyAlso: ['yue'], theyLit: 'yue', asrDetectOther: true };
    expect(nativePlans(input({ settings })).plans[0].translation).toBe(index);
  });

  it('matches current explicit stages, reports custom for remote stages, and prefers the recommended matching plan', () => {
    const settings = { ...input().settings, asrNativeByLanguage: { zh: x, ja: qwen }, translateNativeModel: index };
    expect(currentNativeModels(settings, input().pair)).toEqual({ speaker: x, participant: qwen, translation: index });
    expect(nativePlans(input({ settings })).current).toBe('balanced');
    expect(nativePlans(input({ settings: { ...settings, asrVia: 'api' } })).current).toBeNull();
    expect(currentNativeModels({ ...settings, translateAt: 'server' }, input().pair).translation).toBeNull();
  });

  it('identifies unsupported chips and suggests the recommended plan replacement', () => {
    const settings = { ...input().settings, asrNativeModel: x, speakBoth: true };
    const gap = nativeLanguageGap(input({ settings }), 'speaker');
    expect(gap.unsupported).toEqual(['ja']);
    expect(gap.replacement?.model).toBe(qwen);
    expect(nativeLanguageGap(input({ settings: { ...settings, asrVia: 'api' } }), 'speaker')).toEqual({ unsupported: [], replacement: null });
    expect(nativeLanguageGap(input(), 'participant').unsupported).toEqual([]);
    expect(nativeLanguageGap(input({ settings: { ...settings, asrDetectOther: true } }), 'participant').unsupported).toEqual(['ja', 'auto']);
    const mac = input({ settings: { ...settings, asrNativeModel: 'apple-speech:zh' }, platform: 'darwin', downloaded: ['apple-speech:zh'] });
    expect(nativeLanguageGap(mac, 'speaker').unsupported).toEqual(['ja']);
    expect(nativeLanguageGap({ ...mac, downloaded: ['apple-speech:zh', 'apple-speech:ja'] }, 'speaker').unsupported).toEqual([]);
  });

  it('uses the plan for the library row, including a shared-engine promotion and lending translation', () => {
    const result = nativePlans(input({ pair: { source: 'ja', target: 'fr' }, memoryMB: 4096 }));
    const p = result.plans.find((p) => p.recommended)!;
    expect(recommendNativeModel('asr', [sense, qwen], 4096, false, ['ja'], { plan: p, stage: 'speaker' }).id).toBe(qwen);
    expect(recommendNativeModel('asr', [sense], 4096, false, ['ja'], { plan: p, stage: 'speaker' }).id).toBeNull();
    expect(recommendNativeModel('translation', [plamo, index], 4096, true, ['ja']).id).toBe(index);
    expect(recommendNativeModel('asr', ['apple-speech:ja', big], 16000, false, ['ja']).id).toBe('apple-speech:ja');
  });
});

describe('native model fit', () => {
  it('shows CPU independently of known memory, and leaves Apple and unknown memory unclassified', () => {
    expect(nativeModelFit(x, 'speaker', {}, null)).toEqual({ fit: 'cpu', needMB: 0, leftMB: null });
    expect(nativeModelFit('apple-speech:ja', 'participant', {}, 8192).fit).toBeNull();
    expect(nativeModelFit(qwen, 'speaker', {}, undefined).fit).toBeNull();
    expect(nativeModelFit('unknown', 'speaker', {}, 10000).fit).toBeNull();
  });
  it('reserves the game budget and counts a shared recognizer once', () => {
    expect(nativeModelFit(big, 'speaker', { participant: big, translation: index }, 10752)).toEqual({ fit: 'smooth', needMB: 3072, leftMB: 9216 });
    expect(nativeModelFit(big, 'speaker', { participant: big, translation: index }, 10751).fit).toBe('maybe-slow');
    expect(nativeModelFit(big, 'speaker', { participant: sense, translation: index }, 5000)).toEqual({ fit: 'cannot', needMB: 3072, leftMB: 3054 });
    expect(nativeModelFit(index, 'translation', { speaker: big, participant: big }, 11000).leftMB).toBe(7928);
  });
  it('respects measured slowness without downgrading cannot, and handles exact capacity', () => {
    expect(nativeModelFit(big, 'speaker', {}, 20000, [big]).fit).toBe('maybe-slow');
    expect(nativeModelFit(big, 'speaker', {}, 2000, [big]).fit).toBe('cannot');
    expect(nativeModelFit(big, 'speaker', {}, 3072).fit).toBe('maybe-slow');
    expect(nativeModelFit(big, 'speaker', { translation: 'hy-mt1.5-1.8b' }, 20000).fit).toBeNull();
  });
});
