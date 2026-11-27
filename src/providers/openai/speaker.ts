/**
 * Fork: what speaks a leg's sentences (`voice.ts`), whichever way the leg is answered: by stages of its own
 * (`PipelineLeg`), or by the other device's session, which writes its translations itself (`speakingEvents`). One
 * sentence at a time, in the order they were finished. A voice that keeps up streams its sound. A slower one
 * hands on whole sentences. The oldest sentence still waiting in the same language gives way when too many wait.
 */
import { SAMPLE_RATE, type AdapterEvents, type Ref, type VoiceState } from '../../lib/contract/adapter';
import type { Clock } from '../../lib/contract/clock';
import { describeCause } from '../../lib/diagnostics/describeCause';
import { eventsFrom } from '../../lib/contract/events';
import { framePayload } from '../../lib/contract/framePayload';
import { sameSpeech } from '../../lib/language/script';
import { speakText, speaksLanguage, warmVoice, type VoiceDeps, type VoiceRequest, type VoiceStage } from './voice';

/** No more sentences than this wait, in one language, behind the one being made. */
export const SAYINGS_MOST = 2;
/** Leave a fifth of the playing time for variation between pieces. */
const STREAM_RATIO = 0.8;
/** A slow sentence keeps the next three whole while the voice earns back its margin. */
const SPEED_WINDOW = 3;

interface Saying extends VoiceRequest { ref?: Ref }

export class Speaker {
  private readonly waiting: Saying[] = [];
  private making: AbortController | null = null;
  private warming: AbortController | null = null;
  private stopped = false;
  private readonly speeds: { ratio: number; gap: boolean }[] = [];
  private slowNoticeSent = false;

  constructor(
    private readonly stage: VoiceStage,
    private readonly key: string | undefined,
    private readonly deps: Pick<VoiceDeps, 'decode' | 'native' | 'edge' | 'recording'> & { fetch: typeof fetch; clock: Clock },
    private readonly events: Pick<AdapterEvents, 'audio' | 'frame' | 'degraded' | 'voiceState'>,
    /**
     * Told each sentence when its first sound is handed on, with when it will start playing (the clock's ms).
     * What it returns is told how far the sound handed on will play.
     * For whoever must know what the app itself is saying (`PipelineLeg`: its own voice come back through the
     * microphone is no sentence of the user's).
     */
    private readonly saying?: (text: string, from: number) => (until: number) => void,
  ) {}

  /** When what has been handed on so far will have been heard to its end: sentences play one after another. */
  private heardUntil = 0;
  private recent: { text: string; until: number }[] = [];

  /** A sentence to be spoken: on the translation's own segment, or — `ref` absent — on none (what the speaker typed, said as it is). One in a language the voice cannot speak is passed over. */
  say(ref: Ref | undefined, text: string, language: string, tone?: string): void {
    if (this.stopped || !speaksLanguage(this.stage, language)) return;
    // A server that writes its own translations cannot retract a captured echo. Keep the row, but don't voice it again.
    if (!this.saying) {
      const since = this.deps.clock.now() - 10_000;
      this.recent = this.recent.filter((one) => one.until > since);
      if (this.recent.some((one) => sameSpeech(text, one.text))) {
        this.state(ref, 'dropped');
        return;
      }
    }
    this.waiting.push({ ...(ref !== undefined ? { ref } : {}), text, language, tone });
    this.state(ref, 'waiting');
    // A sentence put into two languages waits twice: each language is held to its own count.
    const base = (code: string) => code.split('-')[0].toLowerCase();
    const alike = (one: Saying) => base(one.language) === base(language);
    while (this.waiting.filter(alike).length > SAYINGS_MOST) {
      const [dropped] = this.waiting.splice(this.waiting.findIndex(alike), 1);
      this.state(dropped.ref, 'dropped');
      this.frame('out', 'voice.skipped', { chars: dropped.text.length });
    }
    this.next();
  }

  /**
   * Another Kotomimi's voice engine loads its model at the first sentence asked of it: asked for now, as the leg
   * begins, and not waited for (`warmVoice`). Any other place has nothing to bring up from here.
   */
  warm(): void {
    if (this.stopped || this.warming) return;
    this.warming = new AbortController();
    void warmVoice(this.stage, this.key, this.deps, this.warming.signal);
  }

  /** Nothing more is said: the sentence being made is given up, and nothing is said of it. */
  stop(): void {
    this.stopped = true;
    this.warming?.abort();
    this.waiting.length = 0;
    this.making?.abort(new Error('the session ended'));
    this.making = null;
  }

  private next(): void {
    if (this.making || this.stopped) return;
    const saying = this.waiting.shift();
    if (!saying) return;
    const { stage } = this;
    const control = new AbortController();
    this.making = control;
    this.state(saying.ref, 'making');
    this.frame('out', 'voice.request', {
      via: stage.via, model: stage.model, language: saying.language, chars: saying.text.length,
    });
    // A held sentence goes to playback in one piece, so the queue has no gap to fill within it.
    const hold = this.speeds.some(({ ratio, gap }) => ratio > STREAM_RATIO || gap);
    const held: Int16Array[] | null = hold ? [] : null;
    if (hold && !this.slowNoticeSent) {
      this.slowNoticeSent = true;
      this.events.degraded({
        code: 'tts_slow',
        message: `Speech synthesis (${stage.model}) fell behind, so playback is buffering whole sentences.`,
      });
    }
    let clip: { text: string; until: number } | undefined;
    let heard: ((until: number) => void) | undefined;
    const handOn = (pcm: Int16Array, from: number, until: number) => {
      if (!clip) {
        clip = { text: saying.text, until };
        heard = this.saying?.(saying.text, from);
        if (!this.saying) this.recent.push(clip);
      }
      this.heardUntil = clip.until = until;
      heard?.(until);
      this.events.audio({ pcm, ...(saying.ref !== undefined ? { ref: saying.ref } : {}) });
    };
    // Even while holding, measure whether these pieces could have played without a gap.
    let streamUntil: number | undefined;
    let gap = false;
    void speakText(stage, saying, this.key, this.deps, control.signal, (pcm) => {
      if (this.stopped) return;
      const now = this.deps.clock.now();
      if (streamUntil !== undefined && now > streamUntil) gap = true;
      const from = Math.max(now, streamUntil ?? this.heardUntil);
      streamUntil = from + pcm.length * 1000 / SAMPLE_RATE;
      if (held) held.push(pcm);
      else handOn(pcm, from, streamUntil);
    }).then((spoken) => {
      if (this.stopped) return;
      const audioMs = spoken.samples * 1000 / SAMPLE_RATE;
      if (spoken.firstMs !== undefined) {
        this.speeds.push({ ratio: (spoken.totalMs - spoken.firstMs) / audioMs, gap });
        if (this.speeds.length > SPEED_WINDOW) this.speeds.shift();
        if (held) {
          const whole = new Int16Array(spoken.samples);
          let at = 0;
          for (const piece of held) { whole.set(piece, at); at += piece.length; }
          const from = Math.max(this.deps.clock.now(), this.heardUntil);
          handOn(whole, from, from + audioMs);
        }
      }
      this.frame('in', 'voice.done', {
        model: stage.model, firstMs: spoken.firstMs ?? null, totalMs: spoken.totalMs, audioMs: Math.round(audioMs),
      });
    }, (error) => {
      if (this.stopped) return;
      this.state(saying.ref, 'failed');
      this.frame('in', 'voice.failed', { model: stage.model, message: describeCause(error) });
      this.events.degraded({ code: 'tts_degraded', message: `A sentence could not be spoken (${stage.model}): ${describeCause(error)}`, cause: error });
    }).finally(() => {
      if (this.making === control) this.making = null;
      this.next();
    });
  }

  private state(ref: Ref | undefined, state: VoiceState): void {
    if (ref !== undefined) this.events.voiceState({ ref, state });
  }

  private frame(direction: 'in' | 'out', type: string, payload: unknown): void {
    if (!this.stopped) this.events.frame({ direction, type, payload: framePayload(payload) });
  }
}

/**
 * A session that writes its translations itself (the other device's own pipeline), heard: every event is passed on
 * as it came, and each translation, when its segment closes, is given to the speaker in the language it was written
 * in — the leg's target where it named none. Feedback is read, not heard.
 */
export function speakingEvents(events: AdapterEvents, speaker: Speaker, target: string): AdapterEvents {
  const open = new Map<Ref, { text: string; language?: string }>();
  return eventsFrom((e) => {
    if (e.kind === 'segmentOpened' && e.payload.side === 'translation' && e.payload.purpose !== 'feedback') open.set(e.payload.ref, { text: '' });
    else if (e.kind === 'segmentText') {
      const segment = open.get(e.payload.ref);
      if (segment) { segment.text = e.payload.text; if (e.payload.language) segment.language = e.payload.language; }
    } else if (e.kind === 'segmentClosed') {
      const segment = open.get(e.payload.ref);
      open.delete(e.payload.ref);
      (events.segmentClosed)(e.payload);
      if (segment?.text.trim()) speaker.say(e.payload.ref, segment.text.trim(), segment.language ?? target);
      return;
    } else if (e.kind === 'failed' || e.kind === 'closed') speaker.stop();
    (events[e.kind] as (payload: unknown) => void)(e.payload);
  });
}
