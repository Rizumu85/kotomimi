/**
 * Fork: a leg whose stages run where the user chose — speech recognition on
 * one server, the text model that answers it on another. The Realtime
 * adapter runs underneath as it is, in a transcription session: the server
 * detects turns and writes the source text, and makes no answer. Each
 * finished source is then handed to a text model over chat completions
 * (`textModel.ts`), and its answer is this leg's translation segment, paired
 * with the source by the same origin.
 *
 * What a stage answers with is its own business: a translation, or — for a
 * speaker practising the other side's language — feedback on what they just
 * said. Typed text takes the same road, through the `typed` stage.
 *
 * A leg with no stage of its own is the Realtime adapter untouched: the
 * server's pipeline answers, as before.
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
import { createRealtimeAdapter } from './adapter';
import type { RealtimeConfig } from './config';
import type { RealtimeCredentials } from './settings';
import type { OpenSocket } from './socket';
import { chatUrl, completeText, httpBaseOf } from './textModel';
import { unwrapTranslationText } from './wire';

/** The credential a stage's endpoint is called with, by its field. */
export type StageKey = 'translateKey' | 'coachKey';

export interface TextStage {
  kind: 'translate' | 'coach';
  /** An OpenAI-style base URL (`http://host:11434/v1`); blank: the Realtime server's own. */
  baseUrl: string;
  model: string;
  /** Absent: the endpoint takes no key. */
  key?: StageKey;
  system: string;
  /** The language its answers are written in, when that is not the leg's target. */
  language?: string;
}

export interface Stages {
  /** What answers a finished source. Null: the server's own pipeline does, inside the Realtime session. */
  speech: TextStage | null;
  /** What answers typed text. Null: the Realtime session does. */
  typed: TextStage | null;
  /** The language heard, when it is not the leg's source: a speaker practising the target language. */
  heard?: string;
}

export interface PipelineConfig extends RealtimeConfig {
  /** Absent: the Realtime adapter alone. */
  stages?: Stages;
}

export interface PipelineCredentials extends RealtimeCredentials {
  endpoint: string;
  translateKey?: string;
  coachKey?: string;
}

export interface PipelineDeps {
  openSocket: OpenSocket;
  fetch: typeof fetch;
}

/** The wrapper's own refs start here: the inner adapter counts from 1 and never reaches it. */
export const FIRST_REF = 1_000_000;

interface Job {
  stage: TextStage;
  text: string;
  origin: string | undefined;
  /** Typed text must be answered, or said to be unanswerable (the contract's `text-input-answered`). */
  typed: boolean;
}

/** A stage's answer as it is shown: a translation unwrapped as the Realtime adapter unwraps one; feedback as a bare ✓ when that is all it says, else its lines. */
export function tidyAnswer(kind: TextStage['kind'], text: string): string {
  if (kind === 'translate') return unwrapTranslationText(text);
  // Small models number or bullet the two lines whatever they are told: the mark is not part of the sentence.
  const lines = text.split('\n').map((line) => line.trim().replace(/^(?:[12][.)、:：]|[-•*])\s*/, '')).filter(Boolean);
  if (lines.length === 0) return '';
  if (/^[✓✔☑]/.test(lines[0]) || /^(ok|correct)[.!]?$/i.test(lines[0])) return '✓';
  return lines.join('\n');
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

  constructor(
    private readonly request: StartRequest<PipelineConfig, PipelineCredentials>,
    private readonly stages: Stages,
    private readonly events: AdapterEvents,
    private readonly doFetch: typeof fetch,
  ) {
    this.inner = eventsFrom((e) => this.onInner(e));
  }

  attach(session: AdapterSession): this {
    this.session = session;
    this.info = session.info;
    return this;
  }

  appendAudio(pcm: Int16Array): void {
    this.session?.appendAudio(pcm);
  }

  /** Typed text: the Realtime session's when no stage takes it; else shown at once as its own source, and answered by the stage. */
  appendText(text: string): void {
    const stage = this.stages.typed;
    if (!stage) {
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
    this.push({ stage, text: trimmed, origin, typed: true });
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

  /** The request in flight is aborted and the socket closed before the first `await`. */
  stop(): Promise<void> {
    this.end();
    return this.session?.stop() ?? Promise.resolve();
  }

  private end(): void {
    this.ended = true;
    this.queue.length = 0;
    this.running?.abort(new Error('the session ended'));
    this.running = null;
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
        const heard = source && e.payload.language === undefined ? this.stages.heard : undefined;
        this.events.segmentText(heard ? { ...e.payload, language: heard } : e.payload);
        return;
      }
      case 'segmentClosed': {
        const source = this.sources.get(e.payload.ref);
        this.sources.delete(e.payload.ref);
        this.events.segmentClosed(e.payload);
        const text = source?.text.trim();
        if (source && text && this.stages.speech) this.push({ stage: this.stages.speech, text, origin: e.payload.origin ?? source.origin, typed: false });
        return;
      }
      case 'busy':
        this.innerBusy = e.payload;
        this.sayBusy();
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
        // Every other event as it came: frames, audio, notices, reconnects.
        (this.events[e.kind] as (payload: unknown) => void)(e.payload);
    }
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
    const { credentials, clock } = this.request;
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
    this.frame('out', 'text.request', { stage: stage.kind, model: stage.model, chars: job.text.length });
    try {
      const answer = await completeText(
        { url: chatUrl(stage.baseUrl || httpBaseOf(credentials.endpoint)), model: stage.model, key: stage.key ? credentials[stage.key] : undefined, system: stage.system, user: job.text },
        { fetch: this.doFetch, clock, signal, onText: (text) => show(tidyAnswer(stage.kind, text)) },
      );
      if (this.ended) return;
      const final = tidyAnswer(stage.kind, answer.text);
      show(final);
      this.frame('in', 'text.done', { stage: stage.kind, model: stage.model, firstMs: answer.firstMs ?? null, totalMs: answer.totalMs, chars: final.length });
      if (opened) this.events.segmentClosed({ ref });
      // A model that said nothing: feedback with nothing to say is no fault; a translation with none is.
      else if (stage.kind === 'translate') this.unanswered(job, 'the model answered with no text');
    } catch (error) {
      if (this.ended) return;
      if (opened) this.events.segmentClosed({ ref });
      this.frame('in', 'text.failed', { stage: stage.kind, model: stage.model, message: describeCause(error) });
      this.unanswered(job, describeCause(error), error);
    }
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

/** `fetch` as it is when called, so a test's stubbed global is seen. */
const fetchNow: typeof fetch = (input, init) => fetch(input, init);

export function createPipelineAdapter(deps: Partial<PipelineDeps> = {}): Adapter<PipelineConfig, PipelineCredentials> {
  const realtime = createRealtimeAdapter(deps.openSocket ? { openSocket: deps.openSocket } : {});
  return {
    async start(request, events) {
      const stages = request.config.stages;
      if (!stages || (!stages.speech && !stages.typed)) return realtime.start(request, events);
      const leg = new PipelineLeg(request, stages, events, deps.fetch ?? fetchNow);
      return leg.attach(await realtime.start(request, leg.inner));
    },
  };
}
