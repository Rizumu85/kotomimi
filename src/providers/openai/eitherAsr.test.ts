/**
 * Fork: a recognizer that is one of two, decided when it starts (`eitherAsr.ts`).
 */
import { describe, expect, it, vi } from 'vitest';
import type { AsrInit, AsrLike } from '../localInference/engines';
import { createEitherAsr } from './eitherAsr';

const INIT = { language: 'ja', vadConfig: {} } as unknown as AsrInit;

function stand(): AsrLike & { inits: unknown[]; fed: number; flushed: number; disposed: boolean } {
  const one = {
    inits: [] as unknown[],
    fed: 0,
    flushed: 0,
    disposed: false,
    async init(modelId: string, options: AsrInit) { one.inits.push([modelId, options]); },
    feedAudio() { one.fed += 1; },
    flush() { one.flushed += 1; },
    dispose() { one.disposed = true; },
    onPartialResult: null,
    onResult: null,
    onSpeechStart: null,
    onError: null,
    onFatal: null,
  } as AsrLike & { inits: unknown[]; fed: number; flushed: number; disposed: boolean };
  return one;
}

describe('a recognizer that is one of two', () => {
  it('starts the one chosen, and is that one from then on', async () => {
    const chosen = stand();
    const either = createEitherAsr(async () => chosen);
    await either.init('m', INIT);
    expect(chosen.inits).toEqual([['m', INIT]]);
    either.feedAudio(new Int16Array(4), 24000);
    either.flush();
    expect([chosen.fed, chosen.flushed]).toEqual([1, 1]);
    either.dispose();
    expect(chosen.disposed).toBe(true);
  });

  it('hands on what the chosen one hears to whoever listens, set before the choice or after', async () => {
    const chosen = stand();
    const either = createEitherAsr(async () => chosen);
    const partials = vi.fn();
    either.onPartialResult = partials;
    await either.init('m', INIT);
    const results = vi.fn();
    either.onResult = results;
    chosen.onPartialResult?.('こん');
    chosen.onResult?.({ text: 'こんにちは', durationMs: 900, recognitionTimeMs: 120 });
    expect(partials).toHaveBeenCalledWith('こん');
    expect(results).toHaveBeenCalledWith({ text: 'こんにちは', durationMs: 900, recognitionTimeMs: 120 });
  });

  it('takes no sound before the choice is made, and fails its start when the choice does', async () => {
    const either = createEitherAsr(async () => { throw new Error('nothing answers there'); });
    either.feedAudio(new Int16Array(4), 24000);
    await expect(either.init('m', INIT)).rejects.toThrow('nothing answers there');
  });

  it('lets go of a choice that came after it was disposed', async () => {
    const chosen = stand();
    let choose!: (one: AsrLike) => void;
    const either = createEitherAsr(() => new Promise<AsrLike>((resolve) => { choose = resolve; }));
    const starting = either.init('m', INIT);
    either.dispose();
    choose(chosen);
    await starting;
    expect(chosen.disposed).toBe(true);
    expect(chosen.inits).toEqual([]);
  });
});
