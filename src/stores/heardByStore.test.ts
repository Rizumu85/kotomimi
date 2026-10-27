import { beforeEach, describe, expect, it } from 'vitest';
import { heardByFrames, heardModelOf, useHeardByStore } from './heardByStore';

beforeEach(() => useHeardByStore.getState().clear());

describe('heardByStore (fork: what another device hears a leg with)', () => {
  const updated = (model: unknown) => ({ direction: 'in' as const, type: 'session.updated', payload: { audio: { input: { transcription: { model, language: 'es' } } } } });

  it('reads the model a confirmed configuration names, and nothing else', () => {
    expect(heardModelOf(updated('qwen3-asr-1.7b-q8'))).toBe('qwen3-asr-1.7b-q8');
    expect(heardModelOf(updated(undefined))).toBeNull();
    expect(heardModelOf({ direction: 'out', type: 'session.update', payload: updated('x').payload })).toBeNull();
    expect(heardModelOf({ direction: 'in', type: 'session.updated', payload: null })).toBeNull();
  });

  it('notes each leg’s model from the run’s frames, and forgets them all when cleared', () => {
    const port = heardByFrames();
    port.frame('participant', updated('qwen3-asr-1.7b-q8'));
    port.frame('speaker', updated('apple-speech:zh'));
    port.frame('speaker', { direction: 'in', type: 'conversation.item.created', payload: {} });
    expect(useHeardByStore.getState().byLeg).toEqual({ participant: 'qwen3-asr-1.7b-q8', speaker: 'apple-speech:zh' });
    useHeardByStore.getState().clear();
    expect(useHeardByStore.getState().byLeg).toEqual({});
  });
});
