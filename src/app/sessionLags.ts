import { createStore } from 'zustand/vanilla';
import type { LegName } from '../lib/conversation/types';
import type { Entry } from '../lib/projection/types';
import type { LevelMeter } from '../lib/audio/levelMeter';
import type { Clock } from '../lib/contract/clock';
import { every } from '../lib/contract/clock';
import type { RunState } from '../lib/session/types';
import type { Readable } from '../lib/view/conversationView';

export type LagStage = LegName | 'translation';
export type LagModels = Record<LagStage, string | null>;
export interface FallingBehind { stage: LagStage; model: string; averageMS: number }
export interface SessionLagState {
  averages: Record<string, number>;
  fallingBehind: Partial<Record<LagStage, FallingBehind>>;
  /**
   * The first threshold crossing only, stable until the session ends. Fork: of a stage one of this computer's own
   * models runs (`LagPlanned`) — the notice offers a lighter plan, and there is none for another device, an API or a
   * cloud provider.
   */
  notice: FallingBehind | null;
}
/** The stages whose model is one of this computer's own, which a plan can change. */
export type LagPlanned = ReadonlySet<LagStage>;
const EVERY_STAGE: LagPlanned = new Set<LagStage>(['speaker', 'participant', 'translation']);
/** What is shown as a stage's delay: the average of its latest few lines. */
const AVERAGE_OF = 5;
/**
 * A stage falls behind when most of its latest lines are slow, not when a few are: the time measured includes the
 * pause that ends a sentence, and a recognizer that is quick most of the time has slow lines now and then. Measured
 * on the user's records of 2026-11-21 to 24 (Qwen3-ASR 0.6B and 1.7B, Apple Speech; median 0.8-1.8 s, a tenth over
 * 3 s): five averaged over 2 s flagged 13 of 23 runs, eight of ten over 2 s only the one whose median was 2.5 s.
 */
const BEHIND_OF = 10;
const BEHIND_SLOW = 8;

/** Session-owned measurements; all surfaces read the same averages. Times are milliseconds. */
export function createSessionLags() {
  const empty = (): SessionLagState => ({ averages: {}, fallingBehind: {}, notice: null });
  const state = createStore<SessionLagState>(empty);
  const samples = new Map<string, number[]>();
  const timed = new Map<string, { said: number; translated: boolean; model: string | null }>();
  const sounds: Record<LegName, { on: boolean; ended: number | null }> = {
    speaker: { on: false, ended: null }, participant: { on: false, ended: null },
  };
  let active = false;
  const reset = () => {
    samples.clear(); timed.clear();
    sounds.speaker = { on: false, ended: null }; sounds.participant = { on: false, ended: null };
    state.setState(empty(), true);
  };
  const sample = (stage: LagStage, model: string, ms: number, planned: LagPlanned = EVERY_STAGE) => {
    if (!active || !Number.isFinite(ms) || ms < 0) return;
    const key = `${stage}:${model}`;
    const list = [...(samples.get(key) ?? []), ms].slice(-BEHIND_OF);
    samples.set(key, list);
    const latest = list.slice(-AVERAGE_OF);
    const averageMS = latest.reduce((a, b) => a + b, 0) / latest.length;
    const previous = state.getState();
    const limit = stage === 'translation' ? 3000 : 2000;
    const behind = list.length === BEHIND_OF && list.filter((one) => one > limit).length >= BEHIND_SLOW && !previous.fallingBehind[stage]
      ? { stage, model, averageMS } : null;
    state.setState({ averages: { ...previous.averages, [key]: averageMS },
      ...(behind ? { fallingBehind: { ...previous.fallingBehind, [stage]: behind }, notice: previous.notice ?? (planned.has(stage) ? behind : null) } : {}) });
  };
  return {
    state,
    begin() { active = true; reset(); },
    end() { active = false; reset(); },
    sample,
    average(stage: LagStage, model: string): number | undefined { return state.getState().averages[`${stage}:${model}`]; },
    sound(leg: LegName, heard: boolean, now: number) {
      if (!active) return;
      const sound = sounds[leg];
      if (sound.on && !heard) sound.ended = now;
      // Sound again before a line came back: which ending that line belongs to is unknown. A game or a crowded room
      // keeps a leg loud, and an old pause would be read as seconds of lag.
      if (!sound.on && heard) sound.ended = null;
      sound.on = heard;
    },
    measure(entries: readonly Entry[], models: LagModels, now: number, planned: LagPlanned = EVERY_STAGE) {
      if (!active) return;
      for (const entry of entries) {
        if (entry.kind !== 'exchange' || entry.lane === 'video') continue;
        // A leg's ids need not be globally unique. Keep timing independent of projection row splits.
        const key = `${entry.leg}:${entry.id}`;
        let timing = timed.get(key);
        if (!timing && entry.source.some((r) => r.text.trim()) && entry.source.every((r) => r.final)) {
          timing = { said: now, translated: false, model: models.translation };
          timed.set(key, timing);
          const end = sounds[entry.leg].ended;
          const model = models[entry.leg];
          if (end !== null && model && now >= end) {
            sample(entry.leg, model, now - end, planned);
            // A later typed line or unrelated sentence must not reuse an old sound ending.
            sounds[entry.leg].ended = null;
          }
        }
        if (timing && !timing.translated && entry.translation.some((r) => r.text.trim()) && entry.translation.every((r) => r.final)) {
          timing.translated = true;
          if (timing.model) sample('translation', timing.model, now - timing.said, planned);
        }
      }
    },
  };
}
export type SessionLags = ReturnType<typeof createSessionLags>;
export const sessionLags = createSessionLags();

/** The app runner feeds measurements for every session, whether any VR surface is open or not. */
export function driveSessionLags(deps: {
  runner: { state: { getState(): RunState; subscribe(listener: () => void): () => void } };
  view: Readable<{ entries: readonly Entry[] }>;
  levels(): Promise<Readonly<Record<LegName, LevelMeter>> | null>;
  models(): LagModels;
  /** Absent: every stage. */
  planned?(): LagPlanned;
  clock: Clock;
  lags?: SessionLags;
}): () => void {
  const lags = deps.lags ?? sessionLags;
  let running = false;
  let cancel: (() => void) | null = null;
  let generation = 0;
  let levels: Readonly<Record<LegName, LevelMeter>> | null = null;
  const ignored = new Set<string>();
  const keyOf = (entry: Entry) => `${entry.leg}:${entry.id}`;
  const measure = () => {
    if (running) lags.measure(deps.view.get().entries.filter((entry) => !ignored.has(keyOf(entry))), deps.models(), deps.clock.now(), deps.planned?.());
  };
  const phase = () => {
    const next = deps.runner.state.getState().phase === 'running';
    if (next === running) return;
    running = next;
    const mine = ++generation;
    cancel?.(); cancel = null; levels = null;
    if (!next) { lags.end(); return; }
    ignored.clear();
    for (const entry of deps.view.get().entries) ignored.add(keyOf(entry));
    lags.begin();
    void deps.levels().then((answer) => { if (running && mine === generation) levels = answer; }, () => {});
    cancel = every(deps.clock, 250, () => {
      if (!levels) return;
      for (const leg of ['speaker', 'participant'] as const) lags.sound(leg, levels[leg].heard(), deps.clock.now());
    });
  };
  const offs = [deps.runner.state.subscribe(phase), deps.view.subscribe(measure)];
  phase();
  return () => { generation++; running = false; cancel?.(); for (const off of offs) off(); lags.end(); };
}
