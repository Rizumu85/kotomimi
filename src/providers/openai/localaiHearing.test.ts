/**
 * Fork: what each side may speak beside its main language, and what hears it (`localaiLanguages.more`), on every
 * place a leg can run: another device's Apple Speech, a model it lends, an API whose reach is not known.
 */
import { describe, it, expect } from 'vitest';
import { LOCALAI_DEFAULTS, localaiLanguages, type LocalAIModel } from './localai';

const PAIR = { source: 'zh-CN', target: 'ja' };
/** Another Kotomimi on a Mac, as it lists itself (`/v1/models/capabilities`): its recognition a language at a time, and its models. */
const QWEN = ['zh', 'en', 'yue', 'de', 'fr', 'es', 'pt', 'it', 'ko', 'ru', 'ja'];
const MAC: LocalAIModel[] = [
  { id: 'apple-speech:ja', kind: 'asr', languages: ['ja'], bilingual: true },
  { id: 'apple-speech:en', kind: 'asr', languages: ['en'], bilingual: true },
  { id: 'apple-speech:zh', kind: 'asr', languages: ['zh'], bilingual: true },
  { id: 'qwen3-asr-1.7b-q8', kind: 'asr', languages: [...QWEN, 'auto'] },
  { id: 'sensevoice-small-q8', kind: 'asr', languages: ['zh', 'yue', 'en', 'ja', 'ko', 'auto'] },
] as LocalAIModel[];
const more = (settings: Record<string, unknown>) => localaiLanguages.more!({ ...LOCALAI_DEFAULTS, ...settings } as never, MAC, PAIR);

describe('the languages beside each side’s main one', () => {
  it('has the Mac’s recognition on another device hear one beside the user’s own, and none beside theirs', () => {
    const { mine, theirs } = more({ asrVia: 'server', asrModel: 'apple-speech', speakAlso: ['ja', 'en', 'es'] });
    expect(mine).toMatchObject({ hearer: { name: 'Apple Speech' }, offered: ['ja'], most: 1, chosen: ['ja'] });
    expect(theirs).toMatchObject({ most: 0 });
    expect(mine!.set(['ja'])).toEqual({ speakAlso: ['ja'], speakBoth: false });
  });

  it('has a model that tells languages apart, lent by another device, take as many as it has — any, where it has many', () => {
    const { mine, theirs } = more({ asrVia: 'server', asrModel: 'qwen3-asr-1.7b-q8' });
    expect(mine).toMatchObject({ hearer: { name: 'Qwen3-ASR 1.7B' }, most: null, any: true });
    expect(theirs).toMatchObject({ most: null, any: true });
    // Their row is kept as given; what is lit is lit apart (`light`).
    expect(theirs!.set(['ja', 'ko'])).toMatchObject({ theyAlso: ['ja', 'ko'] });
    expect(theirs!.light!('ko')).toEqual({ theyLit: 'ko', asrDetectOther: true });
  });

  it('keeps SenseVoice to its five, with no "any language"', () => {
    const { theirs } = more({ asrVia: 'server', asrModel: 'sensevoice-small-q8' });
    expect(theirs).toMatchObject({ most: null, any: false });
    expect([...theirs!.offered!].sort()).toEqual(['en', 'ja', 'ko', 'yue', 'zh']);
  });

  it('gives an API, whose reach is not known, its main language alone', () => {
    const { mine, theirs } = more({ asrVia: 'api', asrApiBaseUrl: 'http://example.test/v1', asrApiModel: 'whisper-1' });
    expect(mine!.most).toBe(0);
    expect(theirs!.most).toBe(0);
  });

  it('counts an older "I speak theirs too" and "detect their language" among the languages chosen', () => {
    const { mine, theirs } = more({ asrVia: 'server', asrModel: 'qwen3-asr-1.7b-q8', speakBoth: true, asrDetectOther: true });
    expect(mine!.chosen).toEqual(['ja']);
    // Their row holds their main language, and "any language" lit beside it.
    expect(theirs!.chosen).toEqual(['ja', 'auto']);
    expect(theirs!.lit).toBe('auto');
  });

  it('switches their languages by hand: their row holds the main one, one lit beside it; a light taken out of the row goes', () => {
    const theirs = (settings: Record<string, unknown>) => more({ asrVia: 'server', asrModel: 'qwen3-asr-1.7b-q8', ...settings }).theirs!;
    expect(theirs({ theyAlso: ['ko', 'es'] })).toMatchObject({ chosen: ['ja', 'ko', 'es'], lit: '' });
    expect(theirs({ theyAlso: ['ja', 'ko', 'es'], theyLit: 'es', asrDetectOther: true }).lit).toBe('es');
    // An older build followed them by itself, with no light: the first of theirs, or any.
    expect(theirs({ theyAlso: ['ko', 'es'], asrDetectOther: true }).lit).toBe('ko');
    expect(theirs({ asrDetectOther: true }).lit).toBe('auto');
    const side = theirs({ theyAlso: ['ja', 'ko', 'es'], theyLit: 'ko', asrDetectOther: true });
    expect(side.light!('')).toEqual({ theyLit: '', asrDetectOther: false });
    expect(side.set(['ja', 'es'])).toEqual({ theyAlso: ['ja', 'es'], theyLit: '', asrDetectOther: false });
    expect(side.set(['ja', 'ko'])).toEqual({ theyAlso: ['ja', 'ko'] });
  });

  it('uses only those of the user’s other languages the other side has lit, so a long list does not muddle what is heard', () => {
    const mine = (settings: Record<string, unknown>) => more({ asrVia: 'server', asrModel: 'qwen3-asr-1.7b-q8', speakAlso: ['en', 'ko', 'ja'], ...settings }).mine!;
    expect(mine({}).chosen).toEqual(['en', 'ko', 'ja']);
    expect(mine({}).using).toEqual(['ja']);
    expect(mine({ theyAlso: ['ja', 'ko'], theyLit: 'ko', asrDetectOther: true }).using).toEqual(['ko', 'ja']);
    // "Any language" lit: any of them may be it.
    expect(mine({ theyAlso: ['auto'], theyLit: 'auto', asrDetectOther: true }).using).toEqual(['en', 'ko', 'ja']);
  });
});
