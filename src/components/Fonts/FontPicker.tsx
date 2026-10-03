/**
 * Fork: one font, chosen from the ones installed. A button that names the
 * current choice in its own face; a list under it, each family drawn in
 * itself, with a box to type a few letters of a name into. For a script
 * other than Latin the fonts that can write it come first, a sample of the
 * script beside each; the rest follow, since a font the test misjudges must
 * still be choosable. The first entry returns to the app's own font.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  autoUpdate, flip, FloatingFocusManager, FloatingPortal, offset, shift, size, useClick, useDismiss, useFloating, useInteractions, useRole,
} from '@floating-ui/react';
import { Check, ChevronDown, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { canWrite, listFontFamilies } from '../../lib/fonts/systemFonts';
import './Fonts.scss';

export interface FontPickerProps {
  /** The chosen family; '' is the app's own font. */
  value: string;
  onChange(family: string): void;
  /** What the picker chooses a font for: its accessible name. */
  label: string;
  /** A few characters of the script this font must write (`scriptSample`); Latin letters ask nothing of a font. */
  sample: string;
  disabled?: boolean;
}

interface Entry { family: string; fits: boolean }

const face = (family: string) => ({ fontFamily: `"${family}", var(--kt-font-base, var(--font-sans))` });

export function FontPicker({ value, onChange, label, sample, disabled = false }: FontPickerProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [families, setFamilies] = useState<string[] | null>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement | null>(null);
  const latin = /^[\u0000-ɏ]*$/.test(sample);

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
          Object.assign(elements.floating.style, { width: `${Math.max(rects.reference.width, 260)}px`, maxHeight: `${Math.max(180, Math.min(360, availableHeight))}px` });
        },
      }),
    ],
  });
  const { getReferenceProps, getFloatingProps } = useInteractions([useClick(context, { enabled: !disabled }), useDismiss(context), useRole(context, { role: 'listbox' })]);

  // The fonts are listed when the picker first opens: the platform may ask the user's leave, and only a click may ask.
  useEffect(() => {
    if (!open || families) return undefined;
    let live = true;
    void listFontFamilies().then((found) => { if (live) setFamilies(found); });
    return () => { live = false; };
  }, [open, families]);

  // Opening starts from an empty search, on the current choice.
  useEffect(() => {
    if (open) setQuery('');
  }, [open]);

  const entries = useMemo<Entry[]>(() => {
    if (!families) return [];
    const wanted = query.trim().toLowerCase();
    const shown = wanted ? families.filter((family) => family.toLowerCase().includes(wanted)) : families;
    // A saved font this computer no longer lists stays choosable, so the setting is not silently another.
    const all = value && !wanted && !shown.includes(value) ? [value, ...shown] : shown;
    const judged = all.map((family) => ({ family, fits: latin || canWrite(family, sample) }));
    return latin ? judged : [...judged.filter((e) => e.fits), ...judged.filter((e) => !e.fits)];
  }, [families, query, value, latin, sample]);
  // Row 0 is the app's own font; the families follow.
  const rows = entries.length + 1;
  const firstOther = latin ? -1 : entries.findIndex((e) => !e.fits);

  useEffect(() => {
    if (!open) return;
    const at = value ? entries.findIndex((e) => e.family === value) + 1 : 0;
    setActive(Math.max(0, at));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, families, query]);

  useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>(`[data-row="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active, entries.length]);

  const choose = (row: number) => {
    onChange(row === 0 ? '' : entries[row - 1].family);
    setOpen(false);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(rows - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(rows - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); if (active < rows) choose(active); }
  };

  return (
    <>
      <button
        ref={refs.setReference}
        type="button"
        className={`kt-font-trigger${open ? ' is-open' : ''}`}
        aria-label={label}
        disabled={disabled}
        {...getReferenceProps()}
      >
        <span className={`kt-font-trigger__name${value ? '' : ' is-default'}`} style={value ? face(value) : undefined}>{value || t('fork.fonts.default')}</span>
        <ChevronDown size={14} className="kt-font-trigger__chevron" aria-hidden />
      </button>
      {open && (
        <FloatingPortal>
          <FloatingFocusManager context={context} initialFocus={0}>
            <div ref={refs.setFloating} className="kt-font-popover" style={floatingStyles} {...getFloatingProps({ onKeyDown })}>
              <div className="kt-font-search">
                <Search size={14} aria-hidden />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('fork.fonts.search')}
                  aria-label={t('fork.fonts.search')}
                  spellCheck={false}
                />
              </div>
              <div className="kt-font-list" ref={list} role="presentation">
                <button type="button" role="option" aria-selected={value === ''} data-row={0} className={`kt-font-option${active === 0 ? ' is-active' : ''}`} onMouseEnter={() => setActive(0)} onClick={() => choose(0)}>
                  <span className="kt-font-option__name is-default">{t('fork.fonts.default')}</span>
                  {value === '' && <Check size={14} className="kt-font-option__check" aria-hidden />}
                </button>
                {!families && <div className="kt-font-empty">{t('fork.fonts.loading')}</div>}
                {families && entries.length === 0 && <div className="kt-font-empty">{t('fork.fonts.none')}</div>}
                {entries.map((entry, i) => (
                  <div key={entry.family} role="presentation">
                    {i === firstOther && <div className="kt-font-group">{t('fork.fonts.others')}</div>}
                    <button
                      type="button"
                      role="option"
                      aria-selected={entry.family === value}
                      data-row={i + 1}
                      className={`kt-font-option${active === i + 1 ? ' is-active' : ''}${entry.fits ? '' : ' is-unfit'}`}
                      onMouseEnter={() => setActive(i + 1)}
                      onClick={() => choose(i + 1)}
                    >
                      <span className="kt-font-option__name" style={face(entry.family)}>{entry.family}</span>
                      {!latin && entry.fits && <span className="kt-font-option__sample" style={face(entry.family)} aria-hidden>{sample}</span>}
                      {entry.family === value && <Check size={14} className="kt-font-option__check" aria-hidden />}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </>
  );
}
