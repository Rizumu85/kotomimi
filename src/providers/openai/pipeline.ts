/**
 * Fork: a leg whose stages run where the user chose. Something hears: the
 * Realtime adapter, as it is, in a transcription session — the server
 * detects turns and writes the source text, and makes no answer — or this
 * computer's own recognizer, the Local Inference adapter run without a
 * translation of its own. Each finished source is then handed to what
 * answers: a text model over chat completions (`textModel.ts`), or a
 * translation model this computer runs itself. The answer is this leg's
 * translation segment, paired with the source by the same origin.
 *
 * What a stage answers with is its own business: a translation, or — for a
 * speaker practising the other side's language — feedback on what they just
 * said. Typed text takes the same road, through the `typed` stage.
 *
 * A leg heard by the server with no stage of its own is the Realtime
 * adapter untouched: the server's pipeline answers, as before.
 *
 * The wrapper adds nothing to the inner session's events but a language on
 * source text, when the speaker is heard in a language that is not the
 * leg's source; it forwards the rest as they come. Its own segments take
 * refs from `FIRST_REF` up, far from the inner adapter's counter.
 */
import type { Adapter, AdapterEvents, AdapterSession, Ref, StartRequest } from '../../lib/contract/adapter';
import { eventsFrom, type AdapterEvent } from '../../lib/contract/events';
import { framePayload } from '../../lib/contract/framePayload';
import { describeCause } from '../../lib/diagnostics/describeCause';
import { createLocalInferenceAdapter } from '../localInference/adapter';
import type { LocalInferenceConfig } from '../localInference/config';
import { defaultEngines, type LocalEngines, type TranslationLike } from '../localInference/engines';
import { createApiAsr } from './apiAsr';
import { createNativeAsr, type NativeLimits } from './nativeAsr';
import { languageByScript, saidInOwn, sameSpeech } from '../../lib/language/script';
import { AUTO } from '../../lib/provider/languages';
import { TEXT_SLOT } from './nativeTranslators';
import { cutAt, letters, restFrom, SETTLE_MS } from './sentenceCut';
import { askNativeEngine, ipcNativeBridge, type NativeBridge, type NativeEngineStatus } from '../../lib/native/nativeEngine';
import { createRealtimeAdapter } from './adapter';
import type { RealtimeConfig } from './config';
import type { RealtimeCredentials } from './settings';
import type { OpenSocket } from './socket';
import { chatUrl, completeText, httpBaseOf } from './textModel';
import { unwrapTranslationText } from './wire';

/** The credential a stage's endpoint is called with, by its field. */
export type StageKey = 'translateKey' | 'coachKey' | 'apiKey' | 'asrKey';

/** A stage answered over chat completions, by a text model anywhere. */
export interface TextStage {
  via?: 'chat';
  kind: 'translate' | 'coach';
  /** An OpenAI-style base URL (`http://host:11434/v1`); blank: the Realtime server's own. */
  baseUrl: string;
  /**
   * Present: one of this computer's native engines answers the stage, and is asked where it is before each request —
   * it takes a new port every time it starts, so an address read once is wrong after any restart, and a session
   * would translate nothing from then on. Asking also brings it back up when it is not. `baseUrl` is what it was
   * when the session was built, and what is used where it cannot be asked.
   */
  engine?: 'translator' | 'coach';
  model: string;
  /** Absent: the endpoint takes no key. */
  key?: StageKey;
  system: string;
  /** Worked examples sent before each source, as earlier turns (`coachPrompt.ts`). */
  shots?: ReadonlyArray<{ said: string; answer: string }>;
  /** The language its answers are written in, when that is not the leg's target. */
  language?: string;
  /** The pair, for a server that runs a translation model rather than a chat model and must be told (another Kotomimi, `src/lib/lan`). Absent: not sent. */
  pair?: { source: string; target: string };
  /**
   * Present: the model is asked in a form of its own (`nativeTranslators.ts`) — one user message, these words with
   * the sentence where `TEXT_SLOT` stands, no system message — and `extra` goes with the request.
   */
  wrap?: string;
  extra?: Readonly<Record<string, unknown>>;
}

/** A stage this computer runs itself (`localaiDevice.ts`): a translation, or — by one of the catalog's chat models — feedback. */
export interface DeviceStage {
  via: 'device';
  kind: 'translate' | 'coach';
  /** The model's id in the app's own catalog. */
  model: string;
  /** The instructions: the model's own translation prompt for this direction, or the feedback's; and whether the source goes up wrapped in the tags a translation prompt names. */
  system: string;
  wrapTranscript: boolean;
  language?: string;
}

export type AnswerStage = TextStage | DeviceStage;

export interface Stages {
  /** What answers a finished source. Null: the server's own pipeline does, inside the Realtime session. */
  speech: AnswerStage | null;
  /** What answers typed text. Null: the Realtime session does. */
  typed: AnswerStage | null;
  /**
   * The language heard, when it is not the leg's source: a speaker practising
   * the target language — or `auto`, the other side's language left to be
   * detected: the recognizer is told none, each sentence is given the
   * language its writing shows (`languageByScript`), and one already in the
   * leg's target language is not translated.
   */
  heard?: string;
}

/** This computer hears: its own recognizer and turn detection, and no socket. */
export interface DeviceHearing {
  modelId: string;
  streaming: boolean;
  vad: LocalInferenceConfig['vad'];
  /** Present: the recognizer is an API (`apiAsr.ts`) — this computer still cuts the sentences, and uploads each one. */
  api?: { baseUrl: string; model: string; key?: StageKey };
  /** Present: the recognizer is the native engine's (`nativeAsr.ts`), given the voice as it comes; `limits` where one recognition may not run as long as the default. */
  native?: { model: string; limits?: Partial<NativeLimits> };
}

export interface PipelineConfig extends RealtimeConfig {
  /** Absent: the Realtime adapter alone. */
  stages?: Stages;
  /** Present: nothing of the Realtime session is opened; `stages.speech` answers what it hears. */
  device?: DeviceHearing;
  /**
   * Present: the Realtime socket is this one, with no key — the LocalAI of this computer — whatever the credentials'
   * endpoint is. The stages keep the credentials' own: a text model on the other device is still asked there.
   */
  socket?: { endpoint: string };
  /** Present: before the socket opens, that server's pipeline is told its recognizer (`PipelineDeps.prepare`). */
  prepare?: { pipeline: string; transcription: string };
}

export interface PipelineCredentials extends RealtimeCredentials {
  /** Blank when no stage runs on the Realtime server. */
  endpoint: string;
  translateKey?: string;
  coachKey?: string;
  asrKey?: string;
}

export interface PipelineDeps {
  openSocket: OpenSocket;
  fetch: typeof fetch;
  /** This computer's own engines: the app's by default, fakes in tests. */
  engines: LocalEngines;
  /**
   * Names the recognizer in a pipeline of this computer's LocalAI (`PipelineConfig.prepare`). A LocalAI takes no
   * recognizer but its pipeline's own in a session that only transcribes, and a session keeps the one the pipeline
   * named when it was configured (measured 2026-10-04): so it is named first. Absent: nothing is done.
   */
  prepare(pipeline: string, transcription: string): Promise<unknown>;
  /** The native engine, when a leg hears by it: the main process's by default, stand-ins in tests. */
  native: { bridge: NativeBridge; start(model: string): Promise<NativeEngineStatus>; /** Where a native text engine answers now, up with this model, and the key its present run asks for. Rejects when it is not up and cannot be brought up. */ base?(engine: 'translator' | 'coach', model: string): Promise<EngineAddress> };
}

/** A native text engine's chat base URL, and the key of its run where it asks for one: both are new each time it starts. */
export interface EngineAddress { base: string; key?: string }

/** The native text engine's address, asked of the main process: it is started when it is not up, and answers at once when it is. */
async function engineBaseNow(engine: 'translator' | 'coach', model: string): Promise<EngineAddress> {
  const status = await askNativeEngine('start', model, engine === 'translator' ? 'native-translator' : 'native-coach');
  if (status.run.state !== 'ready' || status.run.model !== model || !status.run.port) throw new Error('The engine of this computer is not up.');
  return { base: `http://127.0.0.1:${status.run.port}/v1`, ...(status.run.key ? { key: status.run.key } : {}) };
}

/** The wrapper's own refs start here: the inner adapter counts from 1 and never reaches it. */
export const FIRST_REF = 1_000_000;

interface Job {
  stage: AnswerStage;
  text: string;
  origin: string | undefined;
  /** Typed text must be answered, or said to be unanswerable (the contract's `text-input-answered`). */
  typed: boolean;
}

/** A stage's answer as it is shown: a translation unwrapped as the Realtime adapter unwraps one; feedback as a bare ✓ when that is all it says, else its lines. */
export function tidyAnswer(kind: AnswerStage['kind'], text: string): string {
  if (kind === 'translate') return unwrapTranslationText(text);
  // Small models number or bullet the two lines whatever they are told: the mark is not part of the sentence.
  const lines = text.split('\n').map((line) => line.trim().replace(/^(?:[12][.)、:：]|[-•*])\s*/, '')).filter(Boolean);
  if (lines.length === 0) return '';
  if (/^[✓✔☑]/.test(lines[0]) || /^(ok|correct)[.!]?$/i.test(lines[0])) return '✓';
  return lines.join('\n');
}

/** The device stages of a leg, one per model: speech and typed text usually share theirs. */
function deviceStages(stages: Stages): DeviceStage[] {
  const out: DeviceStage[] = [];
  for (const stage of [stages.speech, stages.typed]) {
    if (stage?.via === 'device' && !out.some((s) => s.model === stage.model)) out.push(stage);
  }
  return out;
}

/**
 * What the legs of the runs now open have lately heard, each stretch with
 * when it began and ended. A coached speaker's leg asks it whether a sentence
 * is its own: with loudspeakers near the microphone the other side's voice
 * comes back through it, and — the leg being told the other side's language —
 * is written as clearly as if the user had said it, and would be sent for
 * feedback. Such a sentence began while the other leg was hearing one, and
 * reads as that one does.
 */
interface Heard { leg: object; ref: Ref; text: string; from: number; until: number | null }
const heardLately: Heard[] = [];
/** A stretch ended this long ago is forgotten. */
const HEARD_KEPT_MS = 30_000;
/** Two recognizers do not hear one voice begin at the same instant. */
const HEARD_SLACK_MS = 1000;
/** A stretch is closed by the pause after it: a sentence begun in the last of that pause is an answer, not the same voice. */
const HEARD_TRAIL_MS = 800;
/**
 * The other leg's writing of a stretch can come a second or two after the
 * microphone's (a recognizer that reads a window at a time): while the other
 * leg was hearing something as the sentence began, the question is asked
 * again, this often and this many times, before the sentence is taken for
 * the user's own.
 */
const HEARD_ASK_EVERY_MS = 500;
/** …while the other leg is still hearing its stretch; once that has closed, its last writing is given this many more. */
const HEARD_ASK_TIMES = 10;
const HEARD_ASK_TIMES_CLOSED = 2;

/** A stretch whose finished sentences are closed as they come: see `PipelineLeg.cuts`. */
interface Cut {
  done: string;
  rest: { ref: Ref; origin?: string } | null;
  waiting: { text: string; since: number } | null;
  language?: string;
}

class PipelineLeg implements AdapterSession {
  readonly inner: AdapterEvents;
  info: { transport?: string } = {};
  private session: AdapterSession | null = null;
  /** Stopped, or the inner session ended: nothing more is said. */
  private ended = false;
  private refs = FIRST_REF;
  private typedIds = 0;
  /** Open source segments of the inner session: what each says, and what it answers to. */
  private readonly sources = new Map<Ref, { origin?: string; text: string }>();
  /**
   * Of those, the ones of a leg that closes a stretch's finished sentences as they come (`sentenceCut.ts`): the
   * stretch's beginning as it read when it was closed (none yet: `''`), the segment that shows what is left of it
   * and what that answers to (none while nothing is left), the sentence waiting to have stood long enough, and the
   * language the stretch was last said to be in.
   */
  private readonly cuts = new Map<Ref, Cut>();
  private pieceIds = 0;
  private readonly queue: Job[] = [];
  private running: AbortController | null = null;
  private innerBusy = false;
  private saidBusy = false;
  /** This computer's translation models, by id, once loaded. */
  private readonly translators = new Map<string, TranslationLike>();
  /** How many of them have loaded, and the inner session's own loading count: one progress for the starting surface. */
  private loadedHere = 0;
  private innerLoading = { done: 0, total: 0 };

  constructor(
    private readonly request: StartRequest<PipelineConfig, PipelineCredentials>,
    private readonly stages: Stages,
    private readonly events: AdapterEvents,
    private readonly doFetch: typeof fetch,
    private readonly engines: LocalEngines,
    private readonly engineBase: (engine: 'translator' | 'coach', model: string) => Promise<EngineAddress> = engineBaseNow,
  ) {
    this.inner = eventsFrom((e) => this.onInner(e));
  }

  /**
   * Loads this computer's translation models, each for the leg's direction.
   * One that cannot load rejects the start, the others disposed; so does
   * the start's signal.
   */
  async open(): Promise<void> {
    const wanted = deviceStages(this.stages);
    if (wanted.length === 0) return;
    const { signal, clock } = this.request;
    if (signal.aborted) throw signal.reason ?? new Error('aborted');
    const { source, target } = this.request.context.direction;
    const loading = wanted.map((stage) => ({ stage, engine: this.engines.translation() }));
    const disposeAll = () => { for (const { engine } of loading) engine.dispose(); };
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason ?? new Error('aborted'));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      await Promise.race([
        aborted,
        Promise.all(loading.map(async ({ stage, engine }) => {
          this.frame('out', 'device.translation.start', { model: stage.model });
          const started = clock.now();
          await engine.init(baseOf(source), baseOf(target), stage.model);
          this.frame('out', 'device.translation.ready', { model: stage.model, initDurationMs: clock.now() - started });
          this.loadedHere += 1;
          this.sayLoading('translation');
        })),
      ]);
    } catch (error) {
      disposeAll();
      throw error instanceof Error && !signal.aborted ? new Error(`Translation engine init failed: ${error.message}`) : error;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
    // What hears failed to start meanwhile: nothing here is wanted.
    if (this.ended) {
      disposeAll();
      throw new Error('the session ended');
    }
    for (const { stage, engine } of loading) {
      // A failure no request carries — the worker died: no translation would ever settle.
      engine.onError = (error) => this.fail(`Translation stopped: ${error}`);
      this.translators.set(stage.model, engine);
    }
  }

  attach(session: AdapterSession): this {
    this.session = session;
    this.info = session.info;
    return this;
  }

  appendAudio(pcm: Int16Array): void {
    this.session?.appendAudio(pcm);
  }

  /**
   * Typed text: the Realtime session's when no stage takes it; else shown at
   * once as its own source, and answered by the stage. A leg this computer
   * hears has no session to hand it to: with no stage either, the text is
   * shown, and said to go untranslated.
   */
  appendText(text: string): void {
    const stage = this.stages.typed;
    if (!stage && !this.request.config.device) {
      this.session?.appendText(text);
      return;
    }
    const trimmed = text.trim();
    if (this.ended || !this.session || !trimmed) return;
    const ref = ++this.refs;
    const origin = `sokuji_typed_${++this.typedIds}`;
    this.events.segmentOpened({ ref, side: 'source', origin });
    this.events.segmentText({ ref, text: trimmed });
    this.events.segmentClosed({ ref });
    if (stage) this.push({ stage, text: trimmed, origin, typed: true });
    else this.events.degraded({ code: 'translation_unavailable', message: 'Typed text has no translation stage in this session — shown as typed.' });
  }

  beginTurn(): void {
    this.session?.beginTurn();
  }

  endTurn(): void {
    this.session?.endTurn();
  }

  cancelTurn(): void {
    this.session?.cancelTurn();
  }

  /** The request in flight is aborted, the engines disposed and the socket closed before the first `await`. */
  stop(): Promise<void> {
    this.end();
    return this.session?.stop() ?? Promise.resolve();
  }

  /** A start that failed elsewhere: what this leg loaded is let go. */
  abandon(): void {
    this.end();
  }

  private end(): void {
    this.ended = true;
    this.cuts.clear();
    for (let i = heardLately.length - 1; i >= 0; i--) if (heardLately[i].leg === this) heardLately.splice(i, 1);
    this.queue.length = 0;
    this.running?.abort(new Error('the session ended'));
    this.running = null;
    for (const engine of this.translators.values()) engine.dispose();
    this.translators.clear();
  }

  /** This leg can no longer answer: said once, and the inner session stopped. */
  private fail(message: string): void {
    if (this.ended) return;
    const session = this.session;
    this.end();
    this.events.failed({ message });
    void session?.stop();
  }

  private onInner(e: AdapterEvent): void {
    if (this.ended) return;
    switch (e.kind) {
      case 'segmentOpened':
        if (e.payload.side === 'source') {
          this.sources.set(e.payload.ref, { origin: e.payload.origin, text: '' });
          heardLately.push({ leg: this, ref: e.payload.ref, text: '', from: this.request.clock.now(), until: null });
        }
        this.events.segmentOpened(e.payload);
        return;
      case 'segmentText': {
        const source = this.sources.get(e.payload.ref);
        if (source) {
          source.text = e.payload.text;
          const heard = this.heardOf(e.payload.ref);
          if (heard) heard.text = e.payload.text;
        }
        const open = source !== undefined && e.payload.language === undefined;
        const told = open ? this.stages.heard : undefined;
        // Left to be detected: the language its writing shows, or none — which also keeps the leg's own from being assumed.
        // Told one, and written in the leg's other language: said to be in that one.
        const heard = told === AUTO ? languageByScript(e.payload.text) ?? AUTO : (open ? this.otherThanHeard(e.payload.text) : undefined) ?? told;
        if (source && this.cutsSentences()) {
          this.heardSoFar(e.payload.ref, source, heard);
          return;
        }
        this.events.segmentText(heard ? { ...e.payload, language: heard } : e.payload);
        return;
      }
      case 'segmentClosed': {
        const source = this.sources.get(e.payload.ref);
        this.sources.delete(e.payload.ref);
        const text = source?.text.trim();
        const coached = this.stages.speech?.kind === 'coach';
        const heard = this.heardOf(e.payload.ref);
        if (heard) heard.until = this.request.clock.now();
        // Its finished sentences were closed as they came: what is left is the last of them.
        const cut = this.cuts.get(e.payload.ref);
        this.cuts.delete(e.payload.ref);
        if (cut && cut.done && source) {
          const rest = source.text.slice(restFrom(source.text, cut.done)).trim();
          // The recognizer's last word on the stretch no longer begins as the sentences closed from it did: said, for
          // whoever reads the frames. What was closed stands; what is left is found by its letters (`restFrom`).
          if (!source.text.startsWith(cut.done)) this.frame('in', 'speech.rewritten', { closed: cut.done.length, heard: source.text.length });
          // Nothing after the last one — or its marks alone, where the recognizer's last word moved a full stop: a
          // segment that waited for more goes, as one that heard nothing does. (A caption of "。", answered with "。",
          // was seen 2026-10-06.)
          if (letters(rest) === 0) {
            if (cut.rest) {
              this.events.segmentText({ ref: cut.rest.ref, text: '' });
              this.events.segmentClosed({ ref: cut.rest.ref });
            }
            return;
          }
          const last = this.restOf(cut);
          this.events.segmentText({ ref: last.ref, text: rest, ...(cut.language ? { language: cut.language } : {}) });
          this.closed({ ref: last.ref, origin: last.origin }, { origin: last.origin, text: rest }, rest);
          return;
        }
        // A coached speaker's sentence may be the other side's voice, come back through the microphone.
        if (coached && source && text && heard) {
          this.settleOwn(heard, e.payload, source.origin, text, HEARD_ASK_TIMES);
          return;
        }
        this.closed(e.payload, source, text);
        return;
      }
      case 'busy':
        this.innerBusy = e.payload;
        this.sayBusy();
        return;
      case 'loading':
        this.innerLoading = { done: e.payload.done, total: e.payload.total };
        this.sayLoading(e.payload.stage);
        return;
      case 'degraded':
        // This computer's recognizer says it only transcribes: here a stage answers what it hears.
        if (this.request.config.device && e.payload.code === 'translation_unavailable') return;
        this.events.degraded(e.payload);
        return;
      case 'failed':
        this.end();
        this.events.failed(e.payload);
        return;
      case 'closed':
        this.end();
        this.events.closed(e.payload);
        return;
      default:
        // Every other event as it came: frames, audio, reconnects.
        (this.events[e.kind] as (payload: unknown) => void)(e.payload);
    }
  }

  /**
   * A coached speaker's sentence, closed: the other side's voice come back
   * through the microphone is taken off the screen, and nothing is asked
   * about it; the user's own goes on as any closed sentence. While the other
   * leg was hearing something as it began, its writing is waited for
   * (`HEARD_ASK_EVERY_MS`), the sentence staying open on the screen meanwhile.
   */
  private settleOwn(heard: Heard, closed: { ref: Ref; origin?: string }, origin: string | undefined, text: string, asksLeft: number): void {
    if (this.ended) return;
    const there = this.heardElsewhere(heard);
    if (there === 'same') {
      this.frame('in', 'speech.dropped', { reason: 'heard by the other leg', chars: text.length });
      this.events.segmentText({ ref: closed.ref, text: '' });
      this.events.segmentClosed(closed);
      return;
    }
    if (there !== 'none' && asksLeft > 0) {
      const left = there === 'open' ? asksLeft - 1 : Math.min(asksLeft - 1, HEARD_ASK_TIMES_CLOSED - 1);
      this.request.clock.setTimeout(() => this.settleOwn(heard, closed, origin, text, left), HEARD_ASK_EVERY_MS);
      return;
    }
    this.closed(closed, { origin, text }, text);
  }

  /**
   * Whether this leg closes a stretch's finished sentences as they come: one that translates what it hears. A coached
   * speaker's stretch is answered whole — the feedback is on what they said, and whether it was their own voice is
   * asked of the stretch (`settleOwn`) — and a leg with no stage of its own is answered by its session.
   */
  private cutsSentences(): boolean {
    const speech = this.stages.speech;
    return !!speech && speech.kind !== 'coach';
  }

  /** The segment that shows what is left of a stretch: opened when there first is something left. */
  private restOf(cut: Cut): { ref: Ref; origin?: string } {
    if (!cut.rest) {
      cut.rest = { ref: ++this.refs, origin: `kotomimi_piece_${++this.pieceIds}` };
      this.events.segmentOpened({ ref: cut.rest.ref, side: 'source', origin: cut.rest.origin });
    }
    return cut.rest;
  }

  /**
   * A stretch's text so far, of a leg that closes its sentences as they come. What is shown is what is left of it
   * after the sentences already closed. A finished sentence the speaker has gone on from, once it has stood
   * unchanged for a moment, is closed — its own segment, sent for its answer — and what follows shows in a segment
   * of its own from then on.
   */
  private heardSoFar(ref: Ref, source: { origin?: string; text: string }, language: string | undefined): void {
    const { clock } = this.request;
    let cut = this.cuts.get(ref);
    if (!cut) {
      // Until its first sentence is closed, what is left of the stretch is all of it: the inner session's own segment.
      cut = { done: '', rest: { ref, origin: source.origin }, waiting: null };
      this.cuts.set(ref, cut);
    }
    cut.language = language;
    const rest = source.text.slice(restFrom(source.text, cut.done));
    const end = cutAt(rest);
    if (end >= 0) {
      const sentence = rest.slice(0, end).trim();
      if (cut.waiting?.text !== sentence) cut.waiting = { text: sentence, since: clock.now() };
      else if (clock.now() - cut.waiting.since >= SETTLE_MS) {
        this.cutAfter(source, cut, source.text.length - rest.length + end, sentence);
        this.sayRest(cut, rest.slice(end));
        return;
      }
    } else {
      cut.waiting = null;
    }
    this.sayRest(cut, rest);
  }

  /** Closes the stretch's text up to `upTo` as a sentence of its own, and sends it for its answer. */
  private cutAfter(source: { origin?: string; text: string }, cut: Cut, upTo: number, sentence: string): void {
    const shown = this.restOf(cut);
    // The first of a stretch is the inner session's segment, which may not know yet what it answers to: said here.
    const origin = shown.origin ?? `kotomimi_piece_${++this.pieceIds}`;
    this.events.segmentText({ ref: shown.ref, text: sentence, ...(cut.language ? { language: cut.language } : {}) });
    this.frame('in', 'speech.sentence', { chars: sentence.length });
    cut.done = source.text.slice(0, upTo);
    cut.rest = null;
    cut.waiting = null;
    this.closed({ ref: shown.ref, origin }, { origin, text: sentence }, sentence);
  }

  /** What is left of a stretch, as it now reads: in its segment, opened when there first is something to show. */
  private sayRest(cut: Cut, rest: string): void {
    const text = cut.done ? rest.trimStart() : rest;
    // A mark or two is not yet something to open a segment for.
    if (!cut.rest && letters(text) === 0) return;
    this.events.segmentText({ ref: this.restOf(cut).ref, text, ...(cut.language ? { language: cut.language } : {}) });
  }

  /** A source sentence, closed: said so, and handed to what answers it. */
  private closed(payload: { ref: Ref; origin?: string }, source: { origin?: string; text: string } | undefined, text: string | undefined): void {
    const coached = this.stages.speech?.kind === 'coach';
    this.events.segmentClosed(payload);
    const other = text !== undefined ? this.otherThanHeard(text) : undefined;
    // What was said in the reader's own language needs no translating: detected, or told another and written in theirs.
    const already = !coached && text !== undefined && (other !== undefined || (this.stages.heard === AUTO && languageByScript(text) === baseOf(this.request.context.direction.target)));
    // A coached speaker who says a sentence in their own language is not practising with it: it is translated, as what
    // they type is, and not sent for feedback. No translation in this run: it is shown as said.
    const stage = coached && other !== undefined ? this.stages.typed : this.stages.speech;
    if (source && text && stage && !already) this.push({ stage, text, origin: payload.origin ?? source.origin, typed: false });
  }

  private heardOf(ref: Ref): Heard | undefined {
    return heardLately.find((h) => h.leg === this && h.ref === ref && h.until === null);
  }

  /**
   * Whether a stretch this leg heard is one another leg was hearing as it
   * began, by its writing (`sameSpeech`): 'same'. Where another leg was
   * hearing something then and it reads otherwise so far: 'open' while that
   * leg is still hearing it, 'other' once it has closed. 'none': no other leg
   * was hearing anything. Older stretches are forgotten here.
   */
  private heardElsewhere(mine: Heard): 'same' | 'open' | 'other' | 'none' {
    const now = this.request.clock.now();
    for (let i = heardLately.length - 1; i >= 0; i--) {
      const h = heardLately[i];
      if (h.until !== null && now - h.until > HEARD_KEPT_MS) heardLately.splice(i, 1);
    }
    const there = heardLately.filter((h) => h.leg !== this && mine.from >= h.from - HEARD_SLACK_MS && (h.until === null || mine.from <= h.until - HEARD_TRAIL_MS));
    if (there.length === 0) return 'none';
    if (sameSpeech(mine.text, there.map((h) => h.text).join(' '))) return 'same';
    return there.some((h) => h.until === null) ? 'open' : 'other';
  }

  /**
   * The language of a sentence that is not in the one the leg was told it
   * hears, where its writing says so (`saidInOwn`): the leg's other language.
   * A coached speaker's own, said between sentences of the one they practise;
   * or, of a leg that translates, the one it translates into — the other side
   * speaking the reader's language, which needs no translating. Undefined: in
   * the language told, or the writing does not say; and always of a leg with
   * no stage of its own, whose session answers what it hears itself.
   */
  private otherThanHeard(text: string): string | undefined {
    const speech = this.stages.speech;
    if (!speech || this.stages.heard === AUTO) return undefined;
    const { source, target } = this.request.context.direction;
    if (speech.kind === 'coach') return saidInOwn(text, source, target) ? source : undefined;
    return saidInOwn(text, target, source) ? target : undefined;
  }

  /** The inner session's models and this leg's own, as one count. */
  private sayLoading(stage: string): void {
    const here = deviceStages(this.stages).length;
    if (here === 0) {
      this.events.loading({ stage, ...this.innerLoading });
      return;
    }
    // Before the inner session has counted its own, a recognizer on this computer is known to be one more.
    const innerTotal = this.innerLoading.total || (this.request.config.device ? 1 : 0);
    this.events.loading({ stage, done: this.innerLoading.done + this.loadedHere, total: innerTotal + here });
  }

  private push(job: Job): void {
    this.queue.push(job);
    this.sayBusy();
    void this.pump();
  }

  /** One answer at a time, in the order the sources finished: the rows read in the order they were said. */
  private async pump(): Promise<void> {
    if (this.running || this.ended) return;
    const job = this.queue.shift();
    if (!job) return;
    const controller = new AbortController();
    this.running = controller;
    try {
      await this.answer(job, controller.signal);
    } finally {
      if (this.running === controller) this.running = null;
    }
    if (this.ended) return;
    this.sayBusy();
    void this.pump();
  }

  private async answer(job: Job, signal: AbortSignal): Promise<void> {
    const { stage } = job;
    const { clock } = this.request;
    const ref = ++this.refs;
    let opened = false;
    let shown = '';
    const show = (text: string) => {
      if (this.ended || !text || text === shown) return;
      if (!opened) {
        this.events.segmentOpened({ ref, side: 'translation', ...(job.origin !== undefined ? { origin: job.origin } : {}) });
        opened = true;
      }
      shown = text;
      this.events.segmentText({ ref, text, ...(stage.language ? { language: stage.language } : {}) });
    };
    const where = stage.via === 'device' ? { device: true } : {};
    this.frame('out', 'text.request', { stage: stage.kind, model: stage.model, chars: job.text.length, ...where });
    try {
      const started = clock.now();
      const answer: { text: string; firstMs?: number; totalMs: number } = stage.via === 'device' ? await this.translateHere(stage, job.text, started) : await this.complete(stage, job.text, signal, show);
      if (this.ended) return;
      const final = tidyAnswer(stage.kind, answer.text);
      show(final);
      this.frame('in', 'text.done', { stage: stage.kind, model: stage.model, firstMs: answer.firstMs ?? null, totalMs: answer.totalMs, chars: final.length, ...where });
      if (opened) this.events.segmentClosed({ ref });
      // A model that said nothing: feedback with nothing to say is no fault; a translation with none is.
      else if (stage.kind === 'translate') this.unanswered(job, 'the model answered with no text');
    } catch (error) {
      if (this.ended) return;
      if (opened) this.events.segmentClosed({ ref });
      this.frame('in', 'text.failed', { stage: stage.kind, model: stage.model, message: describeCause(error), ...where });
      this.unanswered(job, describeCause(error), error);
    }
  }

  /** A text model's answer, shown as it is written. */
  private async complete(stage: TextStage, text: string, signal: AbortSignal, show: (text: string) => void): Promise<{ text: string; firstMs?: number; totalMs: number }> {
    const { credentials, clock } = this.request;
    let key = stage.key ? credentials[stage.key] : undefined;
    let base = stage.baseUrl || httpBaseOf(credentials.endpoint);
    if (stage.engine) {
      try {
        const now = await this.engineBase(stage.engine, stage.model);
        base = now.base;
        key = now.key;
      } catch {
        // Not to be asked (a test, a build with no main process), or not up: the address it was built with.
      }
    }
    return completeText(
      {
        url: chatUrl(base),
        model: stage.model,
        ...(key ? { key } : {}),
        system: stage.wrap ? '' : stage.system,
        ...(stage.shots?.length ? { shots: stage.shots } : {}),
        ...(stage.pair ? { pair: stage.pair } : {}),
        ...(stage.extra ? { extra: stage.extra } : {}),
        // A function, so that nothing in the sentence is read as a pattern.
        user: stage.wrap ? stage.wrap.replace(TEXT_SLOT, () => text) : text,
      },
      { fetch: this.doFetch, clock, signal, onText: (shown) => show(tidyAnswer(stage.kind, shown)) },
    );
  }

  /** This computer's own answer: whole when it comes, since its engines write nothing before the end. */
  private async translateHere(stage: DeviceStage, text: string, started: number): Promise<{ text: string; totalMs: number }> {
    const engine = this.translators.get(stage.model);
    if (!engine) throw new Error('the model is not loaded');
    const result = await engine.translate(text, stage.system, stage.wrapTranscript);
    return { text: result.translatedText ?? '', totalMs: this.request.clock.now() - started };
  }

  /** A source left without its answer: the session goes on, and says so. */
  private unanswered(job: Job, why: string, cause?: unknown): void {
    const what = job.stage.kind === 'coach' ? 'The feedback model' : 'The translation model';
    this.events.degraded({
      // Each said as what it was: a sentence with no feedback, a typed sentence with no translation (which the
      // contract's `text-input-answered` wants said), a heard one with none.
      code: job.stage.kind === 'coach' ? 'feedback_failed' : job.typed ? 'typed_translation_failed' : 'translation_failed',
      message: `${what} (${job.stage.model}) did not answer: ${why}`,
      ...(cause !== undefined ? { cause } : {}),
    });
  }

  private sayBusy(): void {
    const busy = this.innerBusy || this.running !== null || this.queue.length > 0;
    if (busy === this.saidBusy || this.ended) return;
    this.saidBusy = busy;
    this.events.busy(busy);
  }

  private frame(direction: 'in' | 'out', type: string, payload: unknown): void {
    if (this.ended) return;
    this.events.frame({ direction, type, payload: framePayload(payload) });
  }
}

/** What the app's model catalog calls a language: its base (`zh-CN` → `zh`). */
const baseOf = (code: string): string => code.split('-')[0];

/** `fetch` as it is when called, so a test's stubbed global is seen. */
const fetchNow: typeof fetch = (input, init) => fetch(input, init);

/** The request this computer's recognizer is started with: its own config, hearing the language the speaker speaks, translating nothing itself and never speaking. */
function hearingRequest(request: StartRequest<PipelineConfig, PipelineCredentials>, device: DeviceHearing, heard: string | undefined): StartRequest<LocalInferenceConfig, Record<string, never>> {
  const { source, target } = request.context.direction;
  return {
    context: { ...request.context, direction: { source: baseOf(heard ?? source), target: baseOf(heard ? source : target) }, speech: false },
    config: { asr: { modelId: device.modelId, streaming: device.streaming }, vad: device.vad, translation: { kind: 'none' } },
    credentials: {},
    clock: request.clock,
    signal: request.signal,
  };
}

export function createPipelineAdapter(deps: Partial<PipelineDeps> = {}): Adapter<PipelineConfig, PipelineCredentials> {
  const realtime = createRealtimeAdapter(deps.openSocket ? { openSocket: deps.openSocket } : {});
  const engines = deps.engines ?? defaultEngines;
  const local = createLocalInferenceAdapter(engines);
  /** What hears on this computer: its own recognizer, or — the same adapter with that one engine changed — an API's. */
  const hearing = (device: DeviceHearing, request: StartRequest<PipelineConfig, PipelineCredentials>) => {
    const { api, native } = device;
    if (native) {
      const start = deps.native?.start ?? ((model: string) => askNativeEngine('start', model));
      return createLocalInferenceAdapter({ ...engines, asr: () => createNativeAsr({ bridge: deps.native?.bridge ?? ipcNativeBridge, start: () => start(native.model), model: native.model, clock: request.clock, ...(native.limits ? { limits: native.limits } : {}) }) });
    }
    if (!api) return local;
    const key = api.key ? request.credentials[api.key] : undefined;
    return createLocalInferenceAdapter({ ...engines, asr: () => createApiAsr({ baseUrl: api.baseUrl, model: api.model, ...(key ? { key } : {}), fetch: deps.fetch ?? fetchNow, clock: request.clock }) });
  };
  /** The Realtime session's own request: on the socket the config names, when it names one. */
  const dialled = (request: StartRequest<PipelineConfig, PipelineCredentials>): StartRequest<PipelineConfig, PipelineCredentials> => {
    const { socket } = request.config;
    return socket ? { ...request, credentials: { ...request.credentials, endpoint: socket.endpoint, apiKey: '' } } : request;
  };
  return {
    async start(request, events) {
      const { stages, device, prepare } = request.config;
      // The pipeline is told its recognizer before any socket opens. Best done, not a condition: one that could not be
      // told keeps the recognizer it has, and the session still hears. (Nothing is waited for where nothing is asked:
      // a start opens its socket in the same turn.)
      if (prepare && deps.prepare && !device) await deps.prepare(prepare.pipeline, prepare.transcription).catch(() => undefined);
      if (!device && (!stages || (!stages.speech && !stages.typed))) return realtime.start(dialled(request), events);
      const leg = new PipelineLeg(request, stages ?? { speech: null, typed: null }, events, deps.fetch ?? fetchNow, engines, deps.native?.base ?? engineBaseNow);
      // What hears and what answers load together; either failing lets the other go.
      const opening = leg.open();
      opening.catch(() => {});
      let session: AdapterSession;
      try {
        session = await (device ? hearing(device, request).start(hearingRequest(request, device, stages?.heard), leg.inner) : realtime.start(dialled(request), leg.inner));
      } catch (error) {
        leg.abandon();
        throw error;
      }
      try {
        await opening;
      } catch (error) {
        leg.abandon();
        await session.stop();
        throw error;
      }
      return leg.attach(session);
    },
  };
}
