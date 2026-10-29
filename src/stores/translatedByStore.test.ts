import { beforeEach, describe, expect, it } from 'vitest';
import { servedModelOf, translatedByFrames, useTranslatedByStore } from './translatedByStore';

beforeEach(() => useTranslatedByStore.getState().clear());

describe('translatedByStore (fork: what another device translated a leg with)', () => {
  const done = (payload: Record<string, unknown>) => ({ direction: 'in' as const, type: 'text.done', payload });

  it('reads the model a translation says it was answered by, and nothing else', () => {
    expect(servedModelOf(done({ stage: 'translate', model: 'kotomimi', served: 'hy-mt2-1.8b' }))).toBe('hy-mt2-1.8b');
    // Feedback is not a translation; a frame that names none is nothing to show.
    expect(servedModelOf(done({ stage: 'coach', served: 'gemma-4-e2b' }))).toBeNull();
    expect(servedModelOf(done({ stage: 'translate' }))).toBeNull();
    expect(servedModelOf(done({ stage: 'translate', served: '  ' }))).toBeNull();
    expect(servedModelOf({ direction: 'out', type: 'text.done', payload: { stage: 'translate', served: 'x' } })).toBeNull();
    expect(servedModelOf({ direction: 'in', type: 'text.failed', payload: { stage: 'translate', served: 'x' } })).toBeNull();
  });

  it('notes each leg’s model from the run’s frames, and forgets them all when cleared', () => {
    const port = translatedByFrames();
    port.frame('participant', done({ stage: 'translate', served: 'index-translate-2b' }));
    port.frame('speaker', done({ stage: 'coach', served: 'gemma-4-e2b' }));
    port.frame('speaker', done({ stage: 'translate', served: 'hy-mt15-1.8b-translation' }));
    expect(useTranslatedByStore.getState().byLeg).toEqual({ participant: 'index-translate-2b', speaker: 'hy-mt15-1.8b-translation' });
    useTranslatedByStore.getState().clear();
    expect(useTranslatedByStore.getState().byLeg).toEqual({});
  });
});
