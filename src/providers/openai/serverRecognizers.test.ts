// src/providers/openai/serverRecognizers.test.ts
import { describe, expect, it } from 'vitest';
import { AUTO } from '../../lib/provider/languages';
import type { LocalAIModel } from './localaiModels';
import { choiceOf, perLanguage, recognizerAsked, recognizerChoices } from './serverRecognizers';

/** A Mac sharing its models: the system's recognition for four languages, and a downloaded recognizer that hears many. */
const MAC: LocalAIModel[] = [
  { id: 'apple-speech:ja', name: 'apple-speech:ja', kind: 'asr', languages: ['ja'] },
  { id: 'apple-speech:en', name: 'apple-speech:en', kind: 'asr', languages: ['en'] },
  { id: 'apple-speech:ko', name: 'apple-speech:ko', kind: 'asr', languages: ['ko'] },
  { id: 'apple-speech:es', name: 'apple-speech:es', kind: 'asr', languages: ['es'] },
  { id: 'qwen3-asr-1.7b-q8', name: 'qwen3-asr-1.7b-q8', kind: 'asr', languages: ['ja', 'zh', 'en', 'ko'] },
  { id: 'kotoba-whisper', name: 'kotoba-whisper', kind: 'asr', languages: ['ja'] },
  { id: 'whisper-large', name: 'whisper-large', kind: 'asr' },
] as unknown as LocalAIModel[];

describe('the other device\u2019s recognizers, as a person chooses among them', () => {
  it('knows a recognizer that is one to a language by its name', () => {
    expect(perLanguage('apple-speech:ja')).toEqual({ family: 'apple-speech', language: 'ja' });
    expect(perLanguage('qwen3-asr-1.7b-q8')).toBeNull();
    expect(choiceOf('apple-speech:ko')).toBe('apple-speech');
    expect(choiceOf('whisper-large')).toBe('whisper-large');
  });

  it('lists a family once, and only what hears a language of this run', () => {
    // Japanese into Chinese, one way: nothing that hears neither is offered — not Korean's or Spanish's recognition.
    expect(recognizerChoices(MAC, ['ja'])).toEqual(['apple-speech', 'qwen3-asr-1.7b-q8', 'kotoba-whisper', 'whisper-large']);
    // Chinese heard: the system's recognition has none for it there, and the Japanese-only model does not hear it.
    expect(recognizerChoices(MAC, ['zh-CN'])).toEqual(['qwen3-asr-1.7b-q8', 'whisper-large']);
    // Both ways: what hears either.
    expect(recognizerChoices(MAC, ['ja', 'zh-CN'])).toEqual(['apple-speech', 'qwen3-asr-1.7b-q8', 'kotoba-whisper', 'whisper-large']);
    // A language left to be detected, or none known yet: everything, the family still once.
    expect(recognizerChoices(MAC, [AUTO, 'ja'])).toEqual(['apple-speech', 'qwen3-asr-1.7b-q8', 'kotoba-whisper', 'whisper-large']);
    expect(recognizerChoices(MAC, [])).toHaveLength(4);
  });

  it('asks each leg for the family\u2019s member for the language it hears', () => {
    expect(recognizerAsked('apple-speech', 'ja', MAC)).toBe('apple-speech:ja');
    expect(recognizerAsked('apple-speech', 'en-US', MAC)).toBe('apple-speech:en');
    // No member for the language: the device chooses, rather than being asked for one that hears another.
    expect(recognizerAsked('apple-speech', 'zh-CN', MAC)).toBe('');
    expect(recognizerAsked('apple-speech', AUTO, MAC)).toBe('');
    // A choice saved by an earlier version, as one member: the family all the same.
    expect(recognizerAsked('apple-speech:ja', 'en', MAC)).toBe('apple-speech:en');
    expect(recognizerAsked('apple-speech:ja', 'zh', MAC)).toBe('');
  });

  it('asks for any other choice as it is, and for nothing where nothing was chosen', () => {
    expect(recognizerAsked('qwen3-asr-1.7b-q8', 'zh', MAC)).toBe('qwen3-asr-1.7b-q8');
    expect(recognizerAsked('a-model-of-a-localai', 'ja', [])).toBe('a-model-of-a-localai');
    expect(recognizerAsked('', 'ja', MAC)).toBe('');
  });
});
