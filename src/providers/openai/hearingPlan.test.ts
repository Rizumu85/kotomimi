/**
 * Fork: how a leg is heard, decided once for every place that hears it (`hearingPlan.ts`).
 */
import { describe, expect, it } from 'vitest';
import { namedAmong, otherOfPair, pairedLanguages, recognitionLimits, speechDetection, tellingOf, toldLanguage } from './hearingPlan';

const PAIR = { source: 'zh-CN', target: 'ja' };

describe('how a leg is heard', () => {
  it('is cut into sentences by the same threshold and pause, here and on another Kotomimi', () => {
    const both = speechDetection({ vadThreshold: 0.35, vadMinSilenceDuration: 1.2, vadMinSpeechDuration: 0.25, vadMaxSpeechDuration: 15 });
    expect(both.vad).toEqual({ threshold: 0.35, minSilenceDuration: 1.2, minSpeechDuration: 0.25, maxSpeechDuration: 15 });
    expect(both.turnDetection).toEqual({ type: 'server_vad', threshold: 0.35, prefixPaddingMs: 300, silenceDurationMs: 1200 });
    expect(speechDetection({ vadThreshold: 0.3, vadNegativeThreshold: 0.2, vadMinSilenceDuration: 1, vadMinSpeechDuration: 0.25, vadMaxSpeechDuration: 15 }).vad.negativeThreshold).toBe(0.2);
  });

  it('tells a recognizer that cannot tell languages apart the leg’s own, and one that can "auto"', () => {
    expect(toldLanguage('auto', 'ja', false)).toBe('ja');
    expect(toldLanguage('auto', 'ja', true)).toBe('auto');
    expect(toldLanguage('zh-CN', 'ja', false)).toBe('zh-CN');
  });

  it('pairs the other of the pair’s languages where the recognizer has both', () => {
    expect(otherOfPair('zh', PAIR)).toBe('ja');
    expect(otherOfPair('ja', PAIR)).toBe('zh-CN');
    const has = (l: string) => ['zh', 'ja'].includes(l);
    expect(pairedLanguages({ most: 3, leg: 'participant', told: 'zh', pair: PAIR, has })).toEqual(['ja']);
    expect(pairedLanguages({ most: 3, leg: 'participant', told: 'ja-JP', pair: PAIR, has })).toEqual(['zh']);
    expect(pairedLanguages({ most: 3, leg: 'participant', told: 'zh', pair: PAIR, has: (l) => l === 'zh' })).toEqual([]);
    expect(pairedLanguages({ most: 3, leg: 'participant', told: 'zh', pair: { source: 'zh-CN', target: 'zh-TW' }, has })).toEqual([]);
    expect(pairedLanguages({ most: 3, leg: 'participant', told: 'auto', pair: PAIR, has })).toEqual([]);
  });

  it('uses the lit languages in priority order up to the number of recognizers', () => {
    expect(pairedLanguages({ most: 3, leg: 'participant', told: 'ja', pair: PAIR, theirLit: ['ja', 'en'] })).toEqual(['en', 'zh']);
    expect(pairedLanguages({ most: 3, leg: 'participant', told: 'ja', pair: PAIR, theirLit: ['ja', 'auto'] })).toEqual(['zh']);
    const speaker = { leg: 'speaker' as const, told: 'zh-CN', pair: PAIR, alsoSpoken: ['ja', 'en'] };
    expect(pairedLanguages({ ...speaker, most: 3 })).toEqual(['ja', 'en']);
    expect(pairedLanguages({ ...speaker, most: 2 })).toEqual(['ja']);
    expect(pairedLanguages({ ...speaker, most: 2, alsoSpoken: [] })).toEqual(['ja']);
  });

  it('distinguishes naming, pairing and hearing the language told', () => {
    expect(tellingOf('device', 'apple-speech:ja')).toEqual({ by: 'pairing', most: 3 });
    expect(tellingOf('api', 'apple-speech')).toEqual({ by: 'pairing', most: 2 });
    expect(tellingOf('device', 'qwen3-asr-1.7b-q8')).toEqual({ by: 'naming' });
    expect(tellingOf('server', 'custom', [{ id: 'custom', kind: 'asr', languages: ['auto'] }])).toEqual({ by: 'naming' });
    expect(tellingOf('api', 'custom')).toEqual({ by: 'told' });
  });

  it('gives a model this app knows the same limits wherever it runs, the system’s own recognition by language', () => {
    expect(recognitionLimits('qwen3-asr-1.7b-q8')).toEqual(recognitionLimits('qwen3-asr-1.7b-q8', 'ja'));
    expect(recognitionLimits('qwen3-asr-1.7b-q8')).toBeDefined();
    expect(recognitionLimits('apple-speech', 'ja')).toEqual(recognitionLimits('apple-speech:ja'));
    expect(recognitionLimits('apple-speech')).toBeUndefined();
    expect(recognitionLimits('whisper-1')).toBeUndefined();
  });
});

describe('the languages a detected leg is named among', () => {
  it('are the speaker’s own and the others they speak, by base code', () => {
    expect(namedAmong('auto', 'zh-CN', ['ko', 'en-US', 'ko'])).toEqual(['zh', 'ko', 'en']);
  });

  it('are none for a leg told its language, one with no others, or one that may be in any', () => {
    expect(namedAmong('zh-CN', 'zh-CN', ['ko'])).toEqual([]);
    expect(namedAmong('auto', 'zh-CN', [])).toEqual([]);
    expect(namedAmong('auto', 'zh-CN', ['ko', 'auto'])).toEqual([]);
  });
});
