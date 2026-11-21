/**
 * Fork: a line of the conversation said aloud on demand (`src/app/lineVoice.ts`) — what the rows read of it: whether
 * a voice is there to say one at all, and which line is being fetched or heard now. Light on purpose: the
 * conversation list is drawn in places (previews, tests) that never build the app's playback.
 */
import { create } from 'zustand';

export type LineVoicePhase = 'idle' | 'loading' | 'playing';

export interface LineVoiceState {
  /** A voice can be asked now: the stage is on, and what speaks is here (a model downloaded, an API named). */
  ready: boolean;
  /** The languages that voice speaks, by base code. Null: any. */
  languages: readonly string[] | null;
  /** The line being fetched or heard: what its button was given as `id`. Null: none. */
  line: string | null;
  phase: LineVoicePhase;
  /** The line whose voice could not be made, until another is asked for. */
  failed: string | null;
}

export const useLineVoiceStore = create<LineVoiceState>()(() => ({ ready: false, languages: null, line: null, phase: 'idle', failed: null }));
