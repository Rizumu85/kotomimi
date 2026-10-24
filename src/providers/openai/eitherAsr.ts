/**
 * Fork: a recognizer that is one of two, decided when it starts. An address named as an API may be a Kotomimi phone
 * lending its engine (`src/lib/native/remoteEngine.ts`): asked once, when the run begins, it is then read the way
 * this computer's own engine is — while the voice is heard — instead of a sentence at a time. Nothing of that is a
 * setting: the same address, whatever answers at it.
 *
 * It stands where either would (`AsrLike`); what is set on it reaches the one chosen, before or after the choice.
 */
import type { AsrInit, AsrLike } from '../localInference/engines';

type Heard = Pick<AsrLike, 'onPartialResult' | 'onResult' | 'onSpeechStart' | 'onError' | 'onFatal'>;

export function createEitherAsr(choose: () => Promise<AsrLike>): AsrLike {
  let chosen: AsrLike | null = null;
  let disposed = false;
  const outer: AsrLike = {
    async init(modelId: string, options: AsrInit) {
      const made = await choose();
      if (disposed) { made.dispose(); return; }
      chosen = made;
      // Through the outer one each time: a listener set later is the one called.
      const heard: Heard = {
        onPartialResult: (text) => outer.onPartialResult?.(text),
        onResult: (result) => outer.onResult?.(result),
        onSpeechStart: () => outer.onSpeechStart?.(),
        onError: (error) => outer.onError?.(error),
        onFatal: (error) => outer.onFatal?.(error),
      };
      Object.assign(made, heard);
      await made.init(modelId, options);
    },
    feedAudio(samples, sampleRate) { chosen?.feedAudio(samples, sampleRate); },
    flush() { chosen?.flush(); },
    dispose() {
      disposed = true;
      chosen?.dispose();
      chosen = null;
    },
    onPartialResult: null,
    onResult: null,
    onSpeechStart: null,
    onError: null,
    onFatal: null,
  };
  return outer;
}
