import { registerThemeDocument } from '../../../lib/theme/theme';

/** Keep a portal document's styles, fonts and root variables in sync with its owning app. */
export function mirrorChildDocument(from: Document, to: Document): () => void {
  const base = to.createElement('base');
  base.href = from.baseURI;
  to.head.appendChild(base);
  const copies = new Map<Element, Element>();
  const sync = () => {
    const sources = new Set(from.querySelectorAll('style, link[rel="stylesheet"]'));
    for (const [source, copy] of copies) {
      if (!sources.has(source)) { copy.remove(); copies.delete(source); }
    }
    for (const source of sources) {
      const old = copies.get(source);
      if (old?.isEqualNode(source)) continue;
      const copy = to.importNode(source, true);
      if (old) old.replaceWith(copy); else to.head.appendChild(copy);
      copies.set(source, copy);
    }
    to.documentElement.style.cssText = from.documentElement.style.cssText;
    to.documentElement.lang = from.documentElement.lang;
  };
  sync();
  const untheme = registerThemeDocument(to);
  const observer = new MutationObserver(sync);
  observer.observe(from.head, { childList: true, subtree: true, characterData: true, attributes: true });
  observer.observe(from.documentElement, { attributes: true, attributeFilter: ['style', 'lang'] });
  return () => { observer.disconnect(); untheme(); };
}
