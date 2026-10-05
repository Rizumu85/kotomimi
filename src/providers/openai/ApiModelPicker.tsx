/**
 * Fork: the model field of an API, with a menu of the models the service
 * itself lists.
 *
 * What is typed in the field is what is asked for, as before; the button
 * beside it asks the service for its list (`apiModelList.ts`) and opens it
 * under the field, the model that suits the stage first. A long list has a
 * search of its own above it (`searchModels`: any words, in any order, a
 * letter or a hyphen missing forgiven). While the list is on its way, or
 * where it could not be had, the models the last check listed are offered,
 * with a line that says why.
 *
 * The search is typed in Latin letters, and often through an input method
 * for Chinese or Japanese that nobody switches off for six letters. It is
 * left to work as it does everywhere: what is being composed narrows the
 * list as it is typed (its marks between syllables are not letters), a key
 * the input method takes — Enter, which commits the letters — chooses
 * nothing, and what it commits is never rewritten.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronDown, Loader, Search, Star } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { listApiModels, menuOf, type ApiModelList } from './apiModelList';
import type { ApiKind, ApiService } from './apiServices';

/** A list longer than this is searched rather than read. */
export const SEARCH_FROM = 8;

export interface ApiModelPickerProps {
  /** Distinguishes the menus' ids. */
  id: string;
  label: string;
  model: string;
  placeholder: string;
  baseUrl: string;
  needsKey: boolean;
  apiKey: string;
  /** The models the last check listed for this address: offered until the service answers. */
  known: readonly string[];
  service: ApiService | undefined;
  kind: ApiKind;
  onModel(model: string): void;
  /** The field is being typed in, or not: nothing fills it in under the user's hands. */
  onTyping(typing: boolean): void;
  disabled?: boolean;
}

export function ApiModelPicker({ id, label, model, placeholder, baseUrl, needsKey, apiKey, known, service, kind, onModel, onTyping, disabled }: ApiModelPickerProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<ApiModelList | 'asking' | null>(null);
  const [query, setQuery] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const asked = useRef<AbortController | null>(null);

  const close = () => {
    asked.current?.abort();
    asked.current = null;
    setOpen(false);
    setQuery('');
  };

  const ask = () => {
    asked.current?.abort();
    setOpen(true);
    setQuery('');
    if (!baseUrl.trim() || (needsKey && !apiKey.trim())) {
      setList(null);
      return;
    }
    const mine = new AbortController();
    asked.current = mine;
    setList('asking');
    void listApiModels(baseUrl, needsKey ? apiKey : undefined, { signal: mine.signal }).then((answer) => {
      if (asked.current !== mine) return;
      asked.current = null;
      setList(answer);
    });
  };

  // Closed by a click anywhere else, and with the field itself.
  useEffect(() => {
    if (!open) return undefined;
    const away = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) close();
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  useEffect(() => () => asked.current?.abort(), []);
  // Another service, another list.
  useEffect(() => close(), [baseUrl]);

  const listed = list !== null && list !== 'asking' && list.ok ? list.ids : known;
  const searched = listed.length > SEARCH_FROM;
  const menu = menuOf(listed, searched ? query : null, service, kind);
  // A long list is opened to be searched: the search has the caret as soon as it is there.
  useEffect(() => {
    if (open && searched) search.current?.focus();
  }, [open, searched]);

  const why = !baseUrl.trim() ? 'modelListNoAddress'
    : needsKey && !apiKey.trim() ? 'modelListKeyMissing'
      : list === 'asking' ? (listed.length === 0 ? 'modelListAsking' : null)
        : list !== null && !list.ok ? ({ key: 'modelListKeyRefused', unreachable: 'modelListUnreachable', none: 'modelListNone' } as const)[list.why]
          : menu.ids.length === 0 ? 'modelListNoMatch' : null;

  const choose = (entry: string) => {
    onModel(entry);
    close();
  };
  const searchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    // A key the input method takes for itself is not the search's.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    } else if (event.key === 'Enter' && menu.ids.length > 0) {
      event.preventDefault();
      choose(menu.ids[0]);
    }
  };

  return (
    <div className="kt-field kt-pick" ref={root}>
      <span className="kt-field__label">{label}</span>
      <div className="kt-pick__row">
        <input
          type="text"
          className="kt-input"
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          aria-controls={`${id}-model-menu`}
          aria-autocomplete="list"
          value={model}
          onChange={(e) => onModel(e.target.value)}
          onFocus={() => onTyping(true)}
          onBlur={() => onTyping(false)}
          onKeyDown={(e) => { if (e.key === 'Escape' && open) { e.stopPropagation(); close(); } }}
          placeholder={placeholder}
          spellCheck={false}
          disabled={disabled}
        />
        <button
          type="button"
          className="kt-pick__open"
          aria-label={t('providers.localai.modelList')}
          title={t('providers.localai.modelList')}
          aria-expanded={open}
          aria-controls={`${id}-model-menu`}
          onClick={() => (open ? close() : ask())}
          disabled={disabled}
        >
          {list === 'asking' && open ? <Loader size={14} className="kt-ready__spin" /> : <ChevronDown size={14} />}
        </button>
      </div>
      {open && (
        <div className="kt-pick__menu" id={`${id}-model-menu`}>
          {searched && (
            <div className="kt-pick__search">
              <Search size={13} aria-hidden="true" />
              <input
                ref={search}
                type="text"
                aria-label={t('providers.localai.modelSearch')}
                placeholder={t('providers.localai.modelSearch')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={searchKey}
                spellCheck={false}
                autoComplete="off"
              />
            </div>
          )}
          {menu.ids.length > 0 && (
            <div className="kt-pick__list" role="listbox" aria-label={t('providers.localai.modelList')}>
              {menu.ids.map((entry) => (
                <button key={entry} type="button" role="option" aria-selected={entry === model} className={`kt-pick__option${entry === model ? ' is-chosen' : ''}`} onClick={() => choose(entry)}>
                  <span className="kt-pick__name">{entry}</span>
                  {entry === menu.suggested && <span className="kt-pick__mark" title={t('providers.localai.modelSuggested')}><Star size={11} aria-label={t('providers.localai.modelSuggested')} /></span>}
                </button>
              ))}
            </div>
          )}
          {why && <p className="kt-note kt-pick__why" role="status">{t(`providers.localai.${why}`)}</p>}
        </div>
      )}
    </div>
  );
}
