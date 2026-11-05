/**
 * Fork: how a leg is heard, decided once for every place that hears it (`hearingPlan.ts`).
 */
import { describe, expect, it } from 'vitest';
import { otherOfPair, pairedLanguage, recognitionLimits, speechDetection, toldLanguage } from './hearingPlan';

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
    expect(pairedLanguage('zh', PAIR, has)).toBe('ja');
    expect(pairedLanguage('ja-JP', PAIR, has)).toBe('zh');
    expect(pairedLanguage('zh', PAIR, (l) => l === 'zh')).toBeUndefined();
    expect(pairedLanguage('zh', { source: 'zh-CN', target: 'zh-TW' }, has)).toBeUndefined();
    expect(pairedLanguage('auto', PAIR, has)).toBeUndefined();
  });

  it('gives a model this app knows the same limits wherever it runs, the system’s own recognition by language', () => {
    expect(recognitionLimits('qwen3-asr-1.7b-q8')).toEqual(recognitionLimits('qwen3-asr-1.7b-q8', 'ja'));
    expect(recognitionLimits('qwen3-asr-1.7b-q8')).toBeDefined();
    expect(recognitionLimits('apple-speech', 'ja')).toEqual(recognitionLimits('apple-speech:ja'));
    expect(recognitionLimits('apple-speech')).toBeUndefined();
    expect(recognitionLimits('whisper-1')).toBeUndefined();
  });
});
