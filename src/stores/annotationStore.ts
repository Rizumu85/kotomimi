/**
 * Fork: the reading aids' two switches — furigana over kanji, and a
 * romanization line — for every surface that draws conversation text (the
 * panel's list, the subtitle's list and bands). One pair for all of them: a
 * reader who needs readings needs them wherever the text is. A store of its
 * own, so no upstream store's shape or tests move. The settings service is
 * imported when first used, not with the module: every component that draws
 * conversation text imports this store, and their tests mock i18n in ways
 * the service's own imports do not survive.
 */
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

interface AnnotationState {
  /** Hiragana over kanji in Japanese text. On by default: it changes nothing but Japanese. */
  furigana: boolean;
  /** A line in Latin letters under Japanese, Korean and Russian text. */
  romanization: boolean;
  /**
   * The source text in italics, as upstream sets it. A switch because slanted kana and hanzi are synthesized by the
   * browser (few CJK fonts have an italic), and a reader of them may find the upright form easier. On by default:
   * the look stays what it was.
   */
  sourceItalic: boolean;
  setFurigana: (on: boolean) => Promise<void>;
  setRomanization: (on: boolean) => Promise<void>;
  setSourceItalic: (on: boolean) => Promise<void>;
  /** Called once at app boot (`src/routes/Home.tsx`). */
  hydrate: () => Promise<void>;
}

type Field = 'furigana' | 'romanization' | 'sourceItalic';
const DEFAULTS: Record<Field, boolean> = { furigana: true, romanization: false, sourceItalic: true };

/**
 * The source text's slant, where the stylesheets read it (`ConversationRow.scss`, `SubtitleStream.scss`): a custom
 * property on the document, so every list and band of the window follows without each being told.
 */
export const SOURCE_FONT_STYLE = '--kt-source-font-style';
function slant(on: boolean): void {
  if (typeof document !== 'undefined') document.documentElement.style.setProperty(SOURCE_FONT_STYLE, on ? 'italic' : 'normal');
}
const KEY = (field: Field) => `settings.common.annotation.${field}`;

export const useAnnotationStore = create<AnnotationState>()(
  subscribeWithSelector((set, get) => {
    const write = (field: Field) => async (on: boolean) => {
      const previous = get()[field];
      set({ [field]: on } as Pick<AnnotationState, Field>);
      const { persistSetting } = await import('../services/persistSetting');
      if (!(await persistSetting(KEY(field), on))) set({ [field]: previous } as Pick<AnnotationState, Field>);
    };
    return {
      ...DEFAULTS,
      setFurigana: write('furigana'),
      setRomanization: write('romanization'),
      setSourceItalic: write('sourceItalic'),
      hydrate: async () => {
        const { ServiceFactory } = await import('../services/ServiceFactory');
        const service = ServiceFactory.getSettingsService();
        const [furigana, romanization, sourceItalic] = await Promise.all([
          service.getSetting(KEY('furigana'), DEFAULTS.furigana),
          service.getSetting(KEY('romanization'), DEFAULTS.romanization),
          service.getSetting(KEY('sourceItalic'), DEFAULTS.sourceItalic),
        ]);
        // Only a stored "off" turns the slant off: anything else is the default.
        set({ furigana: furigana === true, romanization: romanization === true, sourceItalic: sourceItalic !== false });
      },
    };
  }),
);

// The document follows the switch, from the moment the store exists.
slant(useAnnotationStore.getState().sourceItalic);
useAnnotationStore.subscribe((s) => s.sourceItalic, slant);
