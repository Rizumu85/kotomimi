/**
 * Fork: the recognition model another device says it hears each leg with, in the run under way. A device that
 * shares its models answers a session's configuration with the model it chose (`transcriber.ts`'s
 * `session.updated`): the one named, or — where that cannot hear the language, or none was named — one of its own.
 * Read from the run's frames (`heardByFrames`), shown where the stage's model is chosen (`LocalAIAssist.tsx`), so
 * that what another device does is seen without looking at it. Forgotten when a run begins and when it is over.
 */
import { create } from 'zustand';
import type { AdapterFrame } from '../lib/contract/adapter';
import type { LegName } from '../lib/conversation/types';
import type { FramePort } from '../lib/session/ports';

interface HeardByStore {
  byLeg: Partial<Record<LegName, string>>;
  set(leg: LegName, model: string): void;
  clear(): void;
}

export const useHeardByStore = create<HeardByStore>()((set) => ({
  byLeg: {},
  set: (leg, model) => set((state) => (state.byLeg[leg] === model ? state : { byLeg: { ...state.byLeg, [leg]: model } })),
  clear: () => set((state) => (Object.keys(state.byLeg).length === 0 ? state : { byLeg: {} })),
}));

/** The model a confirmed configuration names, where it names one. */
export function heardModelOf(frame: AdapterFrame): string | null {
  if (frame.direction !== 'in' || frame.type !== 'session.updated') return null;
  const model = (frame.payload as { audio?: { input?: { transcription?: { model?: unknown } } } } | null)?.audio?.input?.transcription?.model;
  return typeof model === 'string' && model.trim() ? model.trim() : null;
}

/** A frame port that notes each leg's model as its device confirms it. */
export function heardByFrames(store: typeof useHeardByStore = useHeardByStore): FramePort {
  return {
    frame(leg, frame) {
      const model = heardModelOf(frame);
      if (model) store.getState().set(leg, model);
    },
  };
}
