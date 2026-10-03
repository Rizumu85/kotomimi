import { describe, expect, it } from 'vitest';
import { modelLabel } from './modelLabel';

describe('a model\'s id as a name to read', () => {
  it('writes each part the way that kind of word is written', () => {
    expect(modelLabel('apple-speech-transcriber')).toBe('Apple Speech Transcriber');
    expect(modelLabel('whisper-large-turbo')).toBe('Whisper Large Turbo');
    expect(modelLabel('qwen3-1.7b-mlx')).toBe('Qwen3 1.7B MLX');
    expect(modelLabel('sensevoice-small-mlx')).toBe('SenseVoice Small MLX');
    expect(modelLabel('translategemma-4b')).toBe('TranslateGemma 4B');
    expect(modelLabel('gpt-realtime')).toBe('GPT Realtime');
    expect(modelLabel('silero-vad-ggml')).toBe('Silero VAD GGML');
    expect(modelLabel('whisper-large-v3')).toBe('Whisper Large V3');
  });

  it('keeps a hyphen that is part of a name, and a quantization in capitals', () => {
    expect(modelLabel('hy-mt2-1.8b')).toBe('Hy-MT2 1.8B');
    expect(modelLabel('qwen3-4b-q4_k_m')).toBe('Qwen3 4B Q4_K_M');
  });

  it('knows no model in particular: an unknown id is only capitalised', () => {
    expect(modelLabel('my-own-model')).toBe('My Own Model');
    expect(modelLabel('')).toBe('');
  });
});
