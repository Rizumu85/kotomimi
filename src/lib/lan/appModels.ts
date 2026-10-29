/**
 * Fork: what this computer can share right now, as the model store and the
 * catalog say — for the sharing host, and for the settings that show it.
 * Apart from `appHost.ts` so the settings read it without loading the
 * engines.
 */
import {
  asrEntryLanguages, deviceReady, getManifestByType, getManifestEntry, isTranslationModelCompatible, type ModelManifestEntry,
} from '../local-inference/modelManifest';
import { offeredLanguages } from '../local-inference/selection/measuredRank';
import type { Selections } from '../local-inference/selection/types';
import { useModelStore } from '../../stores/modelStore';
import { useProviderStore } from '../../stores/providerStore';
import { NATIVE_TRANSLATORS, nativeTranslates } from '../../providers/openai/nativeTranslators';
import { nativeTaken } from '../../providers/openai/localaiNative';
import type { LanModels } from './host';
import { nativeCoachFor, nativeRecognizerFor, nativeShared, nativeTranslatorFor } from './nativeShare';
import type { SharedModel } from './protocol';

const isNativeTranslator = (id: string): boolean => NATIVE_TRANSLATORS.some((m) => m.id === id);

const isRecognizer = (entry: ModelManifestEntry | undefined): entry is ModelManifestEntry => entry?.type === 'asr' || entry?.type === 'asr-stream';

/**
 * A model this computer can lend now: downloaded, and its device present. An online service the app can use for
 * itself (Bing, for translation with no model downloaded) is not one: what another device says would be sent on to
 * it, and "sharing this computer's models" says nothing of that.
 */
function usable(entry: ModelManifestEntry | undefined): entry is ModelManifestEntry {
  if (!entry || entry.isCloudModel) return false;
  const { modelStatuses, webgpuAvailable } = useModelStore.getState();
  return modelStatuses[entry.id] === 'downloaded' && deviceReady(entry, webgpuAvailable);
}

/** A model's name as another device gave it, where this computer shares one by it; empty where it shares none. */
const knownHere = (name: string): string => (name && appLanModels.shared().some((m) => m.id === name) ? name : '');

/**
 * The translation models this computer's own settings chose for a direction, where they are known: what its owner
 * picked for a pair is what a device left to this computer gets, as it would get it for itself. Empty where no
 * choice was made (or the provider was never loaded): every direction is automatic then.
 */
function hostSelections(): Selections {
  const settings = useProviderStore.getState().entries.localai?.settings as { selections?: Selections } | undefined;
  return settings?.selections ?? {};
}

/** What the model store answers, for the sharing host. */
export const appLanModels: LanModels = {
  shared(): SharedModel[] {
    // A recognizer is listed with the languages it is offered for here: not one it was found unusable for (`measuredRank.ts`).
    const recognizers = [...getManifestByType('asr'), ...getManifestByType('asr-stream')].filter(usable)
      .map((m): SharedModel => ({ id: m.id, kind: 'asr', languages: m.multilingual ? [] : offeredLanguages(m.id, [...new Set(asrEntryLanguages(m))]) }));
    const translators = getManifestByType('translation').filter(usable)
      .map((m): SharedModel => {
        // A model of every language lists none: the list is what a device reads to rule a model out.
        const any = m.languages.includes('multilingual');
        return {
          id: m.id,
          kind: 'translate',
          languages: m.sourceLang && m.targetLang ? [m.sourceLang, m.targetLang] : any ? [] : m.languages,
          // A pair model is directional: the languages alone would claim the other way round too.
          ...(m.sourceLang && m.targetLang ? { pair: [m.sourceLang, m.targetLang] as const } : {}),
        };
      });
    // This computer's native engines' models first: the ones measured best, where it has them.
    const native = nativeShared();
    return [...native.filter((m) => m.kind === 'asr'), ...recognizers, ...native.filter((m) => m.kind !== 'asr'), ...translators];
  },
  recognizer(language, named_) {
    // A name this computer shares nothing under — a model it had once, which a device still has chosen — is no name:
    // the choice is this computer's, as when none is given, and not a refusal or a lesser model.
    const wanted = knownHere(named_);
    // A native recognizer when it is the one named — or nothing is named and one hears the language.
    const native = nativeRecognizerFor(language, wanted);
    if (native) return native;
    const named = getManifestEntry(wanted);
    if (isRecognizer(named) && usable(named) && (named.multilingual || named.languages.includes(language))) {
      return { modelId: named.id, streaming: named.type === 'asr-stream' };
    }
    // The best one downloaded for the language, as the app would pick for itself; the other side of the pair does not matter to a recognizer.
    const picked = useModelStore.getState().resolve(language, language, {}).asr;
    return picked ? { modelId: picked.modelId, streaming: getManifestEntry(picked.modelId)?.type === 'asr-stream' } : null;
  },
  translator(source, target, named_) {
    const wanted = knownHere(named_);
    // A native model this computer shares is answered by that engine and by nothing else: when it cannot take the
    // pair, no app's own model stands in for it (`refusal` says why).
    if (wanted && isNativeTranslator(wanted)) return nativeTranslatorFor(source, target, wanted);
    if (wanted) {
      const named = getManifestEntry(wanted);
      if (named?.type === 'translation' && usable(named)) {
        return isTranslationModelCompatible(named, source, target) ? named.id : null;
      }
    }
    // Left to this computer: its native engine's models first (they are the ones measured best), then its own.
    if (!wanted) {
      const native = nativeTranslatorFor(source, target, '');
      if (native) return native;
    }
    // What the app would pick for itself — its own choice for the direction where one was made, else the best it
    // has — unless that is the online service it falls back to with nothing downloaded.
    const picked = useModelStore.getState().resolve(source, target, hostSelections()).translation;
    const entry = picked ? getManifestEntry(picked.modelId) : undefined;
    return entry?.type === 'translation' && usable(entry) ? entry.id : null;
  },
  /**
   * Why a model this computer shares cannot answer for a pair: it does not translate the pair, or the native
   * engine is someone's with another model that does not (`translator` answered null). Null: another model may.
   */
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
    const entry = getManifestEntry(wanted);
    return entry?.type === 'translation' && !isTranslationModelCompatible(entry, source, target) ? 'unfit' : null;
  },
  coach: (wanted) => nativeCoachFor(wanted),
};

/** The model store, scanned: what is downloaded is known only after its first scan. */
export async function lanModelsLoaded(): Promise<void> {
  const store = useModelStore.getState();
  if (!store.initialized) await store.initialize();
}
