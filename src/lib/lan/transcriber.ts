/**
 * Fork: one Realtime socket of a Kotomimi sharing its models — the server's
 * side of a transcription session. The caller appends audio; one of this
 * computer's recognizers, with its own turn detection, hears it; what it
 * writes goes back as the GA events a Realtime client reads: speech started
 * and stopped, the item committed, its transcript as deltas and then whole.
 *
 * Only that. No response is ever made here: a client asks for translations
 * over chat (`translator.ts`), and one that asks this socket for a response
 * is told so. Driven entirely by what it is handed — the socket's messages
 * in, `send` and `close` out — so its tests need no socket and no model.
 */
import type { Clock } from '../contract/clock';
import { SAMPLE_RATE } from '../contract/adapter';
import { base64ToPcm } from '../contract/pcm64';
import type { VadWebConfig } from '../local-inference/types';
import { baseLanguage, LAN_PIPELINE, wireError } from './protocol';

/** The recognizer as the sharing host drives it: `src/providers/localInference/engines.ts`'s `AsrLike`, named here so `lib` imports no provider. */
export interface Recognizer {
  init(modelId: string, options: { vadConfig: VadWebConfig; language: string; punctuationEndpoint?: boolean }): Promise<void>;
  feedAudio(samples: Int16Array, sampleRate: number): void;
  flush(): void;
  dispose(): void;
  onPartialResult: ((text: string) => void) | null;
  onResult: ((result: { text: string; durationMs: number; recognitionTimeMs: number }) => void) | null;
  onSpeechStart: (() => void) | null;
  onError: ((error: string) => void) | null;
  onFatal: ((error: string) => void) | null;
}

export interface TranscriberDeps {
  /** A recognizer for this model: the app's own engine, a fake in tests. */
  recognizer(model: { modelId: string; streaming: boolean }): Recognizer;
  /** The model for a language: the one named when it is shared and hears that language, else the best shared. Null: none. */
  resolve(language: string, wanted: string): { modelId: string; streaming: boolean } | null;
  send(event: Record<string, unknown>): void;
  close(code: number, reason: string): void;
  clock: Clock;
}

/** Audio that arrives while the model loads is kept, up to this much: a minute at 24 kHz. */
const MAX_HELD_SAMPLES = SAMPLE_RATE * 60;
/** After a clear, a result that comes within this long is the cleared audio's, and is dropped. */
const CLEAR_WINDOW_MS = 2000;

/** This computer's turn detection, as the app's own defaults have it (`LOCAL_INFERENCE_DEFAULTS`). */
const DEFAULT_VAD: VadWebConfig = { threshold: 0.3, minSilenceDuration: 1.4, minSpeechDuration: 0.4, maxSpeechDuration: 30 };

/** How long a pause ends a turn, by the eagerness a client's semantic detection asks for: the closest this detection has. */
const EAGERNESS_SILENCE: Readonly<Record<string, number>> = { low: 2, medium: 1.4, auto: 1.4, high: 0.8 };

/**
 * A client's `turn_detection` as this computer's knobs. Server VAD's
 * threshold and silence carry over; semantic detection, which nothing here
 * can do, becomes a pause length by its eagerness; none at all (a client
 * that commits its own turns) keeps the defaults — the commit flushes.
 */
export function vadFrom(turnDetection: unknown): VadWebConfig {
  const d = (turnDetection ?? {}) as { type?: unknown; threshold?: unknown; silence_duration_ms?: unknown; eagerness?: unknown };
  if (d.type === 'server_vad') {
    return {
      ...DEFAULT_VAD,
      ...(typeof d.threshold === 'number' && d.threshold > 0 && d.threshold < 1 ? { threshold: d.threshold } : {}),
      ...(typeof d.silence_duration_ms === 'number' && d.silence_duration_ms >= 100 ? { minSilenceDuration: Math.min(5, d.silence_duration_ms / 1000) } : {}),
    };
  }
  if (d.type === 'semantic_vad') return { ...DEFAULT_VAD, minSilenceDuration: EAGERNESS_SILENCE[String(d.eagerness ?? 'auto')] ?? DEFAULT_VAD.minSilenceDuration };
  return DEFAULT_VAD;
}

interface Item { id: string; sent: string; committed: boolean; /** The hypothesis before this one. */ last: string }

/**
 * What two hypotheses in a row have in common from their start, without the
 * punctuation and space it ends with: the part a recognizer that reads a
 * stretch again and again is not likely to write otherwise the next time. The
 * mark a hypothesis ends with is the first thing the next one changes.
 */
export function agreed(before: string, now: string): string {
  let n = 0;
  while (n < before.length && n < now.length && before[n] === now[n]) n += 1;
  // Never half of a character written in two units.
  if (n > 0 && n < now.length && /[\uD800-\uDBFF]/.test(now[n - 1])) n -= 1;
  return now.slice(0, n).replace(/[\s\p{P}]+$/u, '');
}

export class LanTranscriber {
  private engine: Recognizer | null = null;
  /** The engine has loaded: audio goes to it. */
  private ready = false;
  /** What the running engine was started with: a second `session.update` that asks the same starts nothing again. */
  private running = '';
  private held: Int16Array[] = [];
  private heldSamples = 0;
  /** A turn was ended while the model loaded: it ends once the held audio has been fed. */
  private commitWhenReady = false;
  private items = 0;
  private item: Item | null = null;
  private clearedAt = Number.NEGATIVE_INFINITY;
  private ended = false;

  constructor(
    private readonly deps: TranscriberDeps,
    private readonly sessionId: string,
    /** The model the socket was dialled with: the pipeline's name, or one recognizer's. */
    private readonly dialled: string,
  ) {}

  /** The socket is open: the session is announced, as every Realtime server announces one. */
  open(): void {
    this.deps.send({ type: 'session.created', session: { id: this.sessionId, object: 'realtime.session', type: 'transcription', model: this.dialled || LAN_PIPELINE } });
  }

  receive(data: string): void {
    if (this.ended) return;
    let e: { type?: unknown; session?: unknown; audio?: unknown };
    try {
      e = JSON.parse(data) as typeof e;
    } catch {
      this.error('invalid_json', 'The message is not JSON.');
      return;
    }
    switch (e.type) {
      case 'session.update': return this.configure(e.session);
      case 'input_audio_buffer.append': return this.append(e.audio);
      case 'input_audio_buffer.commit': return this.commit();
      case 'input_audio_buffer.clear': return this.clear();
      case 'response.create':
      case 'conversation.item.create':
        return this.error('transcription_only', 'This Kotomimi only transcribes in its socket: ask it for a translation over /v1/chat/completions.');
      default:
        // Anything else a client may send (a cancel, a truncate) has nothing to act on here.
    }
  }

  /** The socket closed, or sharing stopped: the model is let go. */
  dispose(): void {
    this.ended = true;
    this.engine?.dispose();
    this.engine = null;
    this.held = [];
  }

  private configure(session: unknown): void {
    const input = ((session ?? {}) as { audio?: { input?: { transcription?: { language?: unknown; model?: unknown }; turn_detection?: unknown } } }).audio?.input ?? {};
    const language = baseLanguage(input.transcription?.language);
    // "auto" is a language here: answered by a recognizer that tells languages apart, where one is shared (`nativeShare.ts`).
    if (!language) return this.error('language_required', 'Say which language is spoken, or "auto" to have it detected (audio.input.transcription.language).');
    const named = typeof input.transcription?.model === 'string' ? input.transcription.model : '';
    const wanted = named || (this.dialled !== LAN_PIPELINE ? this.dialled : '');
    const model = this.deps.resolve(language, wanted);
    if (!model) return this.error('model_not_found', `This Kotomimi shares no speech recognition model for "${language}".`);
    const vad = vadFrom(input.turn_detection);
    const asked = JSON.stringify([model.modelId, language, vad]);
    if (asked !== this.running) this.start(model, language, vad, asked);
    this.deps.send({
      type: 'session.updated',
      session: { id: this.sessionId, object: 'realtime.session', type: 'transcription', audio: { input: { transcription: { model: model.modelId, language }, turn_detection: input.turn_detection ?? null } } },
    });
  }

  /** Loads the model. The session is confirmed at once and the audio held meanwhile: a large model can take longer to load than a client waits for its confirmation. */
  private start(model: { modelId: string; streaming: boolean }, language: string, vad: VadWebConfig, asked: string): void {
    this.engine?.dispose();
    this.ready = false;
    this.commitWhenReady = false;
    this.running = asked;
    this.item = null;
    const engine = this.deps.recognizer(model);
    this.engine = engine;
    const mine = () => this.engine === engine && !this.ended;
    engine.onSpeechStart = () => { if (mine()) this.speechStarted(); };
    engine.onPartialResult = (text) => { if (mine()) this.partial(text); };
    engine.onResult = (result) => { if (mine()) this.final(result.text); };
    engine.onError = (message) => { if (mine()) this.failed(message); };
    engine.onFatal = (message) => {
      if (!mine()) return;
      this.error('server_error', `Speech recognition stopped: ${message}`);
      this.end(1011, 'speech recognition stopped');
    };
    engine.init(model.modelId, { vadConfig: vad, language, punctuationEndpoint: true }).then(
      () => {
        if (!mine()) { engine.dispose(); return; }
        this.ready = true;
        for (const samples of this.held) engine.feedAudio(samples, SAMPLE_RATE);
        this.held = [];
        this.heldSamples = 0;
        if (this.commitWhenReady) {
          this.commitWhenReady = false;
          this.commit();
        }
      },
      (cause: unknown) => {
        if (!mine()) return;
        this.error('server_error', `The speech recognition model could not load: ${cause instanceof Error ? cause.message : String(cause)}`);
        this.end(1011, 'the model could not load');
      },
    );
  }

  private append(audio: unknown): void {
    if (typeof audio !== 'string' || !this.engine) return;
    let pcm: Int16Array;
    try {
      pcm = base64ToPcm(audio);
    } catch {
      return;
    }
    if (pcm.length === 0) return;
    if (this.ready) {
      this.engine.feedAudio(pcm, SAMPLE_RATE);
      return;
    }
    // Still loading: kept, the oldest dropped once there is a minute of it.
    this.held.push(pcm);
    this.heldSamples += pcm.length;
    while (this.heldSamples > MAX_HELD_SAMPLES && this.held.length > 1) this.heldSamples -= this.held.shift()!.length;
  }

  /**
   * A client's own end of turn: a short silence, so the detection lets go,
   * then whatever is held is recognized now. A turn that ends while the model
   * is still loading ends when it has loaded, after the audio held for it: a
   * large model takes longer to load than a short sentence takes to say.
   */
  private commit(): void {
    if (!this.engine) return;
    if (!this.ready) {
      this.commitWhenReady = true;
      return;
    }
    for (let i = 0; i < 7; i += 1) this.engine.feedAudio(new Int16Array(SAMPLE_RATE / 10), SAMPLE_RATE);
    this.engine.flush();
  }

  /** A turn released without speech. The detection cannot forget what it holds, so it is flushed and its result dropped. */
  private clear(): void {
    this.clearedAt = this.deps.clock.now();
    this.commit();
    this.deps.send({ type: 'input_audio_buffer.cleared' });
  }

  private open_(): Item {
    if (!this.item) this.item = { id: `item_${this.sessionId}_${++this.items}`, sent: '', committed: false, last: '' };
    return this.item;
  }

  private speechStarted(): void {
    const item = this.open_();
    this.deps.send({ type: 'input_audio_buffer.speech_started', item_id: item.id });
  }

  /**
   * A partial is the whole hypothesis so far, and a delta can only add to what a device was shown: so what goes up is
   * what this hypothesis and the one before it agree on (`agreed`), once that is more than was sent. A recognizer
   * that only ever adds is one hypothesis behind for it; one that reads a stretch again and rewrites its end — the
   * Mac's own, Qwen3-ASR in the native engine — is shown live all the same, where before its first rewriting left the
   * device waiting for the final. What was sent and is then written otherwise waits for the final, which carries the
   * whole text.
   */
  private partial(raw: string): void {
    const text = raw.trim();
    const item = this.open_();
    const settled = agreed(item.last, text);
    item.last = text;
    if (!settled.startsWith(item.sent) || settled === item.sent) return;
    this.deps.send({ type: 'conversation.item.input_audio_transcription.delta', item_id: item.id, content_index: 0, delta: settled.slice(item.sent.length) });
    item.sent = settled;
  }

  private final(raw: string): void {
    const text = raw.trim();
    const item = this.item;
    this.item = null;
    const cleared = this.deps.clock.now() - this.clearedAt < CLEAR_WINDOW_MS;
    // Nothing heard, and nothing shown yet: this turn never was.
    if ((!text || cleared) && (!item || !item.sent)) return;
    const id = (item ?? this.open_()).id;
    this.item = null;
    this.deps.send({ type: 'input_audio_buffer.speech_stopped', item_id: id });
    this.deps.send({ type: 'input_audio_buffer.committed', item_id: id, previous_item_id: null });
    // An empty completion closes what the deltas showed as it stands.
    this.deps.send({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, content_index: 0, transcript: cleared ? '' : text });
  }

  /** One utterance could not be recognized: its item fails, and the session goes on. */
  private failed(message: string): void {
    const item = this.item;
    this.item = null;
    if (item) this.deps.send({ type: 'conversation.item.input_audio_transcription.failed', item_id: item.id, content_index: 0, error: wireError('transcription_failed', message) });
    else this.error('transcription_failed', message);
  }

  private error(code: string, message: string): void {
    this.deps.send({ type: 'error', error: wireError(code, message) });
  }

  private end(code: number, reason: string): void {
    this.dispose();
    this.deps.close(code, reason);
  }
}
