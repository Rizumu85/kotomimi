/**
 * Fork: the language menus' own list. The select stays what it was — the
 * control, with its label, its value and its look — but pressing it opens
 * this list in place of the system's: every language with a pin at its
 * right, the pinned ones first, and a box to type a few letters of a name
 * into. A person who meets speakers of three or four languages keeps those
 * at the top, one press away.
 *
 * Used as a hook: it hands back what the select needs to open the list, and
 * the list itself to render beside it.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { autoUpdate, flip, FloatingFocusManager, FloatingPortal, offset, shift, size, useDismiss, useFloating, useInteractions } from '@floating-ui/react';
import { Check, Pin, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { englishLanguageName } from '../../lib/language/label';
import type { LanguageOption } from '../../lib/provider/types';
import { useLanguagePinStore } from '../../stores/languagePinStore';
import '../Fonts/Fonts.scss';
import './LanguageMenu.scss';

export interface LanguageMenuOptions {
  /** The provider's languages in the app's order, and the ones it would show first by itself (the current pair, the UI's language). */
  ordered: readonly LanguageOption[];
  suggested: readonly LanguageOption[];
  value: string;
  onPick(code: string): void;
  /** A code's name, in the UI's language. */
  label(code: string): string;
  disabled?: boolean;
}

interface Row { code: string; name: string; pinned: boolean; group: 'pinned' | 'suggested' | 'all' }

/** The rows as listed: the person's pins, then what the app suggests, then every other language — each once. */
export function languageRows(ordered: readonly LanguageOption[], suggested: readonly LanguageOption[], pins: readonly string[], label: (code: string) => string, query = ''): Row[] {
  const offered = new Set(ordered.map((o) => o.value));
  const row = (code: string, group: Row['group']): Row => ({ code, name: label(code), pinned: pins.includes(code), group });
  const wanted = query.trim().toLowerCase();
  if (wanted) {
    // Typed letters search every name a person might know a language by: the UI's, the English one, and the code.
    return ordered
      .filter((o) => label(o.value).toLowerCase().includes(wanted) || englishLanguageName(o.value).toLowerCase().includes(wanted) || o.value.toLowerCase().startsWith(wanted))
      .map((o) => row(o.value, 'all'));
  }
  const pinned = pins.filter((code) => offered.has(code));
  const next = suggested.map((o) => o.value).filter((code) => offered.has(code) && !pinned.includes(code));
  const above = new Set([...pinned, ...next]);
  return [...pinned.map((code) => row(code, 'pinned')), ...next.map((code) => row(code, 'suggested')), ...ordered.filter((o) => !above.has(o.value)).map((o) => row(o.value, 'all'))];
}

export function useLanguageMenu({ ordered, suggested, value, onPick, label, disabled = false }: LanguageMenuOptions): {
  /** For the select: pressing it opens this list, not the system's. */
  selectProps: { ref(node: HTMLSelectElement | null): void; onMouseDown(e: MouseEvent<HTMLSelectElement>): void; onKeyDown(e: KeyboardEvent<HTMLSelectElement>): void };
  list: ReactNode;
} {
  const { t } = useTranslation();
  const pins = useLanguagePinStore((s) => s.pins);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'bottom-start',
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(4),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
      size({
        padding: 8,
        apply({ rects, availableHeight, elements }) {
          Object.assign(elements.floating.style, { width: `${Math.max(rects.reference.width, 220)}px`, maxHeight: `${Math.max(180, Math.min(380, availableHeight))}px` });
        },
      }),
    ],
  });
  const { getFloatingProps } = useInteractions([useDismiss(context)]);

  const rows = useMemo(() => languageRows(ordered, suggested, pins, label, query), [ordered, suggested, pins, label, query]);

  // Opening starts from an empty search, on the current choice.
  useEffect(() => {
    if (open) setQuery('');
  }, [open]);
  useEffect(() => {
    if (!open) return;
    setActive(Math.max(0, rows.findIndex((r) => r.code === value)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query]);
  useEffect(() => {
    if (open) listRef.current?.querySelector<HTMLElement>(`[data-row="${active}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active, rows.length]);

  const choose = (row: Row | undefined) => {
    if (!row) return;
    setOpen(false);
    if (row.code !== value) onPick(row.code);
  };

  const onListKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(rows.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(rows.length - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(rows[active]); }
  };

  const selectProps = {
    ref: (node: HTMLSelectElement | null) => refs.setReference(node),
    onMouseDown: (e: MouseEvent<HTMLSelectElement>) => {
      if (disabled || e.button !== 0) return;
      // The system's own list stays shut: this one opens in its place.
      e.preventDefault();
      e.currentTarget.focus();
      setOpen((was) => !was);
    },
    onKeyDown: (e: KeyboardEvent<HTMLSelectElement>) => {
      if (disabled) return;
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setOpen(true);
      }
    },
  };

  const list = open ? (
    <FloatingPortal>
      <FloatingFocusManager context={context} initialFocus={0}>
        <div ref={refs.setFloating} className="kt-font-popover kt-lang-popover" style={floatingStyles} {...getFloatingProps({ onKeyDown: onListKeyDown })}>
          <div className="kt-font-search">
            <Search size={14} aria-hidden />
            <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('fork.languageMenu.search')} aria-label={t('fork.languageMenu.search')} spellCheck={false} />
          </div>
          <div className="kt-font-list" ref={listRef} role="listbox">
            {rows.length === 0 && <div className="kt-font-empty">{t('fork.languageMenu.none')}</div>}
            {rows.map((row, i) => (
              <div key={row.code} role="presentation">
                {/* A line under the block at the top: the pins and the suggestions are one block, every other language follows. */}
                {i > 0 && row.group === 'all' && rows[i - 1].group !== 'all' && <div className="kt-lang-divider" role="separator" />}
                <div
                  role="option"
                  aria-selected={row.code === value}
                  data-row={i}
                  className={`kt-font-option kt-lang-option${active === i ? ' is-active' : ''}${row.pinned ? ' is-pinned' : ''}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(row)}
                >
                  <span className="kt-font-option__name">{row.name}</span>
                  {row.code === value && <Check size={14} className="kt-font-option__check" aria-hidden />}
                  <button
                    type="button"
                    className="kt-lang-pin"
                    aria-pressed={row.pinned}
                    aria-label={t(row.pinned ? 'fork.languageMenu.unpin' : 'fork.languageMenu.pin', { name: row.name })}
                    title={t(row.pinned ? 'fork.languageMenu.unpinShort' : 'fork.languageMenu.pinShort')}
                    onClick={(e) => { e.stopPropagation(); useLanguagePinStore.getState().toggle(row.code); }}
                  >
                    <Pin size={13} aria-hidden />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </FloatingFocusManager>
    </FloatingPortal>
  ) : null;

  return { selectProps, list };
}
