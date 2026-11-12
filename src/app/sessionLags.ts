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
  /** The first threshold crossing only, stable until the session ends. */
  notice: FallingBehind | null;
}

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
  const sample = (stage: LagStage, model: string, ms: number) => {
    if (!active || !Number.isFinite(ms) || ms < 0) return;
    const key = `${stage}:${model}`;
    const list = [...(samples.get(key) ?? []), ms].slice(-5);
    samples.set(key, list);
    const averageMS = list.reduce((a, b) => a + b, 0) / list.length;
    const previous = state.getState();
    const behind = list.length === 5 && averageMS > (stage === 'translation' ? 3000 : 2000) && !previous.fallingBehind[stage]
      ? { stage, model, averageMS } : null;
    state.setState({ averages: { ...previous.averages, [key]: averageMS },
      ...(behind ? { fallingBehind: { ...previous.fallingBehind, [stage]: behind }, notice: previous.notice ?? behind } : {}) });
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
      sound.on = heard;
    },
    measure(entries: readonly Entry[], models: LagModels, now: number) {
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
            sample(entry.leg, model, now - end);
            // A later typed line or unrelated sentence must not reuse an old sound ending.
            sounds[entry.leg].ended = null;
          }
        }
        if (timing && !timing.translated && entry.translation.some((r) => r.text.trim()) && entry.translation.every((r) => r.final)) {
          timing.translated = true;
          if (timing.model) sample('translation', timing.model, now - timing.said);
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
    if (running) lags.measure(deps.view.get().entries.filter((entry) => !ignored.has(keyOf(entry))), deps.models(), deps.clock.now());
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
