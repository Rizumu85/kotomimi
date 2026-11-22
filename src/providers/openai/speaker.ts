/**
 * Fork: what speaks a leg's sentences (`voice.ts`), whichever way the leg is answered: by stages of its own
 * (`PipelineLeg`), or by the other device's session, which writes its translations itself (`speakingEvents`). One
 * sentence at a time, in the order they were finished, each handed on as its sound is made; a voice slower than the
 * talk drops the oldest sentence still waiting in the same language, so that what is heard is never far behind what is
 * read, and no language's listeners are left out for another's.
 */
import { SAMPLE_RATE, type AdapterEvents, type Ref } from '../../lib/contract/adapter';
import type { Clock } from '../../lib/contract/clock';
import { describeCause } from '../../lib/diagnostics/describeCause';
import { eventsFrom } from '../../lib/contract/events';
import { framePayload } from '../../lib/contract/framePayload';
import { sameSpeech } from '../../lib/language/script';
import { speakText, speaksLanguage, type VoiceDeps, type VoiceStage } from './voice';

/** No more sentences than this wait, in one language, behind the one being made. */
export const SAYINGS_MOST = 2;

interface Saying { ref?: Ref; text: string; language: string }

export class Speaker {
  private readonly waiting: Saying[] = [];
  private making: AbortController | null = null;
  private stopped = false;

  constructor(
    private readonly stage: VoiceStage,
    private readonly key: string | undefined,
    private readonly deps: Pick<VoiceDeps, 'decode' | 'native' | 'edge'> & { fetch: typeof fetch; clock: Clock },
    private readonly events: Pick<AdapterEvents, 'audio' | 'frame' | 'degraded'>,
    /**
     * Told each sentence as its voice begins to be made, with when it will have been heard to its end at the
     * earliest (the clock's ms); what it returns is told when it really will have — null when no sound came of it.
     * For whoever must know what the app itself is saying (`PipelineLeg`: its own voice come back through the
     * microphone is no sentence of the user's).
     */
    private readonly saying?: (text: string, untilAtLeast: number) => (until: number | null) => void,
  ) {}

  /** When what has been handed on so far will have been heard to its end: sentences play one after another. */
  private heardUntil = 0;
  private recent: { text: string; until: number }[] = [];

  /** A sentence to be spoken: on the translation's own segment, or — `ref` absent — on none (what the speaker typed, said as it is). One in a language the voice cannot speak is passed over. */
  say(ref: Ref | undefined, text: string, language: string): void {
    if (this.stopped || !speaksLanguage(this.stage, language)) return;
    // A server that writes its own translations cannot retract a captured echo. Keep the row, but don't voice it again.
    if (!this.saying) {
      const since = this.deps.clock.now() - 10_000;
      this.recent = this.recent.filter((one) => one.until > since);
      if (this.recent.some((one) => sameSpeech(text, one.text))) return;
    }
    this.waiting.push({ ...(ref !== undefined ? { ref } : {}), text, language });
    // A sentence put into two languages waits twice: each language is held to its own count.
    const base = (code: string) => code.split('-')[0].toLowerCase();
    const alike = (one: Saying) => base(one.language) === base(language);
    while (this.waiting.filter(alike).length > SAYINGS_MOST) {
      const [dropped] = this.waiting.splice(this.waiting.findIndex(alike), 1);
      this.frame('out', 'voice.skipped', { chars: dropped.text.length });
    }
    this.next();
  }

  /** Nothing more is said: the sentence being made is given up, and nothing is said of it. */
  stop(): void {
    this.stopped = true;
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
    this.frame('out', 'voice.request', { via: stage.via, model: stage.model, language: saying.language, chars: saying.text.length });
    const heard = this.saying?.(saying.text, Math.max(this.deps.clock.now(), this.heardUntil));
    const clip = { text: saying.text, until: this.heardUntil };
    let first: number | undefined;
    let samples = 0;
    void speakText(stage, saying, this.key, this.deps, control.signal, (pcm) => {
      if (this.stopped) return;
      if (first === undefined) {
        first = Math.max(this.deps.clock.now(), this.heardUntil);
        if (!this.saying) this.recent.push(clip);
      }
      this.events.audio({ pcm, ...(saying.ref !== undefined ? { ref: saying.ref } : {}) });
      samples += pcm.length;
      clip.until = first + samples * 1000 / SAMPLE_RATE;
    }).then((spoken) => {
      this.frame('in', 'voice.done', { model: stage.model, firstMs: spoken.firstMs ?? null, totalMs: spoken.totalMs, audioMs: Math.round((spoken.samples / SAMPLE_RATE) * 1000) });
    }, (error) => {
      if (this.stopped) return;
      this.frame('in', 'voice.failed', { model: stage.model, message: describeCause(error) });
      this.events.degraded({ code: 'tts_degraded', message: `A sentence could not be spoken (${stage.model}): ${describeCause(error)}`, cause: error });
    }).finally(() => {
      // A failed stream may already have put sound on the playback queue.
      if (samples) this.heardUntil = clip.until;
      heard?.(samples ? clip.until : null);
      if (this.making === control) this.making = null;
      this.next();
    });
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
