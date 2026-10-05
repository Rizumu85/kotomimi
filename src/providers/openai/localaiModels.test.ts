import { describe, expect, it } from 'vitest';
import { kindOf, modelsFor, type LocalAIModel } from './localaiModels';

/** The Realtime server's models, sorted by its capability list, and what the translation stage's other server lists. */
const SORTED: LocalAIModel[] = [
  { id: 'apple-speech-transcriber', kind: 'asr' },
  { id: 'hy-mt2-1.8b', kind: 'text' },
  { id: 'qwen3-1.7b-mlx', kind: 'asr' },
  { id: 'gpt-realtime', kind: 'pipeline' },
  { id: 'qwen3-4b', kind: 'text' },
  { id: 'silero-vad-ggml', kind: 'other' },
  { id: 'llama3.3', kind: 'text', from: 'translate' },
  { id: 'gpt-5-mini', kind: 'text', from: 'coach' },
];
const ids = (models: LocalAIModel[]) => models.map((m) => m.id);

describe('what a LocalAI model is for', () => {
  it('reads the server\'s capabilities: a recognizer, a text model, a pipeline with none of its own, or nothing a stage uses', () => {
    expect(kindOf(['transcript'])).toBe('asr');
    expect(kindOf(['chat', 'completion', 'vision'])).toBe('text');
    expect(kindOf(['chat', 'vision', 'thinking'])).toBe('text');
    expect(kindOf(['completion'])).toBe('text');
    expect(kindOf(null)).toBe('pipeline');
    expect(kindOf([])).toBe('pipeline');
    expect(kindOf(['vad'])).toBe('other');
    expect(kindOf(['tts'])).toBe('other');
    expect(kindOf('chat')).toBe('pipeline');
  });
});

describe('the models a slot may choose from', () => {
  it('offers each slot only the models that can do its work', () => {
    expect(ids(modelsFor(SORTED, 'pipeline'))).toEqual(['gpt-realtime']);
    expect(ids(modelsFor(SORTED, 'asr'))).toEqual(['apple-speech-transcriber', 'qwen3-1.7b-mlx']);
    expect(ids(modelsFor(SORTED, 'translate'))).toEqual(['hy-mt2-1.8b', 'qwen3-4b']);
    expect(ids(modelsFor(SORTED, 'coach'))).toEqual(['hy-mt2-1.8b', 'qwen3-4b']);
  });

  it('offers a text slot its own server\'s list when it names one, and never the other slot\'s', () => {
    expect(ids(modelsFor(SORTED, 'translate', false))).toEqual(['llama3.3']);
    expect(ids(modelsFor(SORTED, 'coach', false))).toEqual(['gpt-5-mini']);
    // Another server not asked yet lists nothing: the view then leaves a field to type into.
    expect(modelsFor(SORTED.filter((m) => !m.from), 'translate', false)).toEqual([]);
  });

  it('leaves every model in every slot when the server says nothing of their kinds', () => {
    const unsorted: LocalAIModel[] = [{ id: 'a' }, { id: 'b' }, { id: 'remote', kind: 'text', from: 'translate' }];
    for (const slot of ['pipeline', 'asr', 'translate', 'coach'] as const) expect(ids(modelsFor(unsorted, slot)), slot).toEqual(['a', 'b']);
  });
});

describe('another Kotomimi\u2019s feedback model', () => {
  it('is one the feedback stage can ask, and no other stage', () => {
    expect(kindOf(['feedback'])).toBe('feedback');
    const there: LocalAIModel[] = [
      { id: 'kotomimi', kind: 'pipeline', host: 'kotomimi' },
      { id: 'qwen3-asr-1.7b-q8', kind: 'asr', host: 'kotomimi' },
      { id: 'index-translate-2b', kind: 'translate', host: 'kotomimi' },
      { id: 'gemma-4-e2b', kind: 'feedback', host: 'kotomimi' },
    ] as never;
    expect(modelsFor(there, 'coach').map((m) => m.id)).toEqual(['gemma-4-e2b']);
    expect(modelsFor(there, 'translate').map((m) => m.id)).toEqual(['index-translate-2b']);
    expect(modelsFor(there, 'asr').map((m) => m.id)).toEqual(['qwen3-asr-1.7b-q8']);
  });
});
