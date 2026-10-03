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
  setFurigana: (on: boolean) => Promise<void>;
  setRomanization: (on: boolean) => Promise<void>;
  /** Called once at app boot (`src/routes/Home.tsx`). */
  hydrate: () => Promise<void>;
}

type Field = 'furigana' | 'romanization';
const DEFAULTS: Record<Field, boolean> = { furigana: true, romanization: false };
const KEY = (field: Field) => `settings.common.annotation.${field}`;

export const useAnnotationStore = create<AnnotationState>()(
  subscribeWithSelector((set, get) => {
    const write = (field: Field) => async (on: boolean) => {
      const previous = get()[field];
      set(field === 'furigana' ? { furigana: on } : { romanization: on });
      const { persistSetting } = await import('../services/persistSetting');
      if (!(await persistSetting(KEY(field), on))) set(field === 'furigana' ? { furigana: previous } : { romanization: previous });
    };
    return {
      ...DEFAULTS,
      setFurigana: write('furigana'),
      setRomanization: write('romanization'),
      hydrate: async () => {
        const { ServiceFactory } = await import('../services/ServiceFactory');
        const service = ServiceFactory.getSettingsService();
        const [furigana, romanization] = await Promise.all([
          service.getSetting(KEY('furigana'), DEFAULTS.furigana),
          service.getSetting(KEY('romanization'), DEFAULTS.romanization),
        ]);
        set({ furigana: furigana === true, romanization: romanization === true });
      },
    };
  }),
);
