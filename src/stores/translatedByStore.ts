/**
 * Fork: the translation model another device answered with, in the run under way. A device that shares its models
 * may be left the choice (`src/lib/lan/translator.ts`): the one that ran is named in its answer, never in the
 * request — so what it chose is read from the run's frames (`translatedByFrames`) and shown beside the stage's
 * model (`LocalAIAssist.tsx`). Nothing is written to the settings: it is what happened, not a choice.
 * Forgotten when a run begins and when it is over, as `heardByStore` is.
 */
import { create } from 'zustand';
import type { AdapterFrame } from '../lib/contract/adapter';
import type { LegName } from '../lib/conversation/types';
import type { FramePort } from '../lib/session/ports';

interface TranslatedByStore {
  byLeg: Partial<Record<LegName, string>>;
  set(leg: LegName, model: string): void;
  clear(): void;
}

export const useTranslatedByStore = create<TranslatedByStore>()((set) => ({
  byLeg: {},
  set: (leg, model) => set((state) => (state.byLeg[leg] === model ? state : { byLeg: { ...state.byLeg, [leg]: model } })),
  clear: () => set((state) => (Object.keys(state.byLeg).length === 0 ? state : { byLeg: {} })),
}));

/** The model a finished translation says it was answered by, where the answer says. */
export function servedModelOf(frame: AdapterFrame): string | null {
  if (frame.direction !== 'in' || frame.type !== 'text.done') return null;
  const payload = frame.payload as { stage?: unknown; served?: unknown } | null;
  if (payload?.stage !== 'translate') return null;
  return typeof payload.served === 'string' && payload.served.trim() ? payload.served.trim() : null;
}

/** A frame port that notes each leg's translation model as an answer names it. */
export function translatedByFrames(store: typeof useTranslatedByStore = useTranslatedByStore): FramePort {
  return {
    frame(leg, frame) {
      const model = servedModelOf(frame);
      if (model) store.getState().set(leg, model);
    },
  };
}
