/**
 * Fork: what this computer can share right now, as the model store and the
 * catalog say — for the sharing host, and for the settings that show it.
 * Apart from `appHost.ts` so the settings read it without loading the
 * engines.
 */
import {
  asrEntryLanguages, deviceReady, getManifestByType, getManifestEntry, isTranslationModelCompatible, type ModelManifestEntry,
} from '../local-inference/modelManifest';
import { useModelStore } from '../../stores/modelStore';
import type { LanModels } from './host';
import { nativeRecognizerFor, nativeShared, nativeTranslatorFor } from './nativeShare';
import type { SharedModel } from './protocol';

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

/** What the model store answers, for the sharing host. */
export const appLanModels: LanModels = {
  shared(): SharedModel[] {
    const recognizers = [...getManifestByType('asr'), ...getManifestByType('asr-stream')].filter(usable)
      .map((m): SharedModel => ({ id: m.id, kind: 'asr', languages: m.multilingual ? [] : [...new Set(asrEntryLanguages(m))] }));
    const translators = getManifestByType('translation').filter(usable)
      .map((m): SharedModel => ({ id: m.id, kind: 'translate', languages: m.sourceLang && m.targetLang ? [m.sourceLang, m.targetLang] : m.languages }));
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
    const native = nativeTranslatorFor(source, target, wanted);
    if (native) return native;
    const named = getManifestEntry(wanted);
    if (named?.type === 'translation' && usable(named) && isTranslationModelCompatible(named, source, target)) return named.id;
    // What the app would pick for itself — unless that is the online service it falls back to with nothing downloaded.
    const picked = useModelStore.getState().resolve(source, target, {}).translation;
    const entry = picked ? getManifestEntry(picked.modelId) : undefined;
    return entry?.type === 'translation' && usable(entry) ? entry.id : null;
  },
};

/** The model store, scanned: what is downloaded is known only after its first scan. */
export async function lanModelsLoaded(): Promise<void> {
  const store = useModelStore.getState();
  if (!store.initialized) await store.initialize();
}
