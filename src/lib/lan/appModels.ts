/** Native models available to the sharing host and its settings. */
import { NATIVE_TRANSLATORS, nativeTranslates } from '../../providers/openai/nativeTranslators';
import { nativeTaken } from '../../providers/openai/localaiNative';
import type { LanModels } from './host';
import { nativeCoachFor, nativeRecognizerFor, nativeShared, nativeTranslatorFor } from './nativeShare';

const isNativeTranslator = (id: string): boolean => NATIVE_TRANSLATORS.some((m) => m.id === id);
/** A stale remote choice is treated as automatic, as with any model no longer shared. */
const knownHere = (name: string): string => (name && nativeShared().some((m) => m.id === name) ? name : '');

export const appLanModels: LanModels = {
  shared: nativeShared,
  recognizer: (language, named, also) => nativeRecognizerFor(language, also ? named : knownHere(named), also),
  translator: (source, target, named) => nativeTranslatorFor(source, target, knownHere(named)),
  refusal(source, target, named_) {
    const wanted = knownHere(named_);
    if (!wanted) return null;
    if (isNativeTranslator(wanted)) {
      const model = NATIVE_TRANSLATORS.find((m) => m.id === wanted)!;
      if (!nativeTranslates(model, source, target)) return 'unfit';
      const taken = nativeTaken('translation');
      if (taken && taken !== wanted) {
        const other = NATIVE_TRANSLATORS.find((m) => m.id === taken);
        return other && nativeTranslates(other, source, target) ? null : 'busy';
      }
      return null;
    }
    return null;
  },
  coach: nativeCoachFor,
};
