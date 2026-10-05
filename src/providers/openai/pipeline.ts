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
import { languageByScript } from '../../lib/language/script';
import { AUTO } from '../../lib/provider/languages';
import { TEXT_SLOT } from './nativeTranslators';
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
  native: { bridge: NativeBridge; start(model: string): Promise<NativeEngineStatus> };
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
        if (e.payload.side === 'source') this.sources.set(e.payload.ref, { origin: e.payload.origin, text: '' });
        this.events.segmentOpened(e.payload);
        return;
      case 'segmentText': {
        const source = this.sources.get(e.payload.ref);
        if (source) source.text = e.payload.text;
        const told = source && e.payload.language === undefined ? this.stages.heard : undefined;
        // Left to be detected: the language its writing shows, or none — which also keeps the leg's own from being assumed.
        const heard = told === AUTO ? languageByScript(e.payload.text) ?? AUTO : told;
        this.events.segmentText(heard ? { ...e.payload, language: heard } : e.payload);
        return;
      }
      case 'segmentClosed': {
        const source = this.sources.get(e.payload.ref);
        this.sources.delete(e.payload.ref);
        this.events.segmentClosed(e.payload);
        const text = source?.text.trim();
        // What was said in the reader's own language needs no translating.
        const already = this.stages.heard === AUTO && text !== undefined && languageByScript(text) === baseOf(this.request.context.direction.target);
        if (source && text && this.stages.speech && !already) this.push({ stage: this.stages.speech, text, origin: e.payload.origin ?? source.origin, typed: false });
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
  private complete(stage: TextStage, text: string, signal: AbortSignal, show: (text: string) => void): Promise<{ text: string; firstMs?: number; totalMs: number }> {
    const { credentials, clock } = this.request;
    const key = stage.key ? credentials[stage.key] : undefined;
    return completeText(
      {
        url: chatUrl(stage.baseUrl || httpBaseOf(credentials.endpoint)),
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
      // Typed text that cannot be answered is said to be so (the contract's `text-input-answered`).
      code: job.typed ? 'translation_unavailable' : 'translation_failed',
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
      const leg = new PipelineLeg(request, stages ?? { speech: null, typed: null }, events, deps.fetch ?? fetchNow, engines);
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
