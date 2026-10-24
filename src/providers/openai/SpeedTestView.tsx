import { useCallback, useEffect, useRef, useState } from 'react';
import { Gauge, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SAMPLE_RATE } from '../../lib/contract/adapter';
import { realClock } from '../../lib/contract/clock';
import type { CredentialValues, LanguagePair, ModelOption } from '../../lib/provider/types';
import type { LegName } from '../../lib/conversation/types';
// Type only: `localai.ts` imports this view's host, and a value import back would close a cycle.
import type { LocalAISettings as S } from './localai';
import { clipFor, loadReport, reportStands, saveReport, stageResult, stageSig, summarize, type SpeedReport, type SpeedStage, type StageSpeed } from './speedResults';

/**
 * Fork: the speed test, as the stage cards show it (`speedTest.ts` runs it).
 * Nothing of it shows before it is asked for but the button beside the
 * readiness check; a stage's result then shows in its card, and a suggestion
 * only where the stage falls behind.
 */

/** A recording, decoded to the adapters' rate. */
async function loadClip(language: string): Promise<{ pcm: Int16Array; speechEndMs: number } | null> {
  const clip = clipFor(language);
  if (!clip) return null;
  const response = await fetch(new URL(`speed-test/${clip.file}`, document.baseURI).href);
  if (!response.ok) throw new Error(`The recording did not load: HTTP ${response.status}`);
  const buffer = await new OfflineAudioContext(1, 1, SAMPLE_RATE).decodeAudioData(await response.arrayBuffer());
  const samples = buffer.getChannelData(0);
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767)));
  return { pcm, speechEndMs: clip.speechEndMs };
}

/** Rough length of a test, for its progress: each leg's recording, and a few seconds for the answers. */
const LEG_EXTRA_MS = 6000;

type Phase = { name: 'idle' } | { name: 'running'; startedAt: number; expectMs: number } | { name: 'failed'; message: string };

export interface SpeedTestState {
  phase: Phase;
  /** The report, while every stage it timed and every stage that would run now is set as it was. */
  report: SpeedReport | null;
  /** A stage's result, while it is set as it was. */
  result(stage: SpeedStage): StageSpeed | null;
  start(): void;
  stop(): void;
  /** Runs it again once the settings a change asked for have arrived: a suggestion's switch. */
  againAfterChange(): void;
}

export function useSpeedTest({ settings, values, pair, legs, models, ready, disabled }: {
  settings: S; values: CredentialValues; pair: LanguagePair; legs: readonly LegName[]; models: readonly ModelOption[]; ready: boolean; disabled: boolean;
}): SpeedTestState {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>({ name: 'idle' });
  const [kept, setKept] = useState<SpeedReport | null>(() => loadReport());
  const running = useRef<AbortController | null>(null);
  const latest = useRef({ settings, values, pair, legs, models });
  latest.current = { settings, values, pair, legs, models };
  const endpoint = values.endpoint ?? '';
  const sigNow = useCallback((stage: SpeedStage) => stageSig(stage, settings, endpoint, pair, legs), [settings, endpoint, pair, legs]);

  const start = useCallback(() => {
    if (running.current) return;
    const controller = new AbortController();
    running.current = controller;
    const now = latest.current;
    const expectMs = now.legs.reduce((sum, leg) => sum + (clipFor(leg === 'speaker' ? (now.settings.coach ? now.pair.target : now.pair.source) : now.pair.target)?.ms ?? 10_000) + LEG_EXTRA_MS, 0);
    setPhase({ name: 'running', startedAt: Date.now(), expectMs });
    void (async () => {
      try {
        // Loaded when asked: the run's shape and the provider sit above this view, and a value import would close a cycle.
        const [{ runSpeedTest }, { readShapeFromStores }] = await Promise.all([import('./speedTest'), import('../../lib/session/appShape')]);
        const base = readShapeFromStores({ signedIn: false, getToken: async () => null });
        if (!base || base.provider.id !== 'localai') throw new Error('The pipeline is not the provider in use');
        // As the cards show it now, and with automatic turns: a held key would hold the recording back.
        const shape = { ...base, settings: now.settings, credentials: now.values, pair: now.pair, legs: now.legs, turnMode: 'auto' as const };
        const timings = await runSpeedTest(shape, now.models, { clock: realClock, signal: controller.signal, clip: loadClip });
        const sig = (stage: SpeedStage) => stageSig(stage, now.settings, now.values.endpoint ?? '', now.pair, now.legs);
        const report = summarize(timings, sig, Date.now());
        saveReport(report);
        setKept(report);
        setPhase({ name: 'idle' });
      } catch (error) {
        if (controller.signal.aborted) setPhase({ name: 'idle' });
        else setPhase({ name: 'failed', message: (error as { code?: string }).code === 'no_clip' ? t('providers.localai.speedNoClip') : t('providers.localai.speedFailed', { reason: error instanceof Error ? error.message : String(error) }) });
      } finally {
        if (running.current === controller) running.current = null;
      }
    })();
  }, [t]);

  const stop = useCallback(() => running.current?.abort(new Error('stopped')), []);
  // A run starting takes the models the test was using: the test gives way.
  useEffect(() => { if (disabled) running.current?.abort(new Error('a run started')); }, [disabled]);
  useEffect(() => () => running.current?.abort(new Error('the settings closed')), []);

  // A suggestion's switch: the test runs again once the change it made has arrived here.
  const [again, setAgain] = useState(false);
  const againAfterChange = useCallback(() => setAgain(true), []);
  useEffect(() => {
    if (!again) return;
    setAgain(false);
    if (ready && !disabled) start();
  }, [settings]); // eslint-disable-line react-hooks/exhaustive-deps

  // The stages a run would time now: hearing, and what answers each leg.
  const wanted: SpeedStage[] = ['hear', ...legs.map((leg): SpeedStage => (leg === 'speaker' && settings.coach ? 'coach' : 'translate'))];
  const report = reportStands(kept, sigNow) && wanted.every((stage) => kept.stages[stage] !== undefined) ? kept : null;
  return { phase, report, result: (stage) => stageResult(kept, stage, sigNow(stage)), start, stop, againAfterChange };
}

const seconds = (ms: number) => (ms / 1000).toFixed(1);

/** When a test ran, in the interface's language: its catalogs are named `zh_CN`, which `Intl` refuses as a tag. */
export function dateOf(at: number, language: string): string {
  const options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
  try {
    return new Date(at).toLocaleString(language.replace(/_/g, '-'), options);
  } catch {
    return new Date(at).toLocaleString(undefined, options);
  }
}

/** A stage's result in its card: its time, and — where it falls behind — why that matters and what would help. */
export function SpeedLine({ stage, result, advice, disabled }: { stage: SpeedStage; result: StageSpeed | null; advice?: { name: string; onSwitch(): void } | null; disabled?: boolean }) {
  const { t } = useTranslation();
  if (!result) return null;
  const words = { hear: 'speedHear', translate: 'speedTranslate', coach: 'speedCoach' } as const;
  const slowWords = { hear: 'speedHearSlow', translate: 'speedTranslateSlow', coach: 'speedCoachSlow' } as const;
  return (
    <div className={`kt-speed${result.slow ? ' is-slow' : ''}`}>
      <p className="kt-speed__result">{result.ms === null ? t('providers.localai.speedNone') : t(`providers.localai.${words[stage]}`, { seconds: seconds(result.ms) })}</p>
      {result.slow && (
        <div className="kt-speed__advice" role="status">
          <span>{t(`providers.localai.${slowWords[stage]}`)}{advice ? t('providers.localai.speedAdviceModel', { name: advice.name }) : t('providers.localai.speedAdviceGeneral')}</span>
          {advice && <button type="button" className="kt-speed__switch" onClick={advice.onSwitch} disabled={disabled}>{t('providers.localai.speedAdviceSwitch')}</button>}
        </div>
      )}
    </div>
  );
}

/** The button beside the readiness check: shown until a result stands, and while a test runs, the way to stop it. */
export function SpeedButton({ state, ready, disabled }: { state: SpeedTestState; ready: boolean; disabled?: boolean }) {
  const { t } = useTranslation();
  if (state.phase.name === 'running') {
    return <button type="button" className="kt-ready__again" onClick={state.stop}><span>{t('providers.localai.speedStop')}</span></button>;
  }
  if (state.report || !ready) return null;
  return (
    <button type="button" className="kt-ready__again" onClick={state.start} disabled={disabled}>
      <Gauge size={12} />
      <span>{t('providers.localai.speedTest')}</span>
    </button>
  );
}

/** Under the readiness check: a test's progress, why it could not finish, or what it found. */
export function SpeedReportView({ state, ready, disabled }: { state: SpeedTestState; ready: boolean; disabled?: boolean }) {
  const { t, i18n } = useTranslation();
  const { phase, report } = state;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (phase.name !== 'running') return undefined;
    const id = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(id);
  }, [phase.name]);

  if (phase.name === 'running') {
    const share = Math.min(0.95, (now - phase.startedAt) / phase.expectMs);
    return (
      <div className="kt-speed-report" role="status">
        <div className="kt-speed-report__bar"><i style={{ width: `${Math.round(share * 100)}%` }} /></div>
        <p className="kt-note">{t('providers.localai.speedTesting')}</p>
      </div>
    );
  }
  if (phase.name === 'failed') return <p className="kt-note kt-note--todo" role="status">{phase.message}</p>;
  if (!report) return null;

  const when = Date.now() - report.at < 60_000 ? t('providers.localai.speedJustNow') : dateOf(report.at, i18n.language);
  const slow = Object.values(report.stages).some((stage) => stage?.slow);
  const rowWords = (leg: (typeof report.legs)[number]) => (leg.answeredBy === 'coach' ? 'speedLegCoach' : leg.leg === 'speaker' ? 'speedLegSpeaker' : 'speedLegParticipant');
  return (
    <div className="kt-speed-report">
      <div className="kt-speed-report__head">
        <span>{t('providers.localai.speedHead', { when })}</span>
        <button type="button" className="kt-speed-report__again" onClick={state.start} disabled={disabled || !ready}>
          <RefreshCw size={11} />
          <span>{t('providers.localai.speedRetest')}</span>
        </button>
      </div>
      {report.legs.map((leg) => (
        <div className="kt-speed-report__row" key={leg.leg}>
          <span>{t(`providers.localai.${rowWords(leg)}`)}</span>
          <span>{leg.ms === null || report.stages.hear?.slow ? t('providers.localai.speedBehind') : t('providers.localai.speedAbout', { seconds: seconds(leg.ms) })}</span>
        </div>
      ))}
      <p className="kt-note">{slow ? t('providers.localai.speedVerdictSlow') : t('providers.localai.speedVerdictOk')}</p>
    </div>
  );
}
