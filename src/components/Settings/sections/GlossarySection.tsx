import { BookOpen, CircleHelp, ClipboardPaste, FileUp, Plus, Trash2 } from 'lucide-react';
import { useRef, useState, type InputHTMLAttributes } from 'react';
import { useTranslation } from 'react-i18next';
import Tooltip from '../../Tooltip/Tooltip';
import ToggleSwitch from '../shared/ToggleSwitch';
import { parseAliases } from '../../../lib/glossary/glossary';
import { useGlossaryStore } from '../../../stores/glossaryStore';
import './GlossarySection.scss';

/** What is typed stays here until the field is left: a half-typed term is not an entry. */
function TermField({ value, commit, ...input }: Omit<InputHTMLAttributes<HTMLInputElement>, 'value'> & { value: string; commit(text: string): void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      {...input}
      value={draft ?? value}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft === null) return;
        commit(draft);
        setDraft(null);
      }}
    />
  );
}

export interface GlossarySectionProps {
  disabled?: boolean;
}

/** Local terminology maintained once for recognition and translation. */
export function GlossarySection({ disabled = false }: GlossarySectionProps) {
  const { t } = useTranslation();
  const entries = useGlossaryStore((state) => state.entries);
  const add = useGlossaryStore((state) => state.add);
  const update = useGlossaryStore((state) => state.update);
  const remove = useGlossaryStore((state) => state.remove);
  const toggle = useGlossaryStore((state) => state.toggle);
  const importClipboard = useGlossaryStore((state) => state.importClipboard);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState('');
  const [target, setTarget] = useState('');
  const [aliases, setAliases] = useState('');
  const [message, setMessage] = useState('');

  const addEntry = () => {
    const value = source.trim();
    if (!value) return;
    add({ source: value, target: target.trim() || value, aliases: parseAliases(aliases) });
    setSource('');
    setTarget('');
    setAliases('');
    setMessage(t('settings.glossaryAdded'));
  };

  const importText = (raw: string) => {
    const { added, updated } = importClipboard(raw);
    const count = added + updated;
    setMessage(count > 0 ? t('settings.glossaryImported', { count }) : t('settings.glossaryNothingImported'));
  };

  const paste = async () => {
    try {
      importText(await navigator.clipboard.readText());
    } catch {
      setMessage(t('settings.glossaryClipboardDenied'));
    }
  };

  return (
    <div className="config-section glossary-section" id="glossary-section">
      <h3>
        <BookOpen size={18} />
        <span>{t('settings.glossaryTitle')}</span>
        <Tooltip
          content={[t('settings.glossaryDescription'), t('settings.glossaryTooltip'), t('settings.glossaryImportHint')].join(' ')}
          position="top"
        >
          <button type="button" className="glossary-help" aria-label={t('settings.glossaryTooltipLabel')}>
            <CircleHelp size={15} />
          </button>
        </Tooltip>
      </h3>

      {entries.length > 0 && (
        <div className="glossary-list" aria-label={t('settings.glossaryEntries')}>
          {entries.map((entry) => (
            <div className={`glossary-row ${entry.enabled ? '' : 'is-disabled'}`} key={entry.id}>
              <div className="glossary-row-fields">
                <TermField
                  aria-label={t('settings.glossarySource')}
                  value={entry.source}
                  commit={(text) => { if (text.trim()) update(entry.id, { source: text }); }}
                  disabled={disabled}
                />
                <span className="glossary-arrow" aria-hidden="true">→</span>
                <TermField
                  aria-label={t('settings.glossaryTarget')}
                  value={entry.target}
                  commit={(text) => update(entry.id, { target: text })}
                  disabled={disabled}
                />
              </div>
              <TermField
                className="glossary-aliases"
                aria-label={t('settings.glossaryAliases')}
                placeholder={t('settings.glossaryAliasesPlaceholder')}
                value={entry.aliases.join(', ')}
                commit={(text) => update(entry.id, { aliases: parseAliases(text) })}
                disabled={disabled}
              />
              <div className="glossary-row-actions">
                <ToggleSwitch
                  checked={entry.enabled}
                  onChange={() => toggle(entry.id)}
                  label={entry.enabled ? t('settings.glossaryEnabled') : t('settings.glossaryDisabled')}
                  disabled={disabled}
                />
                <button type="button" className="glossary-delete" onClick={() => remove(entry.id)} disabled={disabled} aria-label={t('settings.glossaryDelete')}>
                  <Trash2 size={15} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="glossary-add-row">
        <input aria-label={t('settings.glossaryNewSource')} placeholder={t('settings.glossarySourcePlaceholder')} value={source} onChange={(event) => setSource(event.target.value)} disabled={disabled} />
        <span className="glossary-arrow" aria-hidden="true">→</span>
        <input aria-label={t('settings.glossaryNewTarget')} placeholder={t('settings.glossaryTargetPlaceholder')} value={target} onChange={(event) => setTarget(event.target.value)} disabled={disabled} />
        <input aria-label={t('settings.glossaryNewAliases')} placeholder={t('settings.glossaryAliasesPlaceholder')} value={aliases} onChange={(event) => setAliases(event.target.value)} disabled={disabled} />
        <button type="button" className="glossary-add" onClick={addEntry} disabled={disabled || !source.trim()} aria-label={t('settings.glossaryAdd')}>
          <Plus size={16} />
          <span>{t('settings.glossaryAdd')}</span>
        </button>
      </div>

      <div className="glossary-footer">
        <button type="button" className="glossary-import" onClick={() => void paste()} disabled={disabled}>
          <ClipboardPaste size={15} />
          <span>{t('settings.glossaryPaste')}</span>
        </button>
        <button type="button" className="glossary-import" onClick={() => fileInputRef.current?.click()} disabled={disabled}>
          <FileUp size={15} />
          <span>{t('settings.glossaryImportFile')}</span>
        </button>
        <input
          ref={fileInputRef}
          className="glossary-file-input"
          type="file"
          accept=".csv,text/csv,text/plain"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void file.text().then(importText, () => setMessage(t('settings.glossaryNothingImported')));
          }}
          disabled={disabled}
        />
      </div>
      {message && <p className="glossary-message" role="status">{message}</p>}
    </div>
  );
}
