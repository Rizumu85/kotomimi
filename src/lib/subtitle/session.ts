/**
 * The run as a subtitle surface needs it — plain data, so the extension
 * overlay can receive it over its wire (spec: "The two subtitle surfaces are
 * not the same thing").
 */
import type { LegName } from '../conversation/types';
import type { LanguagePair, Readiness } from '../provider/types';
import { NO_MICROPHONE, type Refusal } from '../session/shape';
import type { RunNotice, RunState, TurnMode } from '../session/types';

/** What the subtitle body shows while no run is live. */
export type SubtitleIdleModel =
  | { kind: 'ready' }
  | { kind: 'ended' }
  | { kind: 'starting' }
  /** `message` is diagnostic English; `code`, when present, is what the surface words. */
  | { kind: 'unready'; message: string; code?: string; params?: Record<string, string | number>; unsure?: true }
  | { kind: 'failed'; notice: RunNotice };

/** The languages each side may speak beside its main one (`SubtitleSession.beside`). */
export interface Beside { mine: readonly string[]; theirs: readonly string[] }

export interface SubtitleSession {
  phase: RunState['phase'];
  /** The wall clock the run went live; null unless running. */
  since: number | null;
  /** The audio mode's legs (intent) joined with the conversation's (ruling 12): the bar's display-mode buttons follow them. Also crosses the overlay's wire. */
  legs: readonly LegName[];
  /** The selected provider's language pair, for the bar. */
  pair: LanguagePair | null;
  /**
   * Fork: the translations a sentence of the user's has beyond the first: the other side's languages lit beside their
   * main one. The strip has a line for each from the start (`Lane.more`). Absent: none.
   */
  also?: number;
  /**
   * Fork: the languages each side may speak beside the pair's: the user's in use ("我也会说"), and the one of the other
   * side's lit. The strip keeps the room their reading aids take from the start (`plannedRoom`). Absent: none.
   */
  beside?: Beside;
  /** A run is live under manual turns with a speaker leg to hold (plan 1e-4 ruling 8): the surface offers its hold control. */
  holdToTalk: boolean;
  /** Start is offered: false while a run is not idle, no microphone is chosen, the provider's entry has not loaded, the start gate refuses (F7), or the provider is known to be unready or is being checked. */
  canStart: boolean;
  idle: SubtitleIdleModel;
}

export interface SubtitleSessionInput {
  run: RunState;
  readiness: Readiness | undefined;
  pair: LanguagePair | null;
  /** Fork: `SubtitleSession.also`. */
  also?: number;
  /** Fork: `SubtitleSession.beside`. */
  beside?: Beside;
  turnMode: TurnMode;
  legs: readonly LegName[];
  /** The app's capture needs a microphone and none is chosen (1e-3 ruling 5). */
  microphoneMissing?: boolean;
  /** The selected provider's entry has loaded: until then a start would be refused as no provider (plan 1e-3b-1 ruling 11). Default true. */
  providerLoaded?: boolean;
  /** What the start gate refuses over the stores as they stand (F7), or null. */
  refusal?: Refusal | null;
}

/**
 * The idle body, first match wins: a start under way; no microphone chosen
 * (the precedence the old start gate had: a missing device before the
 * provider's own blocker); the start gate's refusal (F7); a provider that is
 * not ready (a live blocker outranks a stale failure, as before); a start
 * that was refused or failed; any other end — a run that failed mid-way
 * ended, and its notice is in the conversation; nothing yet.
 */
export function idleOf(run: RunState, readiness: Readiness | undefined, microphoneMissing = false, refusal: Refusal | null = null): SubtitleIdleModel {
  if (run.phase === 'starting') return { kind: 'starting' };
  if (run.phase !== 'idle') return { kind: 'ended' };
  if (microphoneMissing) return { kind: 'unready', message: 'No microphone is chosen for the speaker leg.', code: NO_MICROPHONE };
  // The start gate's refusal (F7): this shape cannot start — after the
  // device, where today's computeStartGate put its participant blocker,
  // and before the provider's readiness.
  if (refusal) return { kind: 'unready', message: refusal.message, code: refusal.code, ...(refusal.params ? { params: refusal.params } : {}) };
  if (readiness?.state === 'not-ready') return { kind: 'unready', message: readiness.reason, ...(readiness.code ? { code: readiness.code } : {}), ...(readiness.params ? { params: readiness.params } : {}), ...(readiness.unsure ? { unsure: true as const } : {}) };
  const end = run.lastEnd;
  if (end && (end.reason === 'refused' || end.reason === 'start-failed') && end.notice) return { kind: 'failed', notice: end.notice };
  return end ? { kind: 'ended' } : { kind: 'ready' };
}

export function subtitleSession({ run, readiness, pair, also = 0, beside, turnMode, legs, microphoneMissing = false, providerLoaded = true, refusal = null }: SubtitleSessionInput): SubtitleSession {
  return {
    phase: run.phase,
    since: run.phase === 'running' ? run.since : null,
    legs,
    pair,
    ...(also > 0 ? { also } : {}),
    ...(beside && (beside.mine.length > 0 || beside.theirs.length > 0) ? { beside } : {}),
    // A press opens a turn on the speaker leg only (`Run.press`, run.ts:275-281):
    // a participant-only run offers no hold — it would do nothing.
    holdToTalk: run.phase === 'running' && turnMode !== 'auto' && run.legs.speaker !== undefined,
    // Off for a run under way, no microphone, an entry not yet loaded, the gate's refusal, or a provider known unready or being checked; an unknown readiness is the runner's to check at start.
    // Fork: an answer that could not find out (`unsure`) does not hold the start: pressing it asks again.
    canStart: run.phase === 'idle' && !microphoneMissing && !(readiness?.state === 'not-ready' && !readiness.unsure) && readiness?.state !== 'checking' && providerLoaded && !refusal,
    idle: idleOf(run, readiness, microphoneMissing, refusal),
  };
}

/** Shallow: every key of `a` and `b` matches, both ways. */
function sameParams(a: Record<string, string | number> | undefined, b: Record<string, string | number> | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return aKeys.length === bKeys.length && aKeys.every((key) => a[key] === b[key]);
}

const sameCodes = (a: readonly string[] = [], b: readonly string[] = []): boolean => a.length === b.length && a.every((code, i) => code === b[i]);

function sameIdle(a: SubtitleIdleModel, b: SubtitleIdleModel): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'unready' && b.kind === 'unready') return a.message === b.message && a.code === b.code && sameParams(a.params, b.params);
  if (a.kind === 'failed' && b.kind === 'failed') return a.notice === b.notice || (a.notice.code === b.notice.code && a.notice.message === b.notice.message);
  return true;
}

/** Two sessions that draw the same, compared by value, so a source can keep its identity. */
export function sameSession(a: SubtitleSession, b: SubtitleSession): boolean {
  return a.phase === b.phase && a.since === b.since && a.holdToTalk === b.holdToTalk && a.canStart === b.canStart
    && a.legs.length === b.legs.length && a.legs.every((leg, i) => leg === b.legs[i])
    && a.pair?.source === b.pair?.source && a.pair?.target === b.pair?.target && (a.also ?? 0) === (b.also ?? 0)
    && sameCodes(a.beside?.mine, b.beside?.mine) && sameCodes(a.beside?.theirs, b.beside?.theirs)
    && sameIdle(a.idle, b.idle);
}
