/**
 * Fork: the speed test the pipeline's settings run when asked (测试速度). A
 * recording of the language each leg hears is played into that leg's real
 * session at the pace it was spoken — no microphone, nothing played aloud —
 * and the session's own events are timed: from the end of the speech to its
 * text, and from each sentence to its translation or feedback. Whatever runs
 * a stage, this computer, another device, a phone or an API, is timed the way
 * a run would meet it, the network included.
 *
 * The legs are timed one after the other, each with a session of its own;
 * the recordings are `public/speed-test/` (`scripts/dev/build-speed-clips.py`).
 */
import { SAMPLE_RATE, type AdapterSession, type Ref, type StartRequest } from '../../lib/contract/adapter';
import type { Clock } from '../../lib/contract/clock';
import { eventsFrom } from '../../lib/contract/events';
import type { AdapterEvent } from '../../lib/contract/events';
import type { LegName } from '../../lib/conversation/types';
import { describeCause } from '../../lib/diagnostics/report';
import { isMissing, readCredentials } from '../../lib/provider/credentials';
import type { ModelOption } from '../../lib/provider/types';
import { contextsFor } from '../../lib/session/shape';
import type { RunShape } from '../../lib/session/types';
import { isAutoLanguage } from './localaiNative';
import { heardBy } from './localaiDevice';
import type { LocalAISettings } from './localai';

/** What one leg's session did with the recording. */
export interface LegTiming {
  leg: LegName;
  /** What answers what it hears: a translation, or — a coached speaker — feedback. */
  answeredBy: 'translate' | 'coach';
  /** How long the recording's speech is, in milliseconds. */
  speechMs: number;
  /** From the end of the speech to the last of its text written: null where none was. */
  hearMs: number | null;
  /** For each answer, from its sentence written to it written. */
  answerMs: number[];
  /** How many sentences with text were written. */
  sentences: number;
  /** From the end of the speech to the last answer written: null where not every sentence was answered in time. */
  totalMs: number | null;
}

export interface SpeedTestDeps {
  clock: Clock;
  signal: AbortSignal;
  /** A language's recording at the adapters' rate, and where its speech ends; null: there is none for it. */
  clip(language: string): Promise<{ pcm: Int16Array; speechEndMs: number } | null>;
  /** A leg is about to be timed: its place among them, for the progress shown. */
  onLeg?(leg: LegName, index: number, count: number): void;
}

/** Thrown with a sentence to show: a language no recording is for, a refused build, a session that failed. */
export class SpeedTestError extends Error {
  constructor(message: string, readonly code: 'no_clip' | 'refused' | 'failed') {
    super(message);
  }
}

/** The recording is sent in pieces of this length, each when its time comes. */
const CHUNK_MS = 50;
/** After the speech, how long the session is given to write it all, at least: then whatever it had not is late. */
const GIVE_AT_LEAST_MS = 30_000;
/** Nothing new for this long once everything is written: the leg is done. */
const QUIET_MS = 800;

/** The language a leg hears in this pipeline: a detected one is timed with the language the other side most likely speaks. */
export function clipLanguage(s: LocalAISettings, pair: { source: string; target: string }, leg: LegName, models: readonly ModelOption[]): string {
  const heard = heardBy(s, pair, leg, models);
  return isAutoLanguage(heard) ? (leg === 'speaker' ? pair.source : pair.target) : heard;
}

/**
 * Times every leg of the shape, one after the other. Rejects with a `SpeedTestError` (or the abort); a leg whose
 * session never wrote its text still returns, with nulls where nothing came.
 */
export async function runSpeedTest(shape: RunShape, models: readonly ModelOption[], deps: SpeedTestDeps): Promise<LegTiming[]> {
  // The test's own signal, aborted as it ends, whatever the end, as a run's is: `prepare` holds the native engines
  // until it is (`prepareLocalAI`), and a test that finished must let them go as a run that stopped does.
  const own = new AbortController();
  const forward = () => own.abort(deps.signal.reason);
  if (deps.signal.aborted) forward();
  else deps.signal.addEventListener('abort', forward, { once: true });
  try {
    return await timeLegs(shape, models, { ...deps, signal: own.signal });
  } finally {
    deps.signal.removeEventListener('abort', forward);
    own.abort(new Error('the speed test ended'));
  }
}

async function timeLegs(shape: RunShape, models: readonly ModelOption[], deps: SpeedTestDeps): Promise<LegTiming[]> {
  const p = shape.provider;
  const credentials = readCredentials(p, shape.settings, shape.credentials, shape.auth);
  if (isMissing(credentials)) throw new SpeedTestError(credentials.missing, 'refused');
  const shared = { ...shape.shared, models };
  let settings = shape.settings;
  if (p.session?.prepare) {
    const prepared = await p.session.prepare(shape, settings, deps.signal);
    if (prepared.override) settings = { ...(settings as object), ...prepared.override };
  }
  deps.signal.throwIfAborted();
  const contexts = contextsFor(shape);
  const timings: LegTiming[] = [];
  for (const [index, leg] of shape.legs.entries()) {
    const context = contexts[leg]!;
    const built = p.build(context, settings, shared);
    if (typeof (built as { refused?: unknown })?.refused === 'string') throw new SpeedTestError((built as { refused: string }).refused, 'refused');
    const local = settings as LocalAISettings;
    const language = clipLanguage(local, shape.pair, leg, models);
    const clip = await deps.clip(language);
    if (!clip) throw new SpeedTestError(`No recording for ${language}`, 'no_clip');
    deps.signal.throwIfAborted();
    deps.onLeg?.(leg, index, shape.legs.length);
    const answeredBy = leg === 'speaker' && local.coach ? 'coach' : 'translate';
    const request: StartRequest<unknown, unknown> = { context, config: built, credentials, clock: deps.clock, signal: deps.signal };
    timings.push(await timeLeg(leg, answeredBy, (events) => p.start(request, events), clip, deps));
  }
  return timings;
}

/** One leg: its session started, the recording sent at its own pace and then silence, until all it heard is answered. */
export async function timeLeg(
  leg: LegName,
  answeredBy: LegTiming['answeredBy'],
  start: (events: ReturnType<typeof eventsFrom>) => Promise<AdapterSession>,
  clip: { pcm: Int16Array; speechEndMs: number },
  { clock, signal }: Pick<SpeedTestDeps, 'clock' | 'signal'>,
): Promise<LegTiming> {
  // Each segment as the session wrote it: which side, its sentence's origin, its text, and when it closed.
  const segments = new Map<Ref, { side: 'source' | 'translation'; origin?: string; text: string; openedAt: number; closedAt?: number }>();
  // When the session last wrote anything, and why it ended, where it did.
  const state: { lastEventAt: number; failure: string | null } = { lastEventAt: 0, failure: null };
  const onEvent = (event: AdapterEvent) => {
    const now = clock.now();
    switch (event.kind) {
      case 'segmentOpened':
        segments.set(event.payload.ref, { side: event.payload.side, ...(event.payload.origin !== undefined ? { origin: event.payload.origin } : {}), text: '', openedAt: now });
        break;
      case 'segmentText': {
        const segment = segments.get(event.payload.ref);
        if (segment) segment.text = event.payload.text;
        break;
      }
      case 'segmentClosed': {
        const segment = segments.get(event.payload.ref);
        if (segment) {
          segment.closedAt = now;
          if (event.payload.origin !== undefined && segment.origin === undefined) segment.origin = event.payload.origin;
        }
        break;
      }
      case 'failed':
        state.failure = event.payload.message;
        break;
      case 'closed':
        state.failure ??= event.payload.reason;
        break;
      default:
        return;
    }
    state.lastEventAt = now;
  };

  let session: AdapterSession;
  try {
    session = await start(eventsFrom(onEvent));
  } catch (error) {
    if (signal.aborted) throw error;
    throw new SpeedTestError(describeCause(error), 'failed');
  }
  try {
    const chunk = Math.round(SAMPLE_RATE * CHUNK_MS / 1000);
    const startedAt = clock.now();
    const speechEndAt = startedAt + clip.speechEndMs;
    const giveUpAt = speechEndAt + Math.max(GIVE_AT_LEAST_MS, clip.speechEndMs * 3);
    const silence = new Int16Array(chunk);
    const done = () => {
      const now = clock.now();
      if (now < speechEndAt) return false;
      const written = [...segments.values()];
      if (written.some((s) => s.closedAt === undefined)) return false;
      const timing = measure(leg, answeredBy, written, speechEndAt, clip.speechEndMs);
      return timing.sentences > 0 && timing.totalMs !== null && now - state.lastEventAt >= QUIET_MS;
    };
    // Each piece once its time has passed, the recording's and then silence's, as a microphone delivers them.
    for (let sent = 0; ; sent += chunk) {
      const due = startedAt + ((sent + chunk) * 1000) / SAMPLE_RATE;
      await new Promise<void>((resolve) => {
        const onAbort = () => { cancel(); resolve(); };
        const cancel = clock.setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, Math.max(0, due - clock.now()));
        signal.addEventListener('abort', onAbort, { once: true });
      });
      signal.throwIfAborted();
      if (state.failure !== null) throw new SpeedTestError(state.failure, 'failed');
      if (done() || clock.now() >= giveUpAt) break;
      session.appendAudio(sent < clip.pcm.length ? clip.pcm.subarray(sent, Math.min(sent + chunk, clip.pcm.length)) : silence);
    }
    return measure(leg, answeredBy, [...segments.values()], speechEndAt, clip.speechEndMs);
  } finally {
    await session.stop().catch(() => { /* The leg is timed; a stop that fails changes nothing of it. */ });
  }
}

/** The leg's numbers, from what its session wrote and when. */
export function measure(
  leg: LegName,
  answeredBy: LegTiming['answeredBy'],
  segments: ReadonlyArray<{ side: 'source' | 'translation'; origin?: string; text: string; openedAt: number; closedAt?: number }>,
  speechEndAt: number,
  speechMs: number,
): LegTiming {
  // The recording's own sentences: those begun before the recognizer, once the speech had ended, first had all it
  // began written. One begun after that is it hearing words in the silence that follows (Qwen3-ASR writes a "はい。"
  // there), and no part of what is timed. A recognizer that writes a sentence only once it is whole (an API, the
  // app's own models) begins it after the speech ended: it is still the recording's, as the first it writes.
  const sources = segments.filter((s) => s.side === 'source');
  const settledAt = sources
    .filter((s) => s.closedAt !== undefined && s.closedAt >= speechEndAt && s.text.trim() !== '')
    .map((s) => s.closedAt!)
    .sort((a, b) => a - b)
    .find((t) => sources.every((s) => s.openedAt > t || (s.closedAt !== undefined && s.closedAt <= t)));
  const heard = sources.filter((s) => s.closedAt !== undefined && s.text.trim() !== '' && s.openedAt <= (settledAt ?? speechEndAt));
  const origins = new Set(heard.flatMap((s) => (s.origin !== undefined ? [s.origin] : [])));
  const answers = segments
    .filter((s) => s.side === 'translation' && s.closedAt !== undefined && (s.origin === undefined || origins.has(s.origin)))
    .sort((a, b) => a.openedAt - b.openedAt)
    .slice(0, heard.length);
  const lastHeard = heard.length ? Math.max(...heard.map((s) => s.closedAt!)) : null;
  const answerMs = answers.map((answer) => {
    // Its own sentence, by origin; else the last sentence written before it opened.
    const own = answer.origin !== undefined ? heard.find((s) => s.origin === answer.origin) : undefined;
    const before = own ?? [...heard].reverse().find((s) => s.closedAt! <= answer.openedAt) ?? heard[0];
    return before ? Math.max(0, answer.closedAt! - before.closedAt!) : 0;
  });
  const answeredAll = heard.length > 0 && answers.length >= heard.length;
  return {
    leg,
    answeredBy,
    speechMs,
    hearMs: lastHeard === null ? null : Math.max(0, lastHeard - speechEndAt),
    answerMs,
    sentences: heard.length,
    totalMs: answeredAll ? Math.max(0, Math.max(...answers.map((s) => s.closedAt!)) - speechEndAt) : null,
  };
}
