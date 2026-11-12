import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { recommendNativeModel } from './nativeRecommendation';
import { NATIVE_MODELS } from './localaiNative';
import { NATIVE_TRANSLATORS } from './nativeTranslators';

const ASR = NATIVE_MODELS.filter((m) => !m.id.startsWith('apple-speech:')).map((m) => m.id);
const TRANSLATION = NATIVE_TRANSLATORS.map((m) => m.id);

describe('native model recommendation', () => {
  it('uses the same SenseVoice languages as the native engine catalog', () => {
    const { MODELS } = createRequire(import.meta.url)('../../../electron/native-engine.js');
    expect(NATIVE_MODELS.find((m) => m.id === 'sensevoice-small-q8')?.languages)
      .toEqual(MODELS['sensevoice-small-q8'].languages);
  });

  it.each([
    [null, false, ['ja'], 'qwen3-asr-0.6b-q8', 'default'],
    [0, false, ['zh-CN', 'ja'], 'sensevoice-small-q8', 'small'],
    [7679, false, ['zh-TW', 'yue', 'en-US', 'ja', 'ko'], 'sensevoice-small-q8', 'small'],
    [7679, false, ['ja', 'fr'], 'qwen3-asr-0.6b-q8', 'default'],
    [7679, false, ['auto'], 'qwen3-asr-0.6b-q8', 'default'],
    [4096, false, [], 'qwen3-asr-0.6b-q8', 'default'],
    [7680, false, ['ja'], 'qwen3-asr-0.6b-q8', 'default'],
    [8100, false, ['ja'], 'qwen3-asr-0.6b-q8', 'default'],
    [8192, false, ['ja'], 'qwen3-asr-0.6b-q8', 'default'],
    [15359, false, ['ja'], 'qwen3-asr-0.6b-q8', 'default'],
    [15360, false, ['ja'], 'qwen3-asr-1.7b-q8', 'big'],
    [16303, false, ['ja'], 'qwen3-asr-1.7b-q8', 'big'],
    [16384, false, ['ja'], 'qwen3-asr-1.7b-q8', 'big'],
    [24576, false, ['fr'], 'qwen3-asr-1.7b-q8', 'big'],
    [null, true, ['fr'], 'qwen3-asr-1.7b-q8', 'lending'],
    [2048, true, ['ja'], 'qwen3-asr-1.7b-q8', 'lending'],
    [24576, true, ['ja'], 'qwen3-asr-1.7b-q8', 'lending'],
  ] as const)('ASR: %s MB, lending %s, languages %j', (memory, lending, languages, id, reason) => {
    expect(recommendNativeModel('asr', ASR, memory, lending, languages)).toEqual({ id, reason });
  });

  it.each([0, 4096, 7679])('recommends the small translator below 7.5 GiB (%s MB)', (memory) => {
    expect(recommendNativeModel('translation', TRANSLATION, memory, false, ['en', 'ja']))
      .toEqual({ id: 'plamo-3-translate-0.8b', reason: 'small' });
  });

  it.each([null, 7680, 8100, 8192, 16384])('otherwise recommends Index (%s MB)', (memory) => {
    expect(recommendNativeModel('translation', TRANSLATION, memory, false, ['en', 'ja']))
      .toEqual({ id: 'index-translate-2b', reason: 'default' });
  });

  it('falls back to the first offered model when the preferred one does not serve the row', () => {
    expect(recommendNativeModel('translation', ['hy-mt2-1.8b'], 4096, false, ['en', 'fr']))
      .toEqual({ id: 'hy-mt2-1.8b', reason: 'default' });
    expect(recommendNativeModel('asr', ['r2t2-q8'], 24576, true, ['ja']))
      .toEqual({ id: 'r2t2-q8', reason: 'default' });
    expect(recommendNativeModel('asr', [], null, false, ['ja']))
      .toEqual({ id: null, reason: 'default' });
  });
});
