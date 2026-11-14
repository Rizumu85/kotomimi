/**
 * Fork: a native engine's model, in its stage's card — the library's own
 * card (`ModelCard`), so that it downloads, shows its progress and is
 * deleted the way every other model is. Under it, while it is the one in
 * use, what the engine is doing: coming up, ready, or why it is not. One
 * card for both engines: the one that hears and the one that translates.
 */
import { restNative } from './localaiNative';
import { useEffect, useMemo } from 'react';
import { CircleCheck, Loader, RefreshCw, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ModelCard } from '../../components/Settings/sections/ModelManagementSection';
import type { ModelManifestEntry } from '../../lib/local-inference/modelManifest';
import { useNativeCoachStore, useNativeEngineStore, useNativeTranslatorStore } from '../../stores/nativeEngineStore';
import { NATIVE_MODELS, nativeReady, nativeUpdating } from './localaiNative';
import { ROOM_MARGIN, sizeText, useModelStorageStore } from '../../lib/native/modelStorage';
import { driveLabel } from '../../components/ModelStorage/ModelStorageSection';

export type NativeKind = 'asr' | 'translation' | 'coach';

/** A model as its card shows it, whichever engine runs it. */
export interface NativeCardModel {
  id: string;
  name: string;
  bytes: number;
  /** `'any'`: a model of well over a hundred languages. */
  languages: readonly string[] | 'any';
  /** No longer offered for download: another of the list does all it does. */
  retired?: boolean;
}

/** The words of each engine: its note beside the name is per model (`noteKey`), these are what it is doing. */
const WORDS: Record<NativeKind, { ready: string; warming: string; failed: string }> = {
  asr: { ready: 'providers.localai.nativeReady', warming: 'providers.localai.nativeWarmingShort', failed: 'providers.localai.nativeFailedShort' },
  translation: { ready: 'providers.localai.translatorReady', warming: 'providers.localai.translatorWarmingShort', failed: 'providers.localai.translatorFailedShort' },
  coach: { ready: 'providers.localai.nativeCoachReady', warming: 'providers.localai.nativeCoachWarmingShort', failed: 'providers.localai.nativeCoachFailedShort' },
};

/** What was found of each model, as the key of a sentence under `providers.localai`. */
const NOTES: Readonly<Record<string, string>> = {
  'r2t2-q8': 'noteNativeR2t2',
  'qwen3-asr-1.7b-q8': 'noteNativeQwen',
  'sensevoice-small-q8': 'noteNativeSenseVoice',
  'qwen3-asr-0.6b-q8': 'noteNativeQwenSmall',
  'nemotron-asr-0.6b-q8': 'noteNativeNemotron',
  'x-asr-zh-en': 'noteNativeXAsr',
  'apple-speech': 'noteAppleSpeech',
  'index-translate-2b': 'noteIndexTranslate',
  'hy-mt2-1.8b': 'noteHyMt2',
  'hy-mt2-streamrevise-v4': 'noteStreamRevise',
  'plamo-3-translate-2b': 'notePlamo3',
  'plamo-3-translate-0.8b': 'notePlamo3Small',
  'hy-mt1.5-1.8b': 'noteHyMt15',
  'gemma-4-e2b': 'noteGemma4',
};

/** The note of a model's card. A model of one family to a language (the Mac's recognition) shares its family's. */
export const nativeNoteKey = (id: string): string | undefined => NOTES[id] ?? NOTES[id.split(':')[0]];

/**
 * What every model of a kind shares, said once by a chip on its card rather than in each model's own note: one run
 * by an engine the app downloads has to warm up; the system's own recognition needs nothing of the graphics card, and
 * neither does a model the processor runs (`usesGpu: false`).
 */
const tagOf = (id: string): 'native' | 'system' | 'cpu' => (id.startsWith('apple-speech') ? 'system'
  : NATIVE_MODELS.some((model) => model.id === id && model.usesGpu === false) ? 'cpu' : 'native');

/** Enough languages for the card to say "multilingual", for a model that lists none. */
const MANY = ['zh', 'en', 'ja', 'ko', 'es', 'ru', 'fr', 'de', 'pt', 'it', 'ar', 'hi', 'th', 'vi', 'id', 'tr'];

/** The store of the engine that runs models of this kind. */
export const nativeStoreOf = (kind: NativeKind) => (kind === 'asr' ? useNativeEngineStore : kind === 'translation' ? useNativeTranslatorStore : useNativeCoachStore);

/** The id its card goes by in the library: no catalog model's. */
export const nativeCardId = (model: NativeCardModel): string => `native:${model.id}`;

/** The model as the library's card reads one: its name, its languages, and its size. */
function entryOf(kind: NativeKind, model: NativeCardModel, recommended: boolean): ModelManifestEntry {
  return {
    id: nativeCardId(model),
    // The library has no kind of its own for a feedback model: it is a text model, as a translator is.
    type: kind === 'asr' ? 'asr' : 'translation',
    name: model.name,
    languages: model.languages === 'any' ? MANY : [...model.languages],
    multilingual: model.languages === 'any' || model.languages.length > 3,
    recommended,
    variants: { default: { dtype: 'gguf', files: [{ filename: `${model.id}.gguf`, sizeBytes: model.bytes }] } },
  };
}

export function NativeEngineCard({ kind, model, recommended = true, recommendHint, fit, blocked = null, selected, onSelect, onDownloadStarted, disabled }: { kind: NativeKind; model: NativeCardModel; /** The one recommended for this computer (`nativeRecommendation.ts`): the others are there to be chosen, without the mark. */ recommended?: boolean; /** Why, on hover over the mark. */ recommendHint?: string; /** How well this computer runs it here (`nativeFit`); absent: nothing said. */ fit?: { label: string; hint: string; tone: 'ok' | 'warn' | 'bad' }; /** Why it cannot be chosen here now (`nativeRowChoice`); null: it can. */ blocked?: string | null; selected: boolean; onSelect?(): void; onDownloadStarted?(): void; disabled?: boolean }) {
  const { t } = useTranslation();
  const useStore = nativeStoreOf(kind);
  const status = useStore((s) => s.status);
  const asked = useStore((s) => s.asked);
  const entry = useMemo(() => entryOf(kind, model, recommended), [kind, model, recommended]);
  const mine = status.models[model.id];
  const fetching = mine?.state === 'downloading' || mine?.state === 'verifying';
  // Kept from an earlier version, its runtime being updated (`nativeUpdating`): downloaded, and not to be fetched again.
  const kept = nativeUpdating(status, model.id);
  const downloaded = (status.engine === 'ready' || kept) && mine?.state === 'downloaded';
  const shown = fetching ? 'downloading' : downloaded ? 'downloaded' : mine?.state === 'failed' ? 'error' : 'not_downloaded';
  const total = mine?.total || model.bytes;
  const received = mine?.received ?? 0;
  const store = useStore.getState;
  const { run } = status;
  const ours = run.model === model.id;
  const words = WORDS[kind];
  const note = nativeNoteKey(model.id);
  // Room on the drive the models are kept on (`modelStorage.ts`), for a model not downloaded yet: the runtime too,
  // where it is not either (its archive, then what it unpacks to).
  const storage = useModelStorageStore((s) => s.status);
  useEffect(() => { void useModelStorageStore.getState().refresh(); }, []);
  const needs = model.bytes - (mine?.received ?? 0) + (status.engine === 'ready' ? 0 : status.engineBytes * 2);
  const room = storage?.drive.freeBytes ?? null;
  const noRoom = model.bytes > 0 && !fetching && !downloaded && room !== null && needs + ROOM_MARGIN > room;
  return (
    // No size is shown for a model the system fetches itself: it does not say how large it is.
    <div className={`kt-native-card${model.bytes > 0 ? '' : ' kt-native-card--unsized'}`}>
    <ModelCard
      entry={entry}
      status={shown}
      download={fetching ? { downloadedBytes: received, totalBytes: total, currentFile: '', percent: Math.min(100, Math.floor((received / total) * 100)) } : undefined}
      errorMessage={mine?.error}
      isSessionActive={Boolean(disabled) || mine?.waiting === true}
      isSelected={selected}
      // Before the main process has answered, "no engine for this system" is its blank.
      isCompatible={(status.supported || !asked) && blocked === null}
      compatibilityHint={blocked ?? (status.supported || !asked ? undefined : t('providers.localai.nativeUnsupportedShort'))}
      note={note ? t(`providers.localai.${note}`) : undefined}
      tag={{ label: t(`providers.localai.tag_${tagOf(model.id)}`), hint: t(`providers.localai.tagHint_${tagOf(model.id)}`) }}
      {...(recommended && recommendHint ? { recommendHint } : {})}
      {...(fit ? { fit } : {})}
      onSelect={onSelect}
      onDownload={() => { onDownloadStarted?.(); void store().download(model.id); }}
      onCancel={() => { void store().cancel(model.id); }}
      onDelete={() => { void store().remove(model.id); }}
      downloadBlocked={noRoom}
      footer={noRoom ? (
        <div className="kt-room">
          <span className="kt-room__why"><TriangleAlert size={14} />{t('fork.storage.noRoom', { drive: driveLabel(t, storage?.drive), size: sizeText(room ?? 0) })}</span>
          <button type="button" className="kt-room__btn" onClick={(e) => { e.stopPropagation(); void useModelStorageStore.getState().choose(); }} disabled={disabled}>{t('fork.storage.changePlace')}</button>
        </div>
      ) : undefined}
    >
      {kept && status.engine === 'absent' ? (
        // The update did not come by itself (offline when the app started, or it failed): asked for here.
        <div className="kt-engine" role="status">
          <span>{t('providers.localai.engineUpdate')}</span>
          <button type="button" className="kt-there__switch" onClick={(e) => { e.stopPropagation(); void store().download(model.id); }} disabled={disabled}>
            <RefreshCw size={12} />
            <span>{t('providers.localai.engineUpdateNow')}</span>
          </button>
        </div>
      ) : kept || (mine?.runtime && mine.kept) ? (
        <p className="kt-engine" role="status"><Loader size={13} className="kt-engine__spin" /><span>{t('providers.localai.engineUpdating')}</span></p>
      ) : mine?.runtime ? (
        <p className="kt-engine" role="status"><Loader size={13} className="kt-engine__spin" /><span>{t('providers.localai.nativeRuntime')}</span></p>
      ) : nativeReady(status, model.id) ? (
        <p className="kt-engine kt-engine--ready" role="status"><CircleCheck size={13} /><span>{t(words.ready)}</span></p>
      ) : ours && run.state === 'failed' ? (
        <div className="kt-engine kt-engine--failed" role="status">
          <span>{t(words.failed)}</span>
          <button type="button" className="kt-there__switch" onClick={() => { void store().start(model.id).finally(() => restNative()); }} disabled={disabled}>
            <RefreshCw size={12} />
            <span>{t('providers.localai.nativeRetry')}</span>
          </button>
        </div>
      ) : ours && (run.state === 'starting' || run.state === 'warming') ? (
        // Only while it is being started: a model that is downloaded and not in use says nothing, and is not "starting".
        <p className="kt-engine" role="status"><Loader size={13} className="kt-engine__spin" /><span>{t(words.warming)}</span></p>
      ) : null}
    </ModelCard>
    </div>
  );
}
