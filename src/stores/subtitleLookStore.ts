/**
 * Fork: what the subtitle strip's looks add to its settings
 * (`src/lib/subtitle/look.ts`): which look was last chosen, how strong the
 * shadow around the text is, and whether the text is centred. The rest of a
 * look — the panel's colour and opacity, the two text colours — is the
 * subtitle store's own, as before. A store of its own, so no upstream
 * store's shape or tests move; the settings service is imported when first
 * used, as `annotationStore.ts` does and for the same reason.
 */
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { LOOK_ORDER, LOOKS, type Align, type Look } from '../lib/subtitle/look';

interface SubtitleLookState {
  /** The look last chosen: the one the settings show as picked. Changing a value after does not unpick it. */
  look: Look;
  /** 0–100. */
  shadow: number;
  align: Align;
  /**
   * The mouse passes through the strip (`SubtitleView`): on until it is turned off by the strip's own button, and
   * never kept — a strip nobody can click, found that way at the next start, would be a trap.
   */
  through: boolean;
  setThrough: (on: boolean) => void;
  setLook: (look: Look) => Promise<void>;
  setShadow: (shadow: number) => Promise<void>;
  setAlign: (align: Align) => Promise<void>;
  /** Called once at app boot (`src/routes/Home.tsx`). */
  hydrate: () => Promise<void>;
}

type Field = 'look' | 'shadow' | 'align';
const DEFAULTS = { look: 'panel' as Look, shadow: LOOKS.panel.shadow, align: LOOKS.panel.align };
const KEY = (field: Field) => `settings.common.subtitleLook.${field}`;
const strength = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : DEFAULTS.shadow);

export const useSubtitleLookStore = create<SubtitleLookState>()(
  subscribeWithSelector((set, get) => {
    const write = async <F extends Field>(field: F, value: SubtitleLookState[F]) => {
      const previous = get()[field];
      set({ [field]: value } as Pick<SubtitleLookState, F>);
      const { persistSetting } = await import('../services/persistSetting');
      if (!(await persistSetting(KEY(field), value))) set({ [field]: previous } as Pick<SubtitleLookState, F>);
    };
    return {
      ...DEFAULTS,
      through: false,
      setThrough: (on) => set({ through: on }),
      setLook: (look) => write('look', look),
      setShadow: (shadow) => write('shadow', strength(shadow)),
      setAlign: (align) => write('align', align),
      hydrate: async () => {
        const { ServiceFactory } = await import('../services/ServiceFactory');
        const service = ServiceFactory.getSettingsService();
        const [look, shadow, align] = await Promise.all([
          service.getSetting<unknown>(KEY('look'), DEFAULTS.look),
          service.getSetting<unknown>(KEY('shadow'), DEFAULTS.shadow),
          service.getSetting<unknown>(KEY('align'), DEFAULTS.align),
        ]);
        set({
          look: LOOK_ORDER.includes(look as Look) ? (look as Look) : DEFAULTS.look,
          shadow: strength(shadow),
          align: align === 'center' ? 'center' : 'left',
        });
      },
    };
  }),
);
