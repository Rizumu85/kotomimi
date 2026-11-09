// src/vr/types.ts
/**
 * Fork: what the main window, the main process and the two pages — the
 * headset's strip (`vr.html#strip`) and the wrist panel's window
 * (`vr.html#wrist`) — exchange for the SteamVR overlay.
 * Plain data, JSON-safe. Every word the pages show comes in `words`, put
 * into the user's language by the main window: the pages hold no strings.
 */
import type { LegName } from '../lib/conversation/types';
import type { Entry } from '../lib/projection/types';
import type { LegFilters } from '../lib/view/filter';

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
  /** VRChat's chatbox: what goes above the user's avatar. */
  chatbox: string;
  /** The strip's height, and its three. */
  height: string;
  heightHigh: string;
  heightMid: string;
  heightLow: string;
  /** The panel window's title, which a wrist tool lists it by. */
  panel: string;
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
  /**
   * `lit`: their language lit beside the main one (`MoreLanguages.lit`): heard, and the user's speech translated into it
   * too. `row`: `quick` is their row ("对方说"), pressed to light or put out as in the settings, and a language picked from
   * `options` joins it lit; else `quick` is a few to switch their main one to.
   */
  theirs: { value: string; lit?: string; options: VrChoice[]; quick: string[]; row?: boolean };
  mine: { value: string; options: VrChoice[] };
  hear: { value: string; options: VrModel[] };
  translate: { value: string; options: VrModel[] };
  strip: boolean;
  /** VRChat's chatbox shows the user's sentences. */
  chatbox: boolean;
  /** How high the strip sits (`VrHeight`). */
  height: 'high' | 'mid' | 'low';
  /** What the strip draws, as the computer's subtitle does (`SubtitleLanes`). */
  captions: VrCaptions;
}

/**
 * Fork: the strip is the computer's subtitle, drawn in the headset: each side's newest sentence with its translation
 * and, where grammar feedback is on, the feedback — the same lanes, held the same while each is read. The page is a
 * window of its own: what the subtitle reads from the app's stores comes along.
 */
export interface VrCaptions {
  /** The conversation's latest entries, oldest first (a video's words left out, as the subtitle leaves them). */
  entries: Entry[];
  /** The legs the run hears: each has its lane. */
  legs: LegName[];
  /** The subtitle's own display modes. */
  filters: LegFilters;
  /** What answers the user's own sentences is grammar feedback (`useCoachingStore`). */
  coached: boolean;
  /** The reading aids switched on (`useAnnotationStore`). */
  aids: { furigana: boolean; romanization: boolean; romanizationOff: string[]; pinyin: boolean; jyutping: boolean; sourceItalic: boolean };
  pair: { source: string; target: string } | null;
  /** The app's language, for the few words the lanes write (a notice). */
  language: string;
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
  | { type: 'chatbox'; on: boolean }
  | { type: 'height'; value: 'high' | 'mid' | 'low' }
  | { type: 'hear'; id: string }
  | { type: 'translate'; id: string };

/** What the page asks of the main process itself. */
export interface VrSize { surface: VrSurface; width: number; height: number }
