import { BookOpen, CircleHelp, Search, X } from 'lucide-react';
import { useEffect, useRef, useState, type InputHTMLAttributes, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import Tooltip from '../../Tooltip/Tooltip';
import { MAX_GLOSSARY_ENTRIES, parseAliases } from '../../../lib/glossary/glossary';
import { useGlossaryStore } from '../../../stores/glossaryStore';
import './GlossarySection.scss';

/** Past this the list scrolls, and a term is quicker found than looked for. */
const SEARCH_FROM = 9;

const blurOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
  if (event.key === 'Enter') event.currentTarget.blur();
};

/** What is typed stays here until the field is left: a half-typed term is not an entry. */
function Cell({ value, commit, ...input }: Omit<InputHTMLAttributes<HTMLInputElement>, 'value'> & { value: string; commit(text: string): void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <td>
      <input
        {...input}
        value={draft ?? value}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={blurOnEnter}
        onBlur={() => {
          if (draft === null) return;
          if (draft !== value) commit(draft);
          setDraft(null);
        }}
      />
    </td>
  );
}

/** The row under the last: an entry is made as the row is left with something in its written cell, or on Enter. */
function NewRow({ onAdd }: { onAdd(): void }) {
  const { t } = useTranslation();
  const add = useGlossaryStore((state) => state.add);
  const [source, setSource] = useState('');
  const [aliases, setAliases] = useState('');
  const written = useRef<HTMLInputElement>(null);
  const save = () => {
    if (!source.trim()) return false;
    add({ source, aliases: parseAliases(aliases) });
    onAdd();
    setSource('');
    setAliases('');
    return true;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && save()) written.current?.focus();
  };
  return (
    <tr
      className="glossary-new"
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) save(); }}
    >
      <td><input aria-label={t('settings.glossaryHeard')} placeholder={t('settings.glossaryOptional')} value={aliases} onChange={(event) => setAliases(event.target.value)} onKeyDown={onKeyDown} /></td>
      <td><input ref={written} aria-label={t('settings.glossaryWritten')} placeholder={t('settings.glossaryAdd')} value={source} onChange={(event) => setSource(event.target.value)} onKeyDown={onKeyDown} /></td>
      <td />
    </tr>
  );
}

/** A small table of terms, written in place. A change takes effect at the next start, so it stays open during a session. */
export function GlossarySection() {
  const { t } = useTranslation();
  const entries = useGlossaryStore((state) => state.entries);
  const update = useGlossaryStore((state) => state.update);
  const remove = useGlossaryStore((state) => state.remove);
  const [query, setQuery] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const added = useRef(false);
  const needle = entries.length >= SEARCH_FROM ? query.trim().toLocaleLowerCase() : '';
  const shown = needle
    ? entries.filter((entry) => [entry.source, ...entry.aliases].some((term) => term.toLocaleLowerCase().includes(needle)))
    : entries;
  // What was just added shows: the new row stays put under a list that may be longer than the box.
  useEffect(() => {
    if (added.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
    added.current = false;
  }, [entries]);

  return (
    <div className="config-section glossary-section" id="glossary-section">
      <h3>
        <BookOpen size={18} />
        <span>{t('settings.glossaryTitle')}</span>
        <Tooltip content={t('settings.glossaryTooltip')} position="top">
          <button type="button" className="glossary-help" aria-label={t('settings.glossaryTooltipLabel')}>
            <CircleHelp size={15} />
          </button>
        </Tooltip>
        <span className="glossary-count">{entries.length} / {MAX_GLOSSARY_ENTRIES}</span>
      </h3>

      {entries.length >= SEARCH_FROM && (
        <label className="glossary-search">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            aria-label={t('settings.glossarySearch')}
            placeholder={t('settings.glossarySearch')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape' || !query) return;
              // Esc clears the search first; only an empty search lets it close the panel.
              event.stopPropagation();
              setQuery('');
            }}
          />
        </label>
      )}

      <div className="glossary-scroll" ref={scroller}>
        <table className="glossary-table">
          <thead>
            <tr>
              <th scope="col">{t('settings.glossaryHeard')}</th>
              <th scope="col">{t('settings.glossaryWritten')}</th>
              <th aria-hidden="true" />
            </tr>
          </thead>
          <tbody>
            {shown.map((entry) => (
              <tr key={entry.id}>
                <Cell
                  aria-label={t('settings.glossaryHeard')}
                  value={entry.aliases.join(', ')}
                  commit={(text) => update(entry.id, { aliases: parseAliases(text) })}
                />
                <Cell
                  aria-label={t('settings.glossaryWritten')}
                  value={entry.source}
                  commit={(text) => { if (text.trim()) update(entry.id, { source: text }); }}
                />
                <td>
                  <button type="button" className="glossary-delete" onClick={() => remove(entry.id)} aria-label={t('settings.glossaryDelete')}>
                    <X size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          {entries.length < MAX_GLOSSARY_ENTRIES && (
            <tfoot>
              <NewRow onAdd={() => { added.current = true; setQuery(''); }} />
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
