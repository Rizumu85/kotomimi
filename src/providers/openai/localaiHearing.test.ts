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
    expect(theirs!.set(['ko', 'es'])).toEqual({ theyAlso: ['ko', 'es'], asrDetectOther: true });
    expect(theirs!.set([])).toEqual({ theyAlso: [], asrDetectOther: false });
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
    expect(theirs!.chosen).toEqual(['auto']);
  });

  it('follows the other side into whatever they were last heard in, where their language is detected', () => {
    const follows = (settings: Record<string, unknown>) => localaiLanguages.follows!({ ...LOCALAI_DEFAULTS, asrVia: 'server', asrModel: 'qwen3-asr-1.7b-q8', ...settings } as never, MAC, PAIR);
    expect(follows({ theyAlso: ['ko'], asrDetectOther: true })).toBe(true);
    expect(follows({ theyAlso: ['auto'], asrDetectOther: true })).toBe(true);
    expect(follows({})).toBe(false);
  });
});
