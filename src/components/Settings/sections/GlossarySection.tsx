import { BookOpen, CircleHelp, ClipboardPaste, FileUp, Plus, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Tooltip from '../../Tooltip/Tooltip';
import ToggleSwitch from '../shared/ToggleSwitch';
import { useGlossaryStore } from '../../../stores/glossaryStore';
import './GlossarySection.scss';

function copy(t: (key: string, defaultValue: string) => string, key: string, english: string): string {
  return t(key, english);
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
  const text = (key: string, english: string) => copy(t, key, english);

  const addEntry = () => {
    const value = source.trim();
    if (!value) return;
    add({
      source: value,
      target: target.trim() || value,
      aliases: aliases.split(/[,，]/).map((item) => item.trim()).filter(Boolean),
    });
    setSource('');
    setTarget('');
    setAliases('');
    setMessage(text('settings.glossaryAdded', 'Added'));
  };

  const paste = async () => {
    try {
      const value = await navigator.clipboard.readText();
      const result = importClipboard(value);
      const count = result.added + result.updated;
      setMessage(count > 0
        ? t('settings.glossaryImported', { count, defaultValue: `Imported ${count} changed row(s)` })
        : text('settings.glossaryNothingImported', 'No glossary rows found'));
    } catch {
      setMessage(text('settings.glossaryClipboardDenied', 'Clipboard access was unavailable'));
    }
  };

  const importFile = async (file: File) => {
    try {
      const result = importClipboard(await file.text());
      const count = result.added + result.updated;
      setMessage(count > 0
        ? t('settings.glossaryImported', { count, defaultValue: `Imported ${count} changed row(s)` })
        : text('settings.glossaryNothingImported', 'No new glossary rows found'));
    } catch {
      setMessage(text('settings.glossaryNothingImported', 'No glossary rows found'));
    }
  };

  return (
    <div className="config-section glossary-section" id="glossary-section">
      <h3>
        <BookOpen size={18} />
        <span>{text('settings.glossaryTitle', 'Personal glossary')}</span>
        <Tooltip
          content={text('settings.glossaryTooltip', 'Aliases help recognition settle on the canonical name. Source → target pairs guide translation. Changes apply when the next session starts.')}
          position="top"
        >
          <button type="button" className="glossary-help" aria-label={text('settings.glossaryTooltipLabel', 'About personal glossary')}>
            <CircleHelp size={15} />
          </button>
        </Tooltip>
      </h3>
      <p className="setting-description">
        {text('settings.glossaryDescription', 'Keep names, jargon, and VRChat friends consistent in both the transcript and translation.')}
      </p>

      {entries.length > 0 && (
        <div className="glossary-list" aria-label={text('settings.glossaryEntries', 'Glossary entries')}>
          {entries.map((entry) => (
            <div className={`glossary-row ${entry.enabled ? '' : 'is-disabled'}`} key={entry.id}>
              <div className="glossary-row-fields">
                <input
                  aria-label={text('settings.glossarySource', 'Source term')}
                  value={entry.source}
                  onChange={(event) => update(entry.id, { source: event.target.value })}
                  disabled={disabled}
                />
                <span className="glossary-arrow" aria-hidden="true">→</span>
                <input
                  aria-label={text('settings.glossaryTarget', 'Target rendering')}
                  value={entry.target}
                  onChange={(event) => update(entry.id, { target: event.target.value })}
                  disabled={disabled}
                />
              </div>
              <input
                className="glossary-aliases"
                aria-label={text('settings.glossaryAliases', 'Recognition aliases')}
                placeholder={text('settings.glossaryAliasesPlaceholder', 'Aliases, separated by commas')}
                value={entry.aliases.join(', ')}
                onChange={(event) => update(entry.id, { aliases: event.target.value.split(/[,，]/).map((item) => item.trim()).filter(Boolean) })}
                disabled={disabled}
              />
              <div className="glossary-row-actions">
                <ToggleSwitch
                  checked={entry.enabled}
                  onChange={() => toggle(entry.id)}
                  label={entry.enabled ? text('settings.glossaryEnabled', 'Use') : text('settings.glossaryDisabled', 'Off')}
                  disabled={disabled}
                />
                <button type="button" className="glossary-delete" onClick={() => remove(entry.id)} disabled={disabled} aria-label={text('settings.glossaryDelete', 'Delete entry')}>
                  <Trash2 size={15} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="glossary-add-row">
        <input aria-label={text('settings.glossaryNewSource', 'New source term')} placeholder={text('settings.glossarySourcePlaceholder', 'Source term')} value={source} onChange={(event) => setSource(event.target.value)} disabled={disabled} />
        <span className="glossary-arrow" aria-hidden="true">→</span>
        <input aria-label={text('settings.glossaryNewTarget', 'New target rendering')} placeholder={text('settings.glossaryTargetPlaceholder', 'Target (optional)')} value={target} onChange={(event) => setTarget(event.target.value)} disabled={disabled} />
        <input aria-label={text('settings.glossaryNewAliases', 'New recognition aliases')} placeholder={text('settings.glossaryAliasesPlaceholder', 'Aliases, separated by commas')} value={aliases} onChange={(event) => setAliases(event.target.value)} disabled={disabled} />
        <button type="button" className="glossary-add" onClick={addEntry} disabled={disabled || !source.trim()} aria-label={text('settings.glossaryAdd', 'Add glossary entry')}>
          <Plus size={16} />
          <span>{text('settings.glossaryAdd', 'Add')}</span>
        </button>
      </div>

      <div className="glossary-footer">
        <button type="button" className="glossary-import" onClick={() => void paste()} disabled={disabled}>
          <ClipboardPaste size={15} />
          <span>{text('settings.glossaryPaste', 'Paste from clipboard')}</span>
        </button>
        <button type="button" className="glossary-import" onClick={() => fileInputRef.current?.click()} disabled={disabled}>
          <FileUp size={15} />
          <span>{text('settings.glossaryImportFile', 'Import CSV file')}</span>
        </button>
        <input
          ref={fileInputRef}
          className="glossary-file-input"
          type="file"
          accept=".csv,text/csv,text/plain"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void importFile(file);
          }}
          disabled={disabled}
        />
        <span className="glossary-import-hint">{text('settings.glossaryImportHint', 'VRCX CSV (UserID, DisplayName, Memo) is supported; re-import updates existing friends.')}</span>
      </div>
      {message && <p className="glossary-message" role="status">{message}</p>}
    </div>
  );
}

