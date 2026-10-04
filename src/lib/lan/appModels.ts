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
import type { SharedModel } from './protocol';

const isRecognizer = (entry: ModelManifestEntry | undefined): entry is ModelManifestEntry => entry?.type === 'asr' || entry?.type === 'asr-stream';

/**
 * A model this computer can run itself for another device: downloaded and its
 * device present. A cloud model (Bing translation, Edge TTS) is never shared —
 * sharing is this computer lending the models it holds, and a remote device's
 * speech must not leave this network through an online service it never chose
 * (FORK.md: "共享的是应用自己下载的模型"). The local user's own device stage
 * may still fall back to a cloud model; only what is offered on the network
 * is held to what is downloaded here.
 */
function usable(entry: ModelManifestEntry | undefined): entry is ModelManifestEntry {
  if (!entry || entry.isCloudModel) return false;
  const { modelStatuses, webgpuAvailable } = useModelStore.getState();
  return modelStatuses[entry.id] === 'downloaded' && deviceReady(entry, webgpuAvailable);
}

/** A model the store's own resolution picked: taken only when it is one this computer actually holds, never a cloud fallback. */
const localPick = (modelId: string | undefined): ModelManifestEntry | undefined => {
  const entry = modelId ? getManifestEntry(modelId) : undefined;
  return entry && usable(entry) ? entry : undefined;
};

/** What the model store answers, for the sharing host. */
export const appLanModels: LanModels = {
  shared(): SharedModel[] {
    const recognizers = [...getManifestByType('asr'), ...getManifestByType('asr-stream')].filter(usable)
      .map((m): SharedModel => ({ id: m.id, kind: 'asr', languages: m.multilingual ? [] : [...new Set(asrEntryLanguages(m))] }));
    const translators = getManifestByType('translation').filter(usable)
      .map((m): SharedModel => ({ id: m.id, kind: 'translate', languages: m.sourceLang && m.targetLang ? [m.sourceLang, m.targetLang] : m.languages }));
    return [...recognizers, ...translators];
  },
  recognizer(language, wanted) {
    const named = getManifestEntry(wanted);
    if (isRecognizer(named) && usable(named) && (named.multilingual || named.languages.includes(language))) {
      return { modelId: named.id, streaming: named.type === 'asr-stream' };
    }
    // The best one downloaded for the language, as the app would pick for itself; a cloud fallback is not shared (see `usable`).
    const entry = localPick(useModelStore.getState().resolve(language, language, {}).asr?.modelId);
    return isRecognizer(entry) ? { modelId: entry.id, streaming: entry.type === 'asr-stream' } : null;
  },
  translator(source, target, wanted) {
    const named = getManifestEntry(wanted);
    if (named?.type === 'translation' && usable(named) && isTranslationModelCompatible(named, source, target)) return named.id;
    // The best translation model downloaded here for the pair. The store's own pick is not used: it favours the
    // recommended cloud model (Bing), which sharing never offers, and would hide a local model ranked under it.
    const best = getManifestByType('translation')
      .filter((m) => usable(m) && isTranslationModelCompatible(m, source, target))
      .sort((a, b) => Number(Boolean(b.recommended)) - Number(Boolean(a.recommended)) || (a.sortOrder ?? 0) - (b.sortOrder ?? 0))[0];
    return best?.id ?? null;
  },
};

/** The model store, scanned: what is downloaded is known only after its first scan. */
export async function lanModelsLoaded(): Promise<void> {
  const store = useModelStore.getState();
  if (!store.initialized) await store.initialize();
}
