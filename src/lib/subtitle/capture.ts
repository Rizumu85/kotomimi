import type { Entry } from '../projection/types';
import type { LegName, SegmentId } from '../conversation/types';
import type { SubtitleSession } from './session';
import { visibleEntries } from '../view/filter';
import type { useSubtitleStore } from '../../stores/subtitleStore';
import type { useSubtitleLookStore } from '../../stores/subtitleLookStore';
import type { useAnnotationStore } from '../../stores/annotationStore';
import { CAPTURE_FORMAT, CAPTURE_VERSION, CAPTURE_WINDOW_MS, CAPTURE_MAX_BYTES, CAPTURE_MAX_FRAMES, captureError } from './captureFormat';

export interface SubtitleCaptureState {
  entries: readonly Entry[];
  session: SubtitleSession | null;
  lit: ReadonlyArray<readonly [SegmentId, number]>;
  settings: Pick<ReturnType<typeof useSubtitleStore.getState>, 'fontSize' | 'compactMode' | 'bgOpacity' | 'bgColor'
    | 'sourceTextColor' | 'translationTextColor' | 'newItemHighlightEnabled' | 'alwaysOnTop' | 'positionLocked'
    | 'speakerDisplayMode' | 'participantDisplayMode'>;
  look: Pick<ReturnType<typeof useSubtitleLookStore.getState>, 'look' | 'shadow' | 'align'>;
  annotation: Pick<ReturnType<typeof useAnnotationStore.getState>, 'furigana' | 'romanization' | 'romanizationOff' | 'pinyin' | 'jyutping' | 'sourceItalic'>;
  viewport: { width: number; height: number; dpr: number };
  surface: 'electron' | 'extension-overlay';
  held: Partial<Record<LegName, string>>;
}

export interface SubtitleCapture {
  format: typeof CAPTURE_FORMAT;
  version: typeof CAPTURE_VERSION;
  appVersion: string;
  platform: string;
  language: string;
  /** Wall time at offset zero; offsets themselves use a monotonic clock. */
  startedAt: number;
  durationMs: number;
  /** A burst exceeded the memory budget; the retained interval is shorter. */
  truncated: boolean;
  /** Full state at zero, then only the fields changed by each frame. */
  frames: { at: number; state: Partial<SubtitleCaptureState> }[];
}
export type SubtitleCaptureRecording = Pick<SubtitleCapture, 'startedAt' | 'durationMs' | 'truncated' | 'frames'>;

/** Owned field deltas: karaoke ticks do not copy the entire caption tail into memory every time. */
export function createSubtitleRecorder(now: () => number = () => performance.now(), wallNow: () => number = Date.now) {
  const origin = now();
  const wall = wallNow();
  let frames: { at: number; json: string }[] = [];
  let bytes = 0;
  let limitedAt = -Infinity;
  let previous: Record<string, string> = {};
  const drop = () => {
    const first = frames.shift()!;
    const next = frames[0];
    bytes -= (first.json.length + next.json.length) * 2;
    next.json = JSON.stringify({ ...JSON.parse(first.json), ...JSON.parse(next.json) });
    bytes += next.json.length * 2;
  };
  const prune = (at: number) => {
    // Keep the last state at/before the left edge, even after a silent minute.
    while (frames.length > 1 && frames[1].at <= at - CAPTURE_WINDOW_MS) drop();
  };
  return {
    clear() { frames = []; bytes = 0; previous = {}; },
    record(state: SubtitleCaptureState) {
      const at = now() - origin;
      prune(at);
      const encoded = Object.fromEntries(Object.entries(state).map(([key, value]) => [key, JSON.stringify(value)]));
      const changed = Object.keys(encoded).filter((key) => encoded[key] !== previous[key]);
      if (!changed.length) return;
      const full = JSON.stringify(state);
      // One pathological sentence may itself exceed the budget. Do not claim a stale state was drawn.
      if (full.length * 2 > CAPTURE_MAX_BYTES) { frames = []; bytes = 0; previous = {}; limitedAt = at; return; }
      const json = frames.length ? JSON.stringify(Object.fromEntries(changed.map((key) => [key, state[key as keyof SubtitleCaptureState]]))) : full;
      previous = encoded;
      frames.push({ at, json });
      bytes += json.length * 2;
      while (bytes > CAPTURE_MAX_BYTES || frames.length > CAPTURE_MAX_FRAMES) { limitedAt = at; drop(); }
    },
    snapshot(): SubtitleCaptureRecording | null {
      const end = now() - origin;
      prune(end);
      if (!frames.length) return null;
      const start = Math.max(0, end - CAPTURE_WINDOW_MS, frames[0].at);
      return {
        startedAt: wall + start, durationMs: end - start, truncated: limitedAt >= end - CAPTURE_WINDOW_MS,
        frames: frames.map(({ at, json }) => ({ at: Math.max(0, at - start), state: JSON.parse(json) as Partial<SubtitleCaptureState> })),
      };
    },
  };
}

export type ReadSubtitleCaptureResult = { ok: true; capture: SubtitleCapture; warning: string | null } | { ok: false; error: string };

/** File boundary: parse once, before scrubbing. A different app version is usable but explicitly reported. */
export function readSubtitleCapture(json: string, appVersion: string): ReadSubtitleCaptureResult {
  if (json.length * 2 > CAPTURE_MAX_BYTES * 2) return { ok: false, error: 'Subtitle capture exceeds the file size limit.' };
  let value: unknown;
  try { value = JSON.parse(json); } catch { return { ok: false, error: 'Subtitle capture is not valid JSON.' }; }
  const error = captureError(value);
  if (error) return { ok: false, error };
  const capture = value as SubtitleCapture;
  return { ok: true, capture, warning: capture.appVersion === appVersion ? null
    : `Captured with Kotomimi ${capture.appVersion}; replaying with ${appVersion}. Layout may differ.` };
}

/** Pure seek; equal timestamps resolve to the last committed state. No stores or clocks are changed. */
export function replaySubtitleCapture(capture: SubtitleCapture, offsetMs: number) {
  const at = Math.min(capture.durationMs, Math.max(0, offsetMs));
  let lo = 0;
  let hi = capture.frames.length;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >>> 1;
    if (capture.frames[mid].at <= at) lo = mid; else hi = mid;
  }
  const state = Object.assign({}, ...capture.frames.slice(0, lo + 1).map((frame) => frame.state)) as SubtitleCaptureState;
  const { entries, session, lit, ...rest } = state;
  const now = capture.startedAt + at;
  return { ...rest, model: { entries: visibleEntries(entries, now), session, lit: new Map(lit) }, now };
}
