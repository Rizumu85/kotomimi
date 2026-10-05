/**
 * Fork: the native engine's model, in the hearing stage's card — the
 * library's own card (`ModelCard`), so that it downloads, shows its progress
 * and is deleted the way every other model is. Under it, while it is the
 * one in use, what the engine is doing: coming up, ready, or why it is not.
 */
import { useMemo } from 'react';
import { CircleCheck, Loader, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ModelCard } from '../../components/Settings/sections/ModelManagementSection';
import type { ModelManifestEntry } from '../../lib/local-inference/modelManifest';
import { useNativeEngineStore } from '../../stores/nativeEngineStore';
import { nativeReady, type NativeModel } from './localaiNative';

/** The id its card goes by in the library: no catalog model's. */
export const nativeCardId = (model: NativeModel): string => `native:${model.id}`;

/** The model as the library's card reads one: its name, what it hears, and its size. */
function entryOf(model: NativeModel): ModelManifestEntry {
  return {
    id: nativeCardId(model),
    type: 'asr',
    name: model.name,
    languages: [...model.languages],
    recommended: true,
    variants: { default: { dtype: 'q8', files: [{ filename: `${model.id}.gguf`, sizeBytes: model.bytes }] } },
  };
}

export function NativeEngineCard({ model, selected, onSelect, disabled }: { model: NativeModel; selected: boolean; onSelect(): void; disabled?: boolean }) {
  const { t } = useTranslation();
  const status = useNativeEngineStore((s) => s.status);
  const asked = useNativeEngineStore((s) => s.asked);
  const entry = useMemo(() => entryOf(model), [model]);
  const mine = status.models[model.id];
  const fetching = status.engine === 'downloading' || mine?.state === 'downloading' || mine?.state === 'verifying';
  const downloaded = status.engine === 'ready' && mine?.state === 'downloaded';
  const shown = fetching ? 'downloading' : downloaded ? 'downloaded' : mine?.state === 'failed' ? 'error' : 'not_downloaded';
  const total = mine?.total || model.bytes;
  const received = mine?.received ?? 0;
  const store = useNativeEngineStore.getState;
  const { run } = status;
  const ours = run.model === model.id;
  return (
    <ModelCard
      entry={entry}
      status={shown}
      download={fetching ? { downloadedBytes: received, totalBytes: total, currentFile: '', percent: Math.min(100, Math.floor((received / total) * 100)) } : undefined}
      errorMessage={mine?.error}
      isSessionActive={Boolean(disabled)}
      isSelected={selected}
      // Before the main process has answered, "no engine for this system" is its blank.
      isCompatible={status.supported || !asked}
      compatibilityHint={status.supported || !asked ? undefined : t('providers.localai.nativeUnsupportedShort')}
      note={t('providers.localai.noteNativeR2t2')}
      onSelect={onSelect}
      onDownload={() => { void store().download(model.id); }}
      onCancel={() => { void store().cancel(model.id); }}
      onDelete={() => { void store().remove(model.id); }}
    >
      {nativeReady(status, model.id) ? (
        <p className="kt-engine kt-engine--ready" role="status"><CircleCheck size={13} /><span>{t('providers.localai.nativeReady')}</span></p>
      ) : ours && run.state === 'failed' ? (
        <div className="kt-engine kt-engine--failed" role="status">
          <span>{t('providers.localai.nativeFailedShort')}</span>
          <button type="button" className="kt-there__switch" onClick={() => { void store().start(model.id); }} disabled={disabled}>
            <RefreshCw size={12} />
            <span>{t('providers.localai.nativeRetry')}</span>
          </button>
        </div>
      ) : downloaded ? (
        <p className="kt-engine" role="status"><Loader size={13} className="kt-engine__spin" /><span>{t('providers.localai.nativeWarmingShort')}</span></p>
      ) : null}
    </ModelCard>
  );
}
