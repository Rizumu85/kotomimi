/**
 * Fork: adding a speech recognition model the catalog does not list — a
 * Whisper repository on Hugging Face, named by its id. Folded away until
 * wanted: most never need it, and those who do come with a repository in
 * mind (a fine-tune for their language). Once added, the model is in the
 * model library like any other, to download and to pick; here it can be
 * removed again.
 */
import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { languageNameFor } from '../Settings/engine/languageName';
import {
  CustomModelError, isCustomModel, saveCustomModels, storedCustomModels, whisperFromHub,
} from '../../lib/local-inference/customModels';
import { getManifestEntry, MODEL_MANIFEST, type ModelManifestEntry } from '../../lib/local-inference/modelManifest';
import { useModelStatuses, useModelStore } from '../../stores/modelStore';
import './CustomModels.scss';

/** The languages a fine-tune is most often for; blank is a model that hears them all. */
const LANGUAGES = ['', 'ja', 'zh', 'ko', 'en', 'ru', 'fr', 'de', 'es'];

const megabytes = (entry: ModelManifestEntry) => Math.round(Object.values(entry.variants)[0].files.reduce((sum, f) => sum + f.sizeBytes, 0) / 1_048_576);

/** Puts a model into the running catalog and the store, and keeps it for the next launch. */
function register(entry: ModelManifestEntry): void {
  MODEL_MANIFEST.push(entry);
  saveCustomModels([...storedCustomModels(), entry]);
  useModelStore.setState((s) => ({ modelStatuses: { ...s.modelStatuses, [entry.id]: 'not_downloaded' } }));
}

/** Takes a model out again: its downloaded files, its place in the catalog, and its record. */
async function unregister(id: string): Promise<void> {
  if (useModelStore.getState().modelStatuses[id] === 'downloaded') await useModelStore.getState().deleteModel(id);
  const at = MODEL_MANIFEST.findIndex((m) => m.id === id);
  if (at >= 0) MODEL_MANIFEST.splice(at, 1);
  saveCustomModels(storedCustomModels().filter((m) => m.id !== id));
  useModelStore.setState((s) => {
    const { [id]: _gone, ...modelStatuses } = s.modelStatuses;
    return { modelStatuses };
  });
}

export function CustomModels({ disabled = false }: { disabled?: boolean }) {
  const { t } = useTranslation();
  const [repo, setRepo] = useState('');
  const [language, setLanguage] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  // The list follows the catalog: read again whenever a status changes, which adding and removing both do.
  const statuses = useModelStatuses();
  const mine = MODEL_MANIFEST.filter((m) => isCustomModel(m.id));

  const add = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const entry = await whisperFromHub(repo, language);
      if (getManifestEntry(entry.id)) throw new CustomModelError('exists', 'Already added.');
      register(entry);
      setRepo('');
      setMessage({ ok: true, text: t('fork.custom.added', { name: entry.name, size: megabytes(entry) }) });
    } catch (error) {
      const code = error instanceof CustomModelError ? error.code : 'unreachable';
      setMessage({ ok: false, text: t(`fork.custom.error_${code}`, { detail: error instanceof Error ? error.message : String(error) }) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="kt-details kt-custom">
      <summary>{t('fork.custom.title')}</summary>
      <p className="kt-note">{t('fork.custom.intro')}</p>
      <div className="kt-custom__form">
        <input
          type="text"
          className="text-input kt-custom__repo"
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && repo.trim() && !busy) void add(); }}
          placeholder="onnx-community/kotoba-whisper-v2.2-ONNX"
          aria-label={t('fork.custom.repo')}
          spellCheck={false}
          disabled={disabled || busy}
        />
        <select className="select-dropdown kt-custom__language" aria-label={t('fork.custom.language')} value={language} onChange={(e) => setLanguage(e.target.value)} disabled={disabled || busy}>
          {LANGUAGES.map((code) => <option key={code} value={code}>{code ? languageNameFor(code) : t('fork.custom.anyLanguage')}</option>)}
        </select>
        <button type="button" className="kt-custom__add" onClick={() => { void add(); }} disabled={disabled || busy || !repo.trim()}>
          <Plus size={14} />
          <span>{busy ? t('fork.custom.adding') : t('fork.custom.add')}</span>
        </button>
      </div>
      {message && <p className={`kt-custom__message${message.ok ? ' is-ok' : ' is-error'}`}>{message.text}</p>}
      {mine.length > 0 && (
        <ul className="kt-custom__list">
          {mine.map((entry) => (
            <li key={entry.id}>
              <span className="kt-custom__name">{entry.hfModelId}</span>
              <span className="kt-custom__meta">
                {megabytes(entry)} MB · {statuses[entry.id] === 'downloaded' ? t('fork.custom.downloaded') : t('fork.custom.notDownloaded')}
              </span>
              <button type="button" className="kt-custom__remove" aria-label={t('fork.custom.remove', { name: entry.hfModelId })} title={t('fork.custom.remove', { name: entry.hfModelId })} onClick={() => { void unregister(entry.id); }} disabled={disabled}>
                <Trash2 size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
