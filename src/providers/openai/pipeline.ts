/**
 * Fork: a leg whose stages run where the user chose. Something hears: the
 * Realtime adapter, as it is, in a transcription session — the server
 * detects turns and writes the source text, and makes no answer — or this
 * computer's own recognizer, the Local Inference adapter run without a
 * translation of its own. Each finished source is then handed to what
 * answers: a native engine or remote text model over chat completions (`textModel.ts`). The answer is this leg's
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
import type { LocalEngines } from '../localInference/engines';
import { createApiAsr } from './apiAsr';
import { createNativeAsr, type NativeLimits } from './nativeAsr';
import { oneOfTwo, saidInOwn, sameSpeech, writtenInCantonese } from '../../lib/language/script';
import { identifyLanguage, writtenOutside } from '../../lib/language/identify';
import { AUTO } from '../../lib/provider/languages';
import { BEFORE_SLOT, TEXT_SLOT, reviseLanguage, reviseRequest } from './nativeTranslators';
import { normalizeRecognitionText } from '../../lib/glossary/glossary';
import type { GlossarySnapshot } from '../../lib/glossary/types';
import { cutAt, letters, restFrom, SETTLE_MS } from './sentenceCut';
import { askNativeEngine, ipcNativeBridge, NO_NATIVE_ENGINE, type NativeBridge, type NativeEngineStatus } from '../../lib/native/nativeEngine';
import { engineNode, remoteBridge } from '../../lib/native/remoteEngine';
import { createEitherAsr } from './eitherAsr';
import { createRealtimeAdapter } from './adapter';
import type { RealtimeConfig } from './config';
import type { RealtimeCredentials } from './settings';
import type { OpenSocket } from './socket';
import { chatUrl, completeText, httpBaseOf } from './textModel';
import { PHONE_BUSY_RETRIES, PHONE_TEXT_TIMEOUT_MS } from './phoneText';
import { watchPhones, type PhoneWatch } from './phoneWatch';
import { phoneKey } from '../../lib/lan/phoneKeys';
import { knownDeviceLabel } from '../../lib/lan/knownDevices';
import { unwrapTranslationText } from './wire';
import { recognitionLimits } from './hearingPlan';

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
  /**
   * The model is one a phone lends (`phoneText.ts`): it may first have to load it, does one thing at a time, and says
   * when to come back — so the answer is given longer, and a busy answer is asked again.
   */
  phone?: boolean;
  /**
   * The model is one another Kotomimi shares: it loads it on the first request, one model at a time. Given a phone's
   * time and retries, and asked to load it as the session starts, as a phone is (`warmPhones`).
   */
  loads?: true;
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
  /** The same, of a model that takes the sentence said before with it: that sentence where `BEFORE_SLOT` stands. */
  wrapAfter?: string;
  extra?: Readonly<Record<string, unknown>>;
  /**
   * Fork: the model also translates a sentence while it is still being said (`reviseRequest`): the languages as it is
   * told them, the source's absent where the leg's is left to be detected (each sentence's own is then told). What
   * it writes meanwhile shows in the sentence's translation, and the sentence closed is translated once more, whole.
   */
  revise?: { source?: string; target: string };
}

export type AnswerStage = TextStage;

export interface Stages {
  /** What answers a finished source. Null: the server's own pipeline does, inside the Realtime session. */
  speech: AnswerStage | null;
  /** What answers typed text. Null: the Realtime session does. */
  typed: AnswerStage | null;
  /**
   * Fork: the leg is heard in the language it is shown in: nothing answers — not the stages, which are null, nor the
   * Realtime session, which only transcribes — and what is said or typed is shown as it is.
   */
  asIs?: true;
  /**
   * The language heard, when it is not the leg's source: a speaker practising
   * the target language — or `auto`, the other side's language left to be
   * detected: the recognizer is told none, each sentence is given the
   * language its writing shows (`languageByScript`), and one already in the
   * leg's target language is not translated.
   */
  heard?: string;
  /** A stretch is answered whole, when the recognizer closes it: its sentences are not closed as they come (`sentenceCut.ts`). The user's choice. */
  whole?: boolean;
  /** Paired recognition: only final language metadata may choose translation or feedback. */
  requiresLanguage?: boolean;
  /**
   * Fork: the speaker speaks the other side's language too (`speakBoth`; `heard` is then `auto`): a sentence in it —
   * `language` — is answered by `stage`, into their own (`own`); one in their own by `speech`, as ever.
   */
  back?: { stage?: AnswerStage; language: string; own: string; languages?: readonly string[] };
  /**
   * Fork: two of the other side's languages lit, and the speaker speaks one of them (`crossings`): a sentence in it
   * (`language`) is answered by `stage`, into the other — not back into their own.
   */
  cross?: ReadonlyArray<{ language: string; stage: AnswerStage }>;
  /** Feedback alongside translation, only for speech in the language being practised. */
  feedback?: { stage: AnswerStage; language: string };
  /**
   * Fork: the other side's second language, lit by hand (`theyLitOf`): what `speech` translates — said or typed — is
   * translated into it as well, by this stage (its `language` set), a second answer beside the first.
   */
  into?: AnswerStage;
  /**
   * Fork: the speaker's microphone, with the other side's sound perhaps captured beside it (the participant leg).
   * Played on loudspeakers, that sound comes back through the microphone and is written as if the user had said it.
   * A sentence this leg hears that another leg was hearing at the same moment, and that reads as that one does, is
   * that sound, and is dropped (`settleLeak`) — in place of the browser's echo cancellation of every sound, which
   * also turned the user's own voice down while the other side spoke.
   */
  leakCheck?: true;
}

/** This computer hears: its own recognizer and turn detection, and no socket. */
export interface DeviceHearing {
  modelId: string;
  streaming: boolean;
  vad: LocalInferenceConfig['vad'];
  /**
   * Fork: the language the recognizer itself is told, when the leg is left to
   * be detected and this model cannot name a language. The phrasing is the
   * leg's own source; the pipeline then reads each finished sentence's
   * language from its writing and a small text detector (`identify.ts`).
   */
  language?: string;
  /** Present: the recognizer is an API (`apiAsr.ts`) — this computer still cuts the sentences, and uploads each one. */
  api?: { baseUrl: string; model: string; key?: StageKey; /** Where what answers there turns out to be a Kotomimi phone's engine (`remoteEngine.ts`), and the model is one this app knows: how long one recognition may run on it, as on this computer. */ limits?: Partial<NativeLimits>; /** The dictionary's words, told to such an engine as this computer's own is told them. */ hints?: readonly string[] };
  /** Present: the recognizer is the native engine's (`nativeAsr.ts`), given the voice as it comes; `limits` where one recognition may not run as long as the default. */
  /** Fork: `either`, a recognizer hearing the speaker in its first language plus the listed extras (the Mac's). */
  native?: { model: string; limits?: Partial<NativeLimits>; either?: { first: string; also: readonly string[] }; hints?: readonly string[] };
  /** The extra languages chosen once for the leg; the iPad takes only the first. */
  pairedWith?: readonly string[];
  /** Fork: the languages the leg may be in, every one named (`namedAmong`): a stretch named outside them is read again. */
  among?: readonly string[];
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
  /** The user's terms: a sentence is put right by them before it is translated. */
  glossary?: GlossarySnapshot;
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
  /**
   * Names the recognizer in a pipeline of this computer's LocalAI (`PipelineConfig.prepare`). A LocalAI takes no
   * recognizer but its pipeline's own in a session that only transcribes, and a session keeps the one the pipeline
   * named when it was configured (measured 2026-10-04): so it is named first. Absent: nothing is done.
   */
  prepare(pipeline: string, transcription: string): Promise<unknown>;
  /** An engine on another device, where the API named for recognition is one (`remoteEngine.ts`): asked, and its recognitions; stand-ins in tests. */
  remote: {
    /** Null: what answers there is no phone's engine. `model`: the one it lends now; blank where it did not say. `hears`: what it can be asked for by name. `live`: the one that hears while it is spoken, and its languages (the iPad's own). */
    node(baseUrl: string): Promise<{ model: string; hears?: string[]; live?: { model: string; languages: string[] } } | null>;
    /** `streamed`: sent the sound as it comes (`live`). */
    bridge(baseUrl: string, options?: { streamed?: boolean }): NativeBridge;
  };
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
  /** The sentence this leg heard just before, for a translator that takes one with its request. */
  before?: string;
}

/** A sentence is given to the translator of the next while it is this recent, and no more of it than its last letters. */
const BEFORE_WITHIN_MS = 15_000;
const BEFORE_MOST = 120;

/** A stage's answer as it is shown: a translation unwrapped as the Realtime adapter unwraps one; feedback as a bare ✓ when that is all it says, else its lines. */
export function tidyAnswer(kind: AnswerStage['kind'], text: string): string {
  if (kind === 'translate') return unwrapTranslationText(text);
  // Small models number or bullet the two lines whatever they are told: the mark is not part of the sentence.
  const lines = text.split('\n').map((line) => line.trim().replace(/^(?:[12][.)、:：]|[-•*])\s*/, '')).filter(Boolean);
  if (lines.length === 0) return '';
  if (/^[✓✔☑]/.test(lines[0]) || /^(ok|correct)[.!]?$/i.test(lines[0])) return '✓';
  return lines.join('\n');
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
function forgetHeard(now: number): void {
  for (let i = heardLately.length - 1; i >= 0; i--) {
    const h = heardLately[i];
    if (h.until !== null && now - h.until > HEARD_KEPT_MS) heardLately.splice(i, 1);
  }
}
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
/**
 * The same, of a sentence the speaker's leg asks about before it is translated (`leakCheck`): fewer, since the
 * user's own sentence waits on them, and only while the other side was heard at the same moment.
 */
const HEARD_LEAK_ASKS = 4;
const HEARD_ASK_TIMES_CLOSED = 2;

/** A stretch whose finished sentences are closed as they come: see `PipelineLeg.cuts`. */
/**
 * Fork: the translation of a sentence still being said (`TextStage.revise`): its segment, what it shows, and the text
 * and answer of the last request, which the next is told. `next`: the text that came while a request was under way —
 * only the newest waits. `taken`: the sentence closed, and its whole translation has the segment from here on.
 */
interface Draft {
  ref: Ref;
  opened: boolean;
  shown: string;
  source: string;
  translation: string;
  controller: AbortController | null;
  /** The text of the request under way. */
  asking: string | null;
  next: { text: string; from: string } | null;
  taken: boolean;
}

/** A sentence this short is not asked about yet: a word or two has no translation worth showing. */
const DRAFT_LEAST = 3;
/** A text this much shorter than the last one asked about is another sentence's (the stretch was cut): asked afresh. */
const DRAFT_CUT = 0.8;

interface Cut {
  done: string;
  rest: { ref: Ref; origin?: string } | null;
  waiting: { text: string; since: number } | null;
  /** The stretch's language so far: what the recognizer said (`said`), or what its writing shows. */
  language?: string;
  said?: string;
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
  /** Fork: `language`, where the recognizer said what it heard the stretch in (a speaker heard in either of two). */
  private readonly sources = new Map<Ref, { origin?: string; text: string; language?: string }>();
  /**
   * Of those, the ones of a leg that closes a stretch's finished sentences as they come (`sentenceCut.ts`): the
   * stretch's beginning as it read when it was closed (none yet: `''`), the segment that shows what is left of it
   * and what that answers to (none while nothing is left), the sentence waiting to have stood long enough, and the
   * language the stretch was last said to be in.
   */
  private readonly cuts = new Map<Ref, Cut>();
  private pieceIds = 0;
  /** The last sentence heard that was sent to be translated, and when. */
  private said: { text: string; at: number } | null = null;
  private readonly queue: Job[] = [];
  private readonly running = new Map<AnswerStage['kind'], { controller: AbortController; stage: AnswerStage }>();
  /** Fork: the open sentences' translations while they are said, by what each answers to (`Draft`). */
  private readonly drafts = new Map<string, Draft>();
  private innerBusy = false;
  private saidBusy = false;
  /** The phones this leg uses, asked now and then whether they are still there (`phoneWatch.ts`). */
  private readonly phones: PhoneWatch;

  constructor(
    private readonly request: StartRequest<PipelineConfig, PipelineCredentials>,
    private readonly stages: Stages,
    private readonly events: AdapterEvents,
    private readonly doFetch: typeof fetch,
    private readonly engineBase: (engine: 'translator' | 'coach', model: string) => Promise<EngineAddress> = engineBaseNow,
  ) {
    this.inner = eventsFrom((e) => this.onInner(e));
    this.requiresLanguage = stages.requiresLanguage === true;
    this.phones = watchPhones({
      fetch: doFetch,
      clock: request.clock,
      onQuiet: (base) => {
        if (!this.ended) {
          const device = knownDeviceLabel(base);
          this.events.degraded({
            code: 'phone_quiet',
            message: `The ${device.tablet ? 'tablet' : 'phone'}${device.name ? ` ${device.name}` : ''} is not answering.`,
            params: { address: device.address, name: device.name, form: device.tablet ? 'tablet' : 'phone' },
          });
        }
      },
    });
    for (const stage of [stages.speech, stages.typed, stages.back?.stage, stages.feedback?.stage, stages.into, ...(stages.cross ?? []).map((c) => c.stage)]) if (stage?.phone) this.watchPhone(stage.baseUrl);
  }

  /**
   * Whether only a sentence's final language may choose what answers it (`Stages.requiresLanguage`): as built, or
   * found as the session starts, where a lent device hears in either of two languages (`pairedHearing`).
   */
  private requiresLanguage: boolean;

  /** The device that hears does so in either of two languages, and says which at the end, as the Mac's own does. */
  pairedHearing(): void {
    this.requiresLanguage = true;
  }

  /** A phone this leg uses, watched until the leg ends: one a stage answers on, or what hears (`hearing`). */
  watchPhone(base: string): void {
    if (!this.ended) this.phones.add(base);
  }

  attach(session: AdapterSession): this {
    this.session = session;
    this.info = session.info;
    this.warm();
    return this;
  }

  /** Stops the loads this leg asked for, with the leg. */
  private readonly warming = new AbortController();

  /**
   * Another Kotomimi's text models, asked once as the session starts with a word to answer, so that it loads them
   * now and the first sentence does not wait for the load. Not waited for, and nothing is shown: whatever fails here
   * fails again, and is said, on that sentence.
   */
  private warm(): void {
    const seen = new Set<string>();
    for (const stage of [this.stages.speech, this.stages.typed, this.stages.back?.stage, this.stages.feedback?.stage, this.stages.into, ...(this.stages.cross ?? []).map((c) => c.stage)]) {
      if (!stage?.loads || seen.has(`${stage.kind}|${stage.model}`)) continue;
      seen.add(`${stage.kind}|${stage.model}`);
      // One token, as a phone is warmed (`warmPhones`): what answers is not wanted.
      void this.complete({ ...stage, extra: { ...stage.extra, max_tokens: 1 } }, 'Hello', this.warming.signal, () => undefined).catch(() => undefined);
    }
  }

  appendAudio(pcm: Int16Array): void {
    this.session?.appendAudio(pcm);
  }

  /** Fork: told on to the session that hears: another device's has none, and goes on as it is. */
  pace(pace: 'normal' | 'quick'): void {
    this.session?.pace?.(pace);
  }

  /**
   * Typed text: the Realtime session's when no stage takes it; else shown at
   * once as its own source, and answered by the stage. A leg this computer
   * hears has no session to hand it to: with no stage either, the text is
   * shown, and said to go untranslated.
   */
  appendText(text: string): void {
    const stage = this.stages.typed;
    if (!stage && !this.request.config.device && !this.stages.asIs) {
      this.session?.appendText(text);
      return;
    }
    const trimmed = text.trim();
    if (this.ended || !this.session || !trimmed) return;
    const ref = ++this.refs;
    const origin = `sokuji_typed_${++this.typedIds}`;
    const language = this.stages.back ? this.byWriting(trimmed) ?? AUTO : undefined;
    this.events.segmentOpened({ ref, side: 'source', origin });
    this.events.segmentText({ ref, text: trimmed, ...(language ? { language } : {}) });
    this.events.segmentClosed({ ref });
    if (stage) {
      const answer = this.backFor(trimmed, language) ?? stage;
      this.push({ stage: answer, text: trimmed, origin, typed: true });
      if (answer === stage) this.alsoInto(trimmed, origin, true);
    } else if (!this.stages.asIs) this.events.degraded({ code: 'translation_unavailable', message: 'Typed text has no translation stage in this session — shown as typed.' });
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
    this.warming.abort(new Error('the session ended'));
    this.phones.stop();
    this.cuts.clear();
    for (let i = heardLately.length - 1; i >= 0; i--) if (heardLately[i].leg === this) heardLately.splice(i, 1);
    this.queue.length = 0;
    for (const { controller } of this.running.values()) controller.abort(new Error('the session ended'));
    this.running.clear();
    for (const draft of this.drafts.values()) draft.controller?.abort(new Error('the session ended'));
    this.drafts.clear();
  }

  private onInner(e: AdapterEvent): void {
    if (this.ended) return;
    switch (e.kind) {
      case 'segmentOpened':
        if (e.payload.side === 'source') {
          this.sources.set(e.payload.ref, { origin: e.payload.origin, text: '' });
          const from = this.request.clock.now();
          // Forgotten here too: a leg that never compares (`heardElsewhere`) would keep every stretch of a long run.
          forgetHeard(from);
          heardLately.push({ leg: this, ref: e.payload.ref, text: '', from, until: null });
        }
        this.events.segmentOpened(e.payload);
        return;
      case 'segmentText': {
        const source = this.sources.get(e.payload.ref);
        // Said by a recognizer left to detect it (Qwen3-ASR, SenseVoice): kept where it is one the leg may be in, and
        // one outside them read from the writing, as a sentence it said nothing of is.
        const said = e.payload.language && (this.stages.heard !== AUTO || this.mayBeIn(e.payload.language)) ? e.payload.language : undefined;
        if (source) {
          source.text = e.payload.text;
          if (said) source.language = said;
          const heard = this.heardOf(e.payload.ref);
          if (heard) heard.text = e.payload.text;
        }
        const open = source !== undefined && said === undefined;
        const told = open ? this.stages.heard : undefined;
        // Left to be detected: the language its writing shows, or none — which also keeps the leg's own from being assumed.
        // Told one, and written in the leg's other language: said to be in that one.
        // Said by the recognizer: that, which also goes with the sentences closed from it.
        const heard = said ?? (this.requiresLanguage ? undefined : (told === AUTO ? this.byWriting(e.payload.text) ?? AUTO : (open ? this.otherThanHeard(e.payload.text) : undefined) ?? told));
        if (source && this.cutsSentences()) {
          this.heardSoFar(e.payload.ref, source, heard);
          return;
        }
        this.events.segmentText(heard ? { ...e.payload, language: heard } : e.payload);
        // Fork: a stretch answered whole, when it closes, is translated meanwhile too, as far as it goes (`draft`).
        if (source && !this.requiresLanguage) this.draft(source.origin, e.payload.text, heard);
        return;
      }
      case 'segmentClosed': {
        const source = this.sources.get(e.payload.ref);
        this.sources.delete(e.payload.ref);
        const text = source?.text.trim();
        const coached = this.stages.speech?.kind === 'coach' || !!this.stages.feedback;
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
              this.dropDraft(cut.rest.origin);
              this.events.segmentText({ ref: cut.rest.ref, text: '' });
              this.events.segmentClosed({ ref: cut.rest.ref });
            }
            return;
          }
          const last = this.restOf(cut);
          cut.said = source.language;
          const language = this.pieceLanguage(cut, rest);
          this.events.segmentText({ ref: last.ref, text: rest, ...(language ? { language } : {}) });
          this.closed({ ref: last.ref, origin: last.origin }, { origin: last.origin, text: rest }, rest, language === AUTO ? undefined : language);
          return;
        }
        // A coached speaker's sentence may be the other side's voice, come back through the microphone.
        if (coached && source && text && heard) {
          this.settleOwn(heard, e.payload, source.origin, text, HEARD_ASK_TIMES, source.language);
          return;
        }
        this.closed(e.payload, source, text, source?.language);
        return;
      }
      case 'busy':
        this.innerBusy = e.payload;
        this.sayBusy();
        return;
      case 'loading':
        this.events.loading(e.payload);
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
  private settleOwn(heard: Heard, closed: { ref: Ref; origin?: string }, origin: string | undefined, text: string, asksLeft: number, language?: string): void {
    if (this.ended) return;
    const there = this.heardElsewhere(heard);
    if (there === 'same') {
      this.frame('in', 'speech.dropped', { reason: 'heard by the other leg', chars: text.length });
      this.dropDraft(closed.origin ?? origin);
      this.events.segmentText({ ref: closed.ref, text: '' });
      this.events.segmentClosed(closed);
      return;
    }
    if (there !== 'none' && asksLeft > 0) {
      const left = there === 'open' ? asksLeft - 1 : Math.min(asksLeft - 1, HEARD_ASK_TIMES_CLOSED - 1);
      this.request.clock.setTimeout(() => this.settleOwn(heard, closed, origin, text, left, language), HEARD_ASK_EVERY_MS);
      return;
    }
    this.closed(closed, { origin, text }, text, language, true);
  }

  /**
   * A sentence of the speaker's leg, closed (`leakCheck`): the other side's sound come back through the loudspeakers
   * is taken off the screen and not translated; the user's own goes on. While another leg was hearing something as
   * its stretch began, that leg's writing is waited for a little (`HEARD_LEAK_ASKS`); with no other leg hearing
   * anything, nothing waits.
   */
  private settleLeak(mine: Heard, closed: { ref: Ref; origin?: string }, source: { origin?: string; text: string } | undefined, text: string, language: string | undefined, asksLeft: number): void {
    if (this.ended) return;
    const there = this.heardElsewhere(mine, text);
    if (there === 'same') {
      this.frame('in', 'speech.dropped', { reason: 'the other side, through the loudspeakers', chars: text.length });
      this.dropDraft(closed.origin ?? source?.origin);
      this.events.segmentText({ ref: closed.ref, text: '' });
      this.events.segmentClosed(closed);
      return;
    }
    if (there !== 'none' && asksLeft > 0) {
      const left = there === 'open' ? asksLeft - 1 : Math.min(asksLeft - 1, HEARD_ASK_TIMES_CLOSED - 1);
      this.request.clock.setTimeout(() => this.settleLeak(mine, closed, source, text, language, left), HEARD_ASK_EVERY_MS);
      return;
    }
    this.closed(closed, source, text, language, true);
  }

  /** The stretch this leg heard last: the one a sentence closing now is of. */
  private lastHeard(): Heard | undefined {
    for (let i = heardLately.length - 1; i >= 0; i--) if (heardLately[i].leg === this) return heardLately[i];
    return undefined;
  }

  /**
   * Whether this leg closes a stretch's finished sentences as they come: one that translates what it hears. A coached
   * speaker's stretch is answered whole — the feedback is on what they said, and whether it was their own voice is
   * asked of the stretch (`settleOwn`) — and a leg with no stage of its own is answered by its session.
   */
  private cutsSentences(): boolean {
    const speech = this.stages.speech;
    return !!speech && speech.kind !== 'coach' && !this.stages.feedback && this.stages.whole !== true && !this.requiresLanguage;
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
  private heardSoFar(ref: Ref, source: { origin?: string; text: string; language?: string }, language: string | undefined): void {
    const { clock } = this.request;
    let cut = this.cuts.get(ref);
    if (!cut) {
      // Until its first sentence is closed, what is left of the stretch is all of it: the inner session's own segment.
      cut = { done: '', rest: { ref, origin: source.origin }, waiting: null };
      this.cuts.set(ref, cut);
    }
    cut.language = language;
    cut.said = source.language;
    const rest = source.text.slice(restFrom(source.text, cut.done));
    const end = cutAt(rest);
    // Fork: a sentence the recognizer will read again when the stretch ends (`misheard`) is not closed before that.
    if (end >= 0 && !this.misheard(rest.slice(0, end))) {
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
    const language = this.pieceLanguage(cut, sentence);
    this.events.segmentText({ ref: shown.ref, text: sentence, ...(language ? { language } : {}) });
    this.frame('in', 'speech.sentence', { chars: sentence.length });
    cut.done = source.text.slice(0, upTo);
    cut.rest = null;
    cut.waiting = null;
    this.closed({ ref: shown.ref, origin }, { origin, text: sentence }, sentence, language === AUTO ? undefined : language);
  }

  /**
   * The language of a piece of a stretch: a sentence closed from it, or what is left after one. A speaker who goes
   * from one language into another without a pause is one stretch, and the stretch has one language — the
   * recognizer's, or what most of its writing shows — which is not that of each sentence in it (a Chinese sentence
   * before a Japanese one went to be translated out of Japanese). So a piece is read by its own writing first, where
   * the writing itself settles it; then by what the recognizer said of the stretch; then by what the piece's text
   * suggests. Until a sentence is closed, the stretch is its own one piece, and keeps its language.
   */
  private pieceLanguage(cut: Cut, text: string): string | undefined {
    if (this.stages.heard === AUTO) {
      const written = this.written(text);
      return (written?.sure ? written.language : undefined) ?? cut.said ?? written?.language ?? AUTO;
    }
    // Told its language: in the leg's other one where the writing says so, as a stretch closed whole is asked.
    return this.otherThanHeard(text) ?? cut.said ?? this.stages.heard;
  }

  /** What is left of a stretch, as it now reads: in its segment, opened when there first is something to show. */
  private sayRest(cut: Cut, rest: string): void {
    const text = cut.done ? rest.trimStart() : rest;
    // A mark or two is not yet something to open a segment for.
    if (!cut.rest && letters(text) === 0) return;
    const language = cut.done ? this.pieceLanguage(cut, text) : cut.language;
    const shown = this.restOf(cut);
    this.events.segmentText({ ref: shown.ref, text, ...(language ? { language } : {}) });
    this.draft(shown.origin, text, language);
  }

  /**
   * Fork: a sentence still being said, translated as far as it goes (`TextStage.revise`): asked each time it reads
   * otherwise, one request at a time and only the newest text after it, each told the last one's text and answer.
   * Nothing is said of a request that fails: the sentence is translated when it closes, as every sentence is.
   */
  private draft(origin: string | undefined, text: string, language: string | undefined): void {
    const stage = this.stages.speech;
    const revise = stage?.revise;
    if (!stage || !revise || origin === undefined || this.ended) return;
    // Its language: the leg's, or — left to be detected — this sentence's own, where the model was taught it.
    const from = revise.source ?? reviseLanguage(language);
    if (!from) return;
    // Already in the reader's language: nothing translates it (`closed`).
    if (language && language !== AUTO && baseOf(language) === baseOf(this.request.context.direction.target)) return;
    let draft = this.drafts.get(origin);
    // Taken back to nothing, or to a word: what was asked and shown of it goes, and it is asked afresh when it grows.
    if (letters(text) < DRAFT_LEAST) {
      if (draft) this.blankDraft(draft);
      return;
    }
    // Fork: in another language of the speaker's than the leg's: another stage answers it when it closes (`backFor`).
    if (this.backFor(text, language === AUTO ? undefined : language)) {
      if (draft) this.blankDraft(draft);
      return;
    }
    if (!draft) {
      draft = { ref: ++this.refs, opened: false, shown: '', source: '', translation: '', controller: null, asking: null, next: null, taken: false };
      this.drafts.set(origin, draft);
    }
    // Compared with the newest text there is — waiting, under way, or answered — not with the last one answered: a
    // recognizer that takes a word back to what it read before is asked about that again.
    const now = text.trim();
    if (now === (draft.next?.text ?? draft.asking ?? draft.source)) return;
    draft.next = { text: now, from };
    this.askDraft(origin, draft, stage, revise.target);
  }

  private askDraft(origin: string, draft: Draft, stage: TextStage, into: string): void {
    if (draft.controller || draft.taken || !draft.next || this.ended) return;
    const { text, from } = draft.next;
    draft.next = null;
    const controller = new AbortController();
    draft.controller = controller;
    draft.asking = text;
    const before = draft.source && text.length >= DRAFT_CUT * draft.source.length ? { source: draft.source, translation: draft.translation } : undefined;
    const { glossary } = this.request.config;
    const told = glossary ? normalizeRecognitionText(text, glossary) : text;
    void this.whereOf(stage)
      .then(({ base, key }) => completeText(
        { url: chatUrl(base), model: stage.model, ...(key ? { key } : {}), system: '', ...(stage.extra ? { extra: stage.extra } : {}), user: reviseRequest({ source: from, target: into }, told, before) },
        { fetch: this.doFetch, clock: this.request.clock, signal: controller.signal },
      ))
      .then((answer) => {
        if (this.ended || draft.taken || controller.signal.aborted) return;
        draft.source = text;
        // An empty answer is the model waiting for more of the sentence: what shows stays.
        const translation = tidyAnswer('translate', answer.text);
        if (!translation) return;
        draft.translation = translation;
        if (!draft.opened) {
          this.events.segmentOpened({ ref: draft.ref, side: 'translation', purpose: 'translation', origin });
          draft.opened = true;
        }
        if (translation === draft.shown) return;
        draft.shown = translation;
        this.events.segmentText({ ref: draft.ref, text: translation, ...(stage.language ? { language: stage.language } : {}) });
      }, () => undefined)
      .finally(() => {
        if (draft.controller === controller) { draft.controller = null; draft.asking = null; }
        this.askDraft(origin, draft, stage, into);
      });
  }

  /** What was asked and shown of a sentence so far is put away; the sentence stays open, and may be asked about again. */
  private blankDraft(draft: Draft): void {
    draft.controller?.abort(new Error('the text was taken back'));
    draft.controller = null;
    draft.asking = null;
    draft.next = null;
    draft.source = '';
    draft.translation = '';
    if (!draft.shown) return;
    draft.shown = '';
    this.events.segmentText({ ref: draft.ref, text: '' });
  }

  /** The sentence closed and is translated whole: its segment, where one was opened, is that translation's from here on. */
  private takeDraft(origin: string | undefined): Draft | undefined {
    const draft = origin === undefined ? undefined : this.drafts.get(origin);
    if (!draft || origin === undefined) return undefined;
    this.drafts.delete(origin);
    draft.taken = true;
    draft.controller?.abort(new Error('the sentence closed'));
    return draft.opened ? draft : undefined;
  }

  /** The sentence is not translated after all (dropped, in the reader's own language, another stage's): what was shown of it goes. */
  private dropDraft(origin: string | undefined): void {
    const draft = this.takeDraft(origin);
    if (!draft) return;
    this.events.segmentText({ ref: draft.ref, text: '' });
    this.events.segmentClosed({ ref: draft.ref });
  }

  /** A source sentence, closed: said so, and handed to what answers it. `language`: what the recognizer said it heard it in. */
  private closed(payload: { ref: Ref; origin?: string }, source: { origin?: string; text: string } | undefined, text: string | undefined, language?: string, settled = false): void {
    // The other side's sound, come back through the loudspeakers into the microphone: asked of every sentence, as it
    // closes, whether a stretch closed at its end or one closed from it as it came.
    if (!settled && this.stages.leakCheck && text) {
      const mine = this.lastHeard();
      if (mine) { this.settleLeak(mine, payload, source, text, language, HEARD_LEAK_ASKS); return; }
    }
    const coached = this.stages.speech?.kind === 'coach';
    // Failed paired recognition must not seal a provisional guess as final text that the chatbox could send.
    if (this.requiresLanguage && !language) {
      this.dropDraft(payload.origin ?? source?.origin);
      this.events.segmentText({ ref: payload.ref, text: '' });
      this.events.segmentClosed(payload);
      return;
    }
    this.events.segmentClosed(payload);
    const other = text !== undefined ? this.otherThanHeard(text, language) : undefined;
    // Fork: a speaker who speaks both said this one in the other side's language: it is translated into their own.
    const backward = text !== undefined ? this.backFor(text, language) : undefined;
    // What was said in the reader's own language needs no translating: detected, or told another and written in theirs.
    const { source: from, target: into } = this.request.context.direction;
    const already = !backward && !coached && text !== undefined && (other !== undefined || (this.stages.heard === AUTO && baseOf(from) !== baseOf(into) && (language ? baseOf(language) : this.byWriting(text)) === baseOf(into)));
    // A coached speaker who says a sentence in their own language is not practising with it: it is translated, as what
    // they type is, and not sent for feedback. No translation in this run: it is shown as said.
    const stage = backward ?? (coached && other !== undefined ? this.stages.typed : this.stages.speech);
    // Fork: what was written of it while it was said (`draft`) is the speech stage's: any other outcome takes it away.
    if (!(source && text && stage && !already && stage === this.stages.speech)) this.dropDraft(payload.origin ?? source?.origin);
    if (source && text && stage && !already) {
      // A translation is told the sentence before, where its model takes one: what this side said last, not long ago.
      const now = this.request.clock.now();
      const before = stage.kind === 'translate' && this.said && now - this.said.at <= BEFORE_WITHIN_MS ? this.said.text.slice(-BEFORE_MOST) : undefined;
      if (stage.kind === 'translate') this.said = { text, at: now };
      this.push({ stage, text, origin: payload.origin ?? source.origin, typed: false, ...(before ? { before } : {}) });
      if (stage === this.stages.speech) this.alsoInto(text, payload.origin ?? source.origin, false, before);
    }
    const feedback = this.stages.feedback;
    if (source && text && feedback) {
      const spoken = language ? baseOf(language) : oneOfTwo(text, this.request.context.direction.source, feedback.language);
      if (spoken === baseOf(feedback.language)) this.push({ stage: feedback.stage, text, origin: payload.origin ?? source.origin, typed: false });
    }
  }

  /** Fork: a sentence translated forward is translated into the other side's second language too (`Stages.into`). */
  private alsoInto(text: string, origin: string | undefined, typed: boolean, before?: string): void {
    const into = this.stages.into;
    if (!into || this.stages.speech?.kind !== 'translate') return;
    this.push({ stage: into, text, origin, typed, ...(before ? { before } : {}) });
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
  private heardElsewhere(mine: Heard, text: string = mine.text): 'same' | 'open' | 'other' | 'none' {
    forgetHeard(this.request.clock.now());
    const there = heardLately.filter((h) => h.leg !== this && mine.from >= h.from - HEARD_SLACK_MS && (h.until === null || mine.from <= h.until - HEARD_TRAIL_MS));
    if (there.length === 0) return 'none';
    if (sameSpeech(text, there.map((h) => h.text).join(' '))) return 'same';
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
  /**
   * Fork: the stage that answers a sentence in the other side's language, of a speaker who speaks both; else
   * undefined. In that language as the recognizer heard it, where it says (the Mac's, hearing both); else as its
   * writing shows — which a few Han characters between Chinese and Japanese do not.
   */
  private backFor(text: string, language?: string): AnswerStage | undefined {
    const back = this.stages.back;
    if (!back) return undefined;
    // Fork: of the languages they speak besides their own, any (`languages`); else the one.
    const spoken = back.languages?.length ? back.languages : [back.language];
    const said = language ? baseOf(language) : this.byWriting(text);
    if (!said || !spoken.some((one) => baseOf(one) === baseOf(said))) return undefined;
    // Fork: into the other lit language of theirs, where it is one of two; else back into their own.
    return this.stages.cross?.find((c) => baseOf(c.language) === baseOf(said))?.stage ?? back.stage;
  }

  /** The language a sentence of a leg left to detect it is written in: of a speaker who speaks both, one of the two. */
  private byWriting(text: string): string | undefined {
    return this.written(text)?.language;
  }

  /** The same, with whether the writing itself names the language (`sure`) or the small detector's statistics do. */
  private written(text: string): { language: string; sure: boolean } | undefined {
    const back = this.stages.back;
    // The writing first; a small text detector for the pairs it cannot tell apart (English/French, Spanish/Portuguese).
    const found = identifyLanguage(text, back ? [back.own, ...(back.languages?.length ? back.languages : [back.language])] : []);
    if (!found) return undefined;
    // Han characters are Chinese's and Cantonese's alike: spoken Cantonese written down has words of its own.
    return { language: found.language === 'zh' && writtenInCantonese(text) ? 'yue' : found.language, sure: found.source === 'script' };
  }

  /** Whether a leg left to detect its language may be in `language`: among its others, or any where none are named. */
  private mayBeIn(language: string): boolean {
    const back = this.stages.back;
    const among = back ? [back.own, ...(back.languages?.length ? back.languages : [back.language])] : [];
    return among.length === 0 || among.some((one) => one === AUTO || baseOf(one) === baseOf(language));
  }

  /**
   * Fork: written in a script of none of the languages the leg is named among (`namedAmong`, `hearingPlan.ts`): a
   * mishearing, which the recognizer reads again when the stretch ends.
   */
  private misheard(text: string): boolean {
    const back = this.stages.back;
    if (!back || this.stages.heard !== AUTO) return false;
    const among = [back.own, ...(back.languages?.length ? back.languages : [back.language])];
    return !among.includes(AUTO) && writtenOutside(text, among);
  }

  private otherThanHeard(text: string, language?: string): string | undefined {
    const speech = this.stages.speech;
    if (!speech || this.stages.heard === AUTO) return undefined;
    const { source, target } = this.request.context.direction;
    // A requested conversion between variants of one language still needs its translation stage.
    if (speech.kind === 'translate' && baseOf(source) === baseOf(target)) return undefined;
    const other = speech.kind === 'coach' ? source : target;
    // Fork: the language the recognizer says it heard (the Mac's, hearing both of the pair's): that, not the writing.
    if (language) return baseOf(language) === baseOf(other) ? other : undefined;
    if (speech.kind === 'coach') return saidInOwn(text, source, target) ? source : undefined;
    return saidInOwn(text, target, source) ? target : undefined;
  }

  private push(job: Job): void {
    this.queue.push(job);
    this.sayBusy();
    this.pump();
  }

  /** Each kind answers in source order; slow feedback does not hold up translations. */
  private pump(): void {
    if (this.ended) return;
    for (const kind of ['translate', 'coach'] as const) {
      if (this.running.has(kind)) continue;
      const index = this.queue.findIndex((job) => job.stage.kind === kind);
      if (index < 0) continue;
      const job = this.queue[index];
      const stage = job.stage;
      this.queue.splice(index, 1);
      const controller = new AbortController();
      this.running.set(kind, { controller, stage });
      void this.answer(job, controller.signal).finally(() => {
        if (this.running.get(kind)?.controller === controller) this.running.delete(kind);
        if (this.ended) return;
        this.sayBusy();
        this.pump();
      });
    }
  }

  private async answer(job: Job, signal: AbortSignal): Promise<void> {
    const { stage } = job;
    // Fork: written while it was said (`draft`): the whole translation takes that segment, and shows when it is whole —
    // written a word at a time over it, the sentence shown would shrink to its first word and grow again.
    const draft = stage === this.stages.speech && !job.typed ? this.takeDraft(job.origin) : undefined;
    const ref = draft?.ref ?? ++this.refs;
    let opened = draft !== undefined;
    let shown = draft?.shown ?? '';
    const show = (text: string) => {
      if (this.ended || !text || text === shown) return;
      if (!opened) {
        this.events.segmentOpened({
          ref, side: 'translation', purpose: stage.kind === 'coach' ? 'feedback' : 'translation',
          ...(stage.kind === 'coach' && this.stages.feedback ? { accompaniesTranslation: true as const } : {}),
          ...(job.origin !== undefined ? { origin: job.origin } : {}),
        });
        opened = true;
      }
      shown = text;
      this.events.segmentText({ ref, text, ...(stage.language ? { language: stage.language } : {}) });
    };
    const where = stage.phone ? { phone: true } : {};
    this.frame('out', 'text.request', { stage: stage.kind, model: stage.model, chars: job.text.length, ...where });
    try {
      const answer: { text: string; firstMs?: number; totalMs: number; model?: string } = await this.complete(stage, job.text, signal, draft ? () => undefined : show, job.before);
      if (this.ended) return;
      const final = tidyAnswer(stage.kind, answer.text);
      show(final);
      // `served`: the model that answered, where the server says (another Kotomimi chooses a blank one itself).
      this.frame('in', 'text.done', { stage: stage.kind, model: stage.model, served: answer.model ?? stage.model, firstMs: answer.firstMs ?? null, totalMs: answer.totalMs, chars: final.length, ...where });
      if (opened) this.events.segmentClosed({ ref });
      // A model that said nothing: feedback with nothing to say is no fault; a translation with none is — also where
      // what was written while the sentence was said stays in its place.
      if (stage.kind === 'translate' && (!opened || !final)) this.unanswered(job, 'the model answered with no text');
    } catch (error) {
      if (this.ended) return;
      if (opened) this.events.segmentClosed({ ref });
      this.frame('in', 'text.failed', { stage: stage.kind, model: stage.model, message: describeCause(error), ...where });
      this.unanswered(job, describeCause(error), error);
    }
  }

  /** Where a stage is asked now, and with what key. */
  private async whereOf(stage: TextStage): Promise<{ base: string; key?: string }> {
    const { credentials } = this.request;
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
    return { base, ...(key ? { key } : {}) };
  }

  /** A text model's answer, shown as it is written. */
  private async complete(stage: TextStage, heard: string, signal: AbortSignal, show: (text: string) => void, before?: string): Promise<{ text: string; firstMs?: number; totalMs: number; model?: string }> {
    const { clock } = this.request;
    const { base, key } = await this.whereOf(stage);
    // A term written right is kept by the model unprompted; written wrong, it is translated as what it sounds like.
    // Feedback is given on the sentence as it is shown, its names put right too: it judged a misheard name as the
    // user's mistake.
    const { glossary } = this.request.config;
    const text = glossary ? normalizeRecognitionText(heard, glossary) : heard;
    return completeText(
      {
        url: chatUrl(base),
        model: stage.model,
        ...(key ? { key } : {}),
        system: stage.wrap ? '' : stage.system,
        ...(stage.shots?.length ? { shots: stage.shots } : {}),
        ...(stage.pair ? { pair: stage.pair, ...(before ? { previous: before } : {}) } : {}),
        ...(stage.extra ? { extra: stage.extra } : {}),
        ...(stage.phone || stage.loads ? { timeoutMs: PHONE_TEXT_TIMEOUT_MS, busyRetries: PHONE_BUSY_RETRIES } : {}),
        // A function, so that nothing in the sentence is read as a pattern.
        user: stage.wrapAfter && before
          ? stage.wrapAfter.replace(BEFORE_SLOT, () => before).replace(TEXT_SLOT, () => text)
          : stage.wrap ? stage.wrap.replace(TEXT_SLOT, () => text) : text,
      },
      { fetch: this.doFetch, clock, signal, onText: (shown) => show(tidyAnswer(stage.kind, shown)) },
    );
  }

  /** A source left without its answer: the session goes on, and says so. */
  private unanswered(job: Job, why: string, cause?: unknown): void {
    const what = job.stage.kind === 'coach' ? 'The feedback model' : 'The translation model';
    // A phone that has not the memory for the model refuses it so (503, `Share.ensure`): said as that, where to look.
    const noRoom = job.stage.phone === true && /has not the memory/.test(why);
    this.events.degraded({
      // Each said as what it was: a sentence with no feedback, a typed sentence with no translation (which the
      // contract's `text-input-answered` wants said), a heard one with none.
      code: noRoom ? 'phone_no_memory' : job.stage.kind === 'coach' ? 'feedback_failed' : job.typed ? 'typed_translation_failed' : 'translation_failed',
      message: `${what} (${job.stage.model}) did not answer: ${why}`,
      ...(cause !== undefined ? { cause } : {}),
    });
  }

  private sayBusy(): void {
    const busy = this.innerBusy || this.running.size > 0 || this.queue.length > 0;
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
  // A model that cannot name a language is told the leg's own source; the sentence's writing names the rest.
  const told = device.language ?? heard;
  return {
    // A recognizer hearing either of two is told the first: "detect it" is no language to it.
    context: { ...request.context, direction: { source: baseOf(device.native?.either?.first ?? told ?? source), target: baseOf(told ? source : target) }, speech: false },
    config: { asr: { modelId: device.modelId, streaming: device.streaming }, vad: device.vad, translation: { kind: 'none' } },
    credentials: {},
    clock: request.clock,
    signal: request.signal,
  };
}

/** How long the last words of a stretch are waited for from an engine on another device. */
const REMOTE_LAST_WORDS_MS = 60_000;

export function createPipelineAdapter(deps: Partial<PipelineDeps> = {}): Adapter<PipelineConfig, PipelineCredentials> {
  const realtime = createRealtimeAdapter(deps.openSocket ? { openSocket: deps.openSocket } : {});
  // The reused audio adapter only transcribes; text and speech synthesis have no local worker.
  const engines: Omit<LocalEngines, 'asr'> = {
    translation: () => { throw new Error('The pipeline has no app-model translator.'); },
    tts: () => { throw new Error('The pipeline has no app-model speech synthesizer.'); },
  };
  /** What hears on this computer: its own recognizer, or — the same adapter with that one engine changed — an API's. */
  const hearing = (device: DeviceHearing, request: StartRequest<PipelineConfig, PipelineCredentials>, onPhone: (base: string) => void, heard: string | undefined, onPaired: () => void) => {
    const { api, native } = device;
    if (native) {
      const start = deps.native?.start ?? ((model: string) => askNativeEngine('start', model));
      return createLocalInferenceAdapter({ ...engines, asr: () => createNativeAsr({ bridge: deps.native?.bridge ?? ipcNativeBridge, start: () => start(native.model), model: native.model, clock: request.clock, ...(native.hints?.length ? { hints: native.hints } : {}), ...(native.limits ? { limits: native.limits } : {}), ...(native.either ? { also: native.either.also } : {}), ...(device.among?.length ? { among: device.among } : {}) }) });
    }
    if (!api) throw new Error('Recognition requires a native engine or an API.');
    const key = api.key ? request.credentials[api.key] : undefined;
    const asked = deps.fetch ?? fetchNow;
    const byApi = () => createApiAsr({ baseUrl: api.baseUrl, model: api.model, ...(key ? { key } : {}), fetch: asked, clock: request.clock, ...(device.among?.length ? { among: device.among } : {}) });
    // The address may be a Kotomimi phone lending its engine: that is read as this computer's own engine is, while
    // the voice is heard, not a sentence at a time. Asked as the run begins, up to three times — a device just woken,
    // or a busy Wi-Fi, may not answer the first in time, and the plain API it otherwise falls to for the whole run
    // has no words to expect, no filters and no partial text; anything that is no phone is the API named.
    const remote = deps.remote ?? { node: (baseUrl: string) => engineNode(baseUrl, asked, key || phoneKey(baseUrl) || undefined), bridge: remoteBridge };
    return createLocalInferenceAdapter({
      ...engines,
      asr: () => createEitherAsr(async () => {
        let node = await remote.node(api.baseUrl);
        for (let again = 0; !node && again < 2; again++) node = await remote.node(api.baseUrl);
        if (!node) return byApi();
        onPhone(api.baseUrl);
        // The model chosen here, where the device has it and can be asked for it by name (the iPad app); else the one
        // the phone lends now, whatever was written down when it was chosen: its owner may have changed it.
        const model = api.model && (node.hears ?? []).includes(api.model) ? api.model : node.model || api.model;
        const lent: NativeEngineStatus = { ...NO_NATIVE_ENGINE, run: { state: 'ready', model, port: 0, tail: '' }, up: [model] };
        // Its last words are waited for as long as a reading may take there (`READ_TIMEOUT_MS` in
        // `electron/remote-engine.js`): a phone slower than the voice still writes all of it, late, where the wait
        // this computer's own engine is given would have kept only what the first reading had (seen 2026-10-10 on a
        // phone at half the speed of speech: "ゲームは、 like" for twenty seconds of talk).
        // The device's own recognition, heard while it is spoken (the iPad's): streamed to it as the voice comes, as
        // this computer's Mac hears with its own, and — where it has both of the pair's languages — in either of them,
        // as the Mac's does (`appleAlso`): a sentence in the other is known for what it is, not guessed from its writing.
        const live = node.live && node.live.model === model ? node.live : undefined;
        const told = hearingRequest(request, device, heard).context.direction.source;
        // Only where the leg's language is left open (a speaker who speaks both, the other side detected): the iPad
        // runs two recognizers at once, so two languages take its slower, careful one's place, and every sentence
        // would be heard a little worse for a label (`Recognizers` in ios/KotomimiNode/Hearing/Live.swift). The Mac
        // pairs every leg where it has both; this is where the two differ, on purpose.
        const requested = device.pairedWith?.[0];
        const primary = baseOf(told);
        const also = live && heard === AUTO && requested && live.languages.some((language) => baseOf(language) === primary) && live.languages.some((language) => baseOf(language) === baseOf(requested)) ? requested : undefined;
        if (also) onPaired();
        const limits = recognitionLimits(model, live ? told : undefined);
        return createNativeAsr({ bridge: remote.bridge(api.baseUrl, live ? { streamed: true } : {}), start: async () => lent, model, clock: request.clock, named: 'The recognition engine of the other device', limits: { ...(limits ?? api.limits), lastWordsMs: REMOTE_LAST_WORDS_MS }, ...(api.hints?.length ? { hints: api.hints } : {}), ...(also ? { also: [also] } : {}), ...(device.among?.length ? { among: device.among } : {}) });
      }),
    });
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
      if (!device && (!stages || (!stages.speech && !stages.typed && !stages.asIs))) return realtime.start(dialled(request), events);
      const leg = new PipelineLeg(request, stages ?? { speech: null, typed: null }, events, deps.fetch ?? fetchNow, deps.native?.base ?? engineBaseNow);
      let session: AdapterSession;
      try {
        session = await (device ? hearing(device, request, (base) => leg.watchPhone(base), stages?.heard, () => leg.pairedHearing()).start(hearingRequest(request, device, stages?.heard), leg.inner) : realtime.start(dialled(request), leg.inner));
      } catch (error) {
        leg.abandon();
        throw error;
      }
      return leg.attach(session);
    },
  };
}
