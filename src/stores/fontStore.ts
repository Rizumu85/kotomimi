/**
 * Fork: the user's fonts (`src/lib/fonts/fontCss.ts`) — kept, persisted, and
 * put on the page as one style element that is rewritten whenever a choice
 * changes. A store of its own, so no upstream store's shape or tests move.
 * The settings service is imported when first used, as `annotationStore`
 * does and for the same reason.
 */
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { cleanFamily, fontCss, fontLanguage, NO_FONTS, normalizeFonts, type FontSettings } from '../lib/fonts/fontCss';
import { faceNames, listFontFamilies } from '../lib/fonts/systemFonts';

interface FontState extends FontSettings {
  setUi(family: string): void;
  setLatin(family: string): void;
  /** A blank family removes the choice. */
  setText(language: string, family: string): void;
  setRuby(language: string, family: string): void;
  /** Both of a language's choices gone. */
  clearLanguage(language: string): void;
  /** Called once at app boot (`src/routes/Home.tsx`). */
  hydrate(): Promise<void>;
}

const KEY = 'settings.common.fonts';
const STYLE_ID = 'kt-fonts';

/** The choices as the page's style sheet. Nothing is added while nothing is chosen. */
export function applyFonts(settings: FontSettings, doc: Document | undefined = typeof document === 'undefined' ? undefined : document): void {
  if (!doc) return;
  const css = fontCss(settings);
  let style = doc.getElementById(STYLE_ID);
  if (!css) {
    style?.remove();
    return;
  }
  if (!style) {
    style = doc.createElement('style');
    style.id = STYLE_ID;
    doc.head.appendChild(style);
  }
  if (style.textContent !== css) style.textContent = css;
}

const settingsOf = (s: FontSettings): FontSettings => ({ ui: s.ui, latin: s.latin, latinFaces: s.latinFaces, text: s.text, ruby: s.ruby });

/** A table with one language set, or — a blank family — without it. */
function withLanguage(table: Readonly<Record<string, string>>, language: string, family: string): Record<string, string> {
  const next = { ...table };
  const lang = fontLanguage(language);
  if (!lang) return next;
  const name = cleanFamily(family);
  if (name) next[lang] = name;
  else delete next[lang];
  return next;
}

export const useFontStore = create<FontState>()(
  subscribeWithSelector((set, get) => {
    /** Loaded once: the choices are then written in the order they were made. */
    let saver: Promise<typeof import('../services/persistSetting')> | null = null;
    const commit = (patch: Partial<FontSettings>) => {
      set(patch);
      const next = settingsOf(get());
      applyFonts(next);
      saver ??= import('../services/persistSetting');
      void saver.then(({ persistSetting }) => persistSetting(KEY, next));
    };
    return {
      ...NO_FONTS,
      setUi: (family) => commit({ ui: cleanFamily(family) }),
      // Chosen from the platform's list, so its face's own names are known: kept with it, for the next start.
      setLatin: (family) => commit({ latin: cleanFamily(family), latinFaces: faceNames(family) }),
      setText: (language, family) => commit({ text: withLanguage(get().text, language, family) }),
      setRuby: (language, family) => commit({ ruby: withLanguage(get().ruby, language, family) }),
      clearLanguage: (language) => commit({ text: withLanguage(get().text, language, ''), ruby: withLanguage(get().ruby, language, '') }),
      hydrate: async () => {
        const { ServiceFactory } = await import('../services/ServiceFactory');
        const stored = await ServiceFactory.getSettingsService().getSetting<unknown>(KEY, null);
        const fonts = normalizeFonts(stored);
        set(fonts);
        applyFonts(fonts);
        // A Latin font saved before its face's names were kept: they are looked up the first time the person
        // touches the app — the platform lists its fonts only after a gesture — and saved from then on.
        if (fonts.latin && fonts.latinFaces.length === 0 && typeof window !== 'undefined') {
          const lookUp = () => {
            void listFontFamilies().then(() => {
              const names = faceNames(get().latin);
              if (names.length > 0 && get().latinFaces.length === 0) commit({ latinFaces: names });
            });
          };
          window.addEventListener('pointerdown', lookUp, { once: true, capture: true });
        }
      },
    };
  }),
);
