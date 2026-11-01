/**
 * Fork: every `title` in a document, drawn as the app draws things. A hundred-odd controls say what they are by their
 * `title`, and the system's own box for it is a white-edged black rectangle in the system's font (the user, 2026-10-31).
 * They stay as they are written: while the pointer is over one, its `title` is held here, so the system has nothing to
 * show, and handed back when the pointer leaves. A control that needs more than a word uses `Tooltip`.
 */
import { computePosition, flip, offset, shift } from '@floating-ui/react';
import './titleTips.scss';

/** As long as a pointer rests before it means to ask. */
const SHOW_AFTER_MS = 350;

/** Installs the tips in a document (the app's, the subtitle window's, a popover's); the function returned takes them out. */
export function installTitleTips(doc: Document): () => void {
  const own = doc.defaultView ?? window;
  let held: { element: Element; text: string } | null = null;
  let waiting: ReturnType<typeof setTimeout> | undefined;
  let tip: HTMLElement | null = null;

  const hide = () => {
    clearTimeout(waiting);
    tip?.remove();
    tip = null;
  };
  /** The tip gone and the `title` back, unless it was written anew meanwhile. */
  const release = () => {
    hide();
    if (held && !held.element.hasAttribute('title')) held.element.setAttribute('title', held.text);
    held = null;
  };
  const show = () => {
    if (!held || !held.element.isConnected) return;
    const drawn = doc.createElement('div');
    drawn.className = 'kt-title-tip';
    drawn.setAttribute('role', 'tooltip');
    drawn.textContent = held.text;
    doc.body.append(drawn);
    tip = drawn;
    void computePosition(held.element, drawn, { placement: 'bottom', strategy: 'fixed', middleware: [offset(6), flip({ padding: 6 }), shift({ padding: 6 })] }).then(({ x, y }) => {
      Object.assign(drawn.style, { left: `${x}px`, top: `${y}px`, visibility: 'visible' });
    });
  };
  const over = (event: Event) => {
    const target = event.target as Element | null;
    if (held?.element.contains(target)) return;
    release();
    const element = target?.closest?.('[title]');
    const text = element?.getAttribute('title')?.trim();
    if (!element || !text) return;
    held = { element, text: element.getAttribute('title') as string };
    element.removeAttribute('title');
    waiting = setTimeout(show, SHOW_AFTER_MS);
  };
  const out = (event: Event) => {
    if (held && !held.element.contains((event as MouseEvent).relatedTarget as Node | null)) release();
  };

  doc.addEventListener('mouseover', over, true);
  doc.addEventListener('mouseout', out, true);
  // Whatever is done next, the tip is not what it is about.
  for (const name of ['mousedown', 'keydown', 'wheel']) doc.addEventListener(name, hide, true);
  own.addEventListener('blur', hide);
  return () => {
    release();
    doc.removeEventListener('mouseover', over, true);
    doc.removeEventListener('mouseout', out, true);
    for (const name of ['mousedown', 'keydown', 'wheel']) doc.removeEventListener(name, hide, true);
    own.removeEventListener('blur', hide);
  };
}
