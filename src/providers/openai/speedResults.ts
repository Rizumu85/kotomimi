/**
 * Fork: what the speed test found (`speedTest.ts`), kept for the stages as
 * they were set when it ran. Each stage's result stands while what decides
 * its speed is unchanged — where it runs, on which device, with which model,
 * for which languages — and goes the moment one of those changes, the other
 * stages' staying. Kept in this browser's storage: it is a convenience, and
 * a test is always one press away.
 */
import { SPEED_CLIPS } from './speedClips.generated';
import type { LocalAISettings } from './localai';
import type { LegTiming } from './speedTest';

export type SpeedStage = 'hear' | 'translate' | 'coach';

/** One stage's result: its time in milliseconds (null: nothing came in time), and whether it falls behind speech. */
export interface StageSpeed { ms: number | null; slow: boolean }

/** One leg's whole way, from the end of speech to the last answer: null where it was not reached in time. */
export interface LegSpeed { leg: 'speaker' | 'participant'; answeredBy: 'translate' | 'coach'; ms: number | null }

export interface SpeedReport {
  at: number;
  stages: Partial<Record<SpeedStage, StageSpeed & { sig: string }>>;
  legs: LegSpeed[];
}

const STORAGE_KEY = 'kotomimi.speedTest';

/** What decides each stage's speed. A field that only words what is asked (the instructions, a prompt) is none of it. */
const STAGE_FIELDS: Record<SpeedStage, readonly (keyof LocalAISettings)[]> = {
  hear: ['asrVia', 'asrModel', 'model', 'asrApiBaseUrl', 'asrApiModel', 'asrOther', 'asrOtherModel', 'asrDetectOther', 'asrHere', 'asrHereModel', 'asrNativeModel', 'asrNativeByLanguage', 'hereAddress', 'vadMinSilenceDuration'],
  translate: ['translateAt', 'translateServerModel', 'translateOther', 'translateOtherModel', 'translateBaseUrl', 'translateModel', 'translateHere', 'translateHereModel', 'translateNativeModel', 'translateBySentence', 'hereAddress'],
  coach: ['coach', 'coachAt', 'coachServerModel', 'coachOther', 'coachOtherModel', 'coachBaseUrl', 'coachModel', 'coachDeviceModel', 'coachHere', 'coachHereModel', 'coachNativeModel', 'hereAddress'],
};

/** A stage as it is set now: its fields, the device the stages share, the languages, and the legs that run. */
export function stageSig(stage: SpeedStage, s: LocalAISettings, endpoint: string, pair: { source: string; target: string }, legs: readonly string[]): string {
  return JSON.stringify([stage, STAGE_FIELDS[stage].map((field) => s[field]), endpoint.trim(), pair.source, pair.target, [...legs]]);
}

/** The base language a recording is kept under: a region or a script is the same speech for a timing. */
export function clipFor(language: string): { file: string; ms: number; speechEndMs: number } | null {
  const base = language.toLowerCase().split(/[-_]/)[0];
  const alias: Record<string, string> = { nb: 'no', nn: 'no', tl: 'fil', iw: 'he', cmn: 'zh' };
  return SPEED_CLIPS[alias[base] ?? base] ?? null;
}

/** A speech recognizer falls behind when its text comes later after the speech than the speech itself lasted, plus a pause. */
const HEAR_SLACK_MS = 1500;

/** The stages' results from the legs' timings, each stage as its slowest leg found it. */
export function summarize(timings: readonly LegTiming[], sig: (stage: SpeedStage) => string, at: number): SpeedReport {
  const stages: SpeedReport['stages'] = {};
  const worst = (a: StageSpeed | undefined, b: StageSpeed): StageSpeed => (!a ? b : {
    ms: a.ms === null || b.ms === null ? null : Math.max(a.ms, b.ms),
    slow: a.slow || b.slow,
  });
  for (const t of timings) {
    stages.hear = { ...worst(stages.hear, { ms: t.hearMs, slow: t.hearMs === null || t.hearMs > t.speechMs + HEAR_SLACK_MS }), sig: sig('hear') };
    const average = t.answerMs.length ? t.answerMs.reduce((a, b) => a + b, 0) / t.answerMs.length : null;
    // An answer falls behind when it takes longer than its sentence took to say: the next is waiting by then.
    const perSentence = t.speechMs / Math.max(1, t.sentences);
    const answer: StageSpeed = { ms: average === null ? null : Math.round(average), slow: average === null || average > perSentence };
    stages[t.answeredBy] = { ...worst(stages[t.answeredBy], answer), sig: sig(t.answeredBy) };
  }
  return { at, stages, legs: timings.map((t) => ({ leg: t.leg, answeredBy: t.answeredBy, ms: t.totalMs })) };
}

/** The last report, where storage has one. */
export function loadReport(): SpeedReport | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as SpeedReport) : null;
  } catch {
    return null;
  }
}

export function saveReport(report: SpeedReport): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(report));
  } catch {
    /* Storage refused (a private window): the result is still shown until the settings close. */
  }
}

/** A stage's result, while the stage is set as it was when it ran. */
export function stageResult(report: SpeedReport | null, stage: SpeedStage, sigNow: string): StageSpeed | null {
  const kept = report?.stages[stage];
  return kept && kept.sig === sigNow ? { ms: kept.ms, slow: kept.slow } : null;
}

/** The whole report, while every stage it timed is set as it was. */
export function reportStands(report: SpeedReport | null, sigNow: (stage: SpeedStage) => string): report is SpeedReport {
  if (!report) return false;
  const timed = Object.entries(report.stages) as [SpeedStage, { sig: string }][];
  return timed.length > 0 && timed.every(([stage, kept]) => kept.sig === sigNow(stage));
}
