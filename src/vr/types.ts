// src/vr/types.ts
/**
 * Fork: what the main window, the main process and the two headset pages
 * (`vr.html#strip`, `vr.html#wrist`) exchange for the SteamVR overlay.
 * Plain data, JSON-safe. Every word the pages show comes in `words`, put
 * into the user's language by the main window: the pages hold no strings.
 */
import type { LegName } from '../lib/conversation/types';

export type VrSurface = 'strip' | 'wrist';

export interface VrLine {
  id: string;
  leg: LegName;
  source: string;
  translation: string;
  final: boolean;
}

export interface VrChoice { value: string; label: string }

export interface VrModel {
  id: string;
  label: string;
  /** How it ran in this headset session: text behind the voice, or a sentence's translation. Absent: not tried. */
  ms?: number;
}

export interface VrWords {
  me: string;
  them: string;
  pause: string;
  resume: string;
  hide: string;
  show: string;
  tune: string;
  back: string;
  theirs: string;
  mine: string;
  hear: string;
  translate: string;
  more: string;
  /** "{name}" for the model or language being switched to. */
  switching: string;
  loading: string;
  untried: string;
  /** "{s}" seconds. */
  behind: string;
  perSentence: string;
  /** "{fps}". */
  fps: string;
  dropping: string;
  /** "{used}" and "{total}", in GB. */
  vram: string;
  idle: string;
  stopped: string;
  stoppedShort: string;
  muted: string;
}

export interface VrState {
  words: VrWords;
  phase: 'idle' | 'starting' | 'running' | 'stopping';
  /** A change asked from the wrist that restarts the run, while it does. */
  switching: { kind: 'theirs' | 'mine' | 'hear' | 'translate'; label: string } | null;
  /** The last run ended on a failure: what it said. */
  failed: string | null;
  heard: Partial<Record<LegName, boolean>> | null;
  /** VRChat has the user muted: their leg hears silence. */
  muted: boolean;
  /** The last few lines, oldest first. */
  lines: VrLine[];
  theirs: { value: string; options: VrChoice[]; quick: string[] };
  mine: { value: string; options: VrChoice[] };
  hear: { value: string; options: VrModel[] };
  translate: { value: string; options: VrModel[] };
  strip: boolean;
}

export interface VrPerf {
  hz: number;
  /** Frames per second the headset showed, reprojected or not; absent while no game is in front. */
  presents?: number;
  dropped?: number;
  reprojected?: number;
  vramUsed: number;
  vramTotal: number;
}

export type VrCommand =
  | { type: 'theirs'; value: string }
  | { type: 'mine'; value: string }
  | { type: 'run'; on: boolean }
  | { type: 'strip'; on: boolean }
  | { type: 'hear'; id: string }
  | { type: 'translate'; id: string };

/** What the page asks of the main process itself. */
export interface VrSize { surface: VrSurface; width: number; height: number }
