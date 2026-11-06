/**
 * Fork: what the language section names as hearing each side, and the languages it offers for "我也会说"
 * (`localaiLanguages.hearing`, `localaiLanguages.speakAlso`).
 */
import { describe, it, expect } from 'vitest';
import { LOCALAI_DEFAULTS, localaiLanguages, type LocalAIModel } from './localai';

const PAIR = { source: 'zh-CN', target: 'ja' };
/** Another Kotomimi on a Mac: its recognition listed a language at a time, and its downloaded models. */
const MAC: LocalAIModel[] = [
  { id: 'apple-speech:ja' }, { id: 'apple-speech:en' }, { id: 'apple-speech:zh' }, { id: 'qwen3-asr-1.7b-q8' },
] as LocalAIModel[];

describe('what hears, and what the user can say they also speak', () => {
  it('names the Mac’s recognition on another device as Apple Speech, and offers only the other side’s language beside the user’s own', () => {
    const settings = { ...LOCALAI_DEFAULTS, asrVia: 'server' as const, asrModel: 'apple-speech', speakAlso: ['ja', 'en', 'es'] };
    const hearing = localaiLanguages.hearing!(settings, MAC, PAIR);
    expect(hearing.mine).toMatchObject({ name: 'Apple Speech' });
    const also = localaiLanguages.speakAlso!(settings, MAC, PAIR);
    // It hears one language beside the user's own: theirs, the one chip, and the only one shown picked.
    expect(also.offered).toEqual(['ja']);
    expect(also.chosen).toEqual(['ja']);
    // A pick there writes the list as it is now, the older switch off.
    expect(also.set(['ja'])).toEqual({ speakAlso: ['ja'], speakBoth: false });
  });

  it('offers every language where what hears is not known to pair two (an API, another model)', () => {
    const settings = { ...LOCALAI_DEFAULTS, asrVia: 'server' as const, asrModel: 'qwen3-asr-1.7b-q8', speakAlso: ['ja', 'en'] };
    const also = localaiLanguages.speakAlso!(settings, MAC, PAIR);
    expect(also.offered).toBeNull();
    expect(also.chosen).toEqual(['ja', 'en']);
    expect(localaiLanguages.hearing!(settings, MAC, PAIR).mine).toMatchObject({ name: 'Qwen3-ASR 1.7B' });
  });

  it('counts an older "I speak theirs too" as the other side’s language among those spoken', () => {
    const settings = { ...LOCALAI_DEFAULTS, asrVia: 'server' as const, asrModel: 'qwen3-asr-1.7b-q8', speakBoth: true, speakAlso: [] };
    expect(localaiLanguages.speakAlso!(settings, MAC, PAIR).chosen).toEqual(['ja']);
  });
});
