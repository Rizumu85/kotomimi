/**
 * Fork: a word recognition got wrong, put right from the conversation. Select it in what was said, write it as it
 * should be, and the glossary has one more line: there is no column to think about, and only what really went wrong is
 * written down, in the language it was said in. It holds from the next sentence, and the rows on screen follow.
 */
import { memo, useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { FloatingFocusManager, FloatingPortal, autoUpdate, flip, offset, shift, useDismiss, useFloating, useInteractions } from '@floating-ui/react';
import { useTranslation } from 'react-i18next';
import { MAX_GLOSSARY_ENTRIES } from '../../lib/glossary/glossary';
import { useGlossaryStore } from '../../stores/glossaryStore';
import './WordFix.scss';

/** More than this is a phrase, not a word that was misheard. */
const MOST_CHARACTERS = 40;

const sourceRowOf = (node: Node): Element | null => (node instanceof Element ? node : node.parentElement)?.closest('.row-text.src') ?? null;

/** What is selected in a single row of what was said, without the readings drawn over it; null for anything else. */
export function heardIn(display: HTMLElement): { text: string; box: DOMRect | null } | null {
  const selection = display.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const row = sourceRowOf(range.startContainer);
  if (!row || row !== sourceRowOf(range.endContainer) || !display.contains(row)) return null;
  const said = range.cloneContents();
  said.querySelectorAll('rt, rp, .annot-roman').forEach((reading) => reading.remove());
  const text = (said.textContent ?? '').trim();
  if (!text || [...text].length > MOST_CHARACTERS) return null;
  return { text, box: range.getBoundingClientRect?.() ?? null };
}

/** Memoized: the list draws again for every word heard, and this has nothing to do with that. */
export const WordFix = memo(function WordFix({ display }: { display: RefObject<HTMLDivElement | null> }) {
  const { t } = useTranslation();
  const [heard, setHeard] = useState<{ text: string; box: DOMRect | null } | null>(null);
  const [written, setWritten] = useState('');
  const field = useRef<HTMLInputElement>(null);
  const add = useGlossaryStore((state) => state.add);
  const full = useGlossaryStore((state) => state.entries.length >= MAX_GLOSSARY_ENTRIES && !state.entries.some((entry) => entry.source.toLocaleLowerCase() === written.trim().toLocaleLowerCase()));

  useEffect(() => {
    const element = display.current;
    // A list drawn in another window (the expanded subtitle) has a document of its own, which this popover is not in.
    if (!element || element.ownerDocument !== document) return undefined;
    const pick = (event: MouseEvent) => {
      if (event.button !== 0) return;
      const found = heardIn(element);
      if (!found) return;
      setHeard(found);
      setWritten(found.text);
    };
    element.addEventListener('mouseup', pick);
    return () => element.removeEventListener('mouseup', pick);
  }, [display]);

  const { refs, floatingStyles, context } = useFloating({
    open: heard !== null,
    onOpenChange: (open) => { if (!open) setHeard(null); },
    placement: 'bottom-start',
    whileElementsMounted: autoUpdate,
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
  });
  const box = heard?.box;
  useEffect(() => {
    if (box) refs.setPositionReference({ getBoundingClientRect: () => box });
  }, [box, refs]);
  const { getFloatingProps } = useInteractions([useDismiss(context)]);

  if (!heard) return null;
  const word = written.trim();
  const changed = word !== '' && word !== heard.text;
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!changed || full) return;
    add({ source: word, aliases: [heard.text] });
    setHeard(null);
  };
  return (
    <FloatingPortal>
      <FloatingFocusManager context={context} initialFocus={field} modal={false}>
        <form ref={refs.setFloating} className="word-fix" style={floatingStyles} onSubmit={save} {...getFloatingProps()}>
          <label className="word-fix__row">
            <span>{t('settings.glossaryFixTo')}</span>
            <input ref={field} value={written} onChange={(event) => setWritten(event.target.value)} onFocus={(event) => event.currentTarget.select()} />
          </label>
          <button type="submit" className="word-fix__save" disabled={!changed || full}>{t(full ? 'settings.glossaryFull' : 'settings.glossaryFixSave')}</button>
        </form>
      </FloatingFocusManager>
    </FloatingPortal>
  );
});
