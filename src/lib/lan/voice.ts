/**
 * Fork: `POST /v1/audio/speech` of a Kotomimi sharing its models — one
 * sentence in, its sound out, by this computer's voice engine. OpenAI's
 * request (`model`, `input`, `voice`), with the sentence's `language` beside
 * it, which the engine's models are told. `model` names a voice model this
 * computer lends; a voice that is none of the model's is its first.
 *
 * A cloning model has no voice of its own: the device hands over a recording
 * first (`POST /v1/audio/voices`, answered with its name) and names it in
 * `voice_ref`. One this computer does not hold is refused with 409
 * `voice_ref_unknown`, and the device hands it over and asks again.
 *
 * The answer is the sound as it is made: raw 16-bit mono, at the rate its
 * type names (`audio/pcm;rate=24000`), whatever `response_format` asks for.
 * The main process sends it (`lan:reply-voice`): this module checks the
 * request, brings the engine up and holds it, and answers what is refused.
 *
 * The engine is held while devices use it, and let go once none has asked
 * for a while — as the feedback engine is (`coach.ts`).
 */
import type { Clock } from '../contract/clock';
import { wireError } from './protocol';
import type { HttpAnswer } from './translator';

export interface LanVoiceDeps {
  /** The voice model a device named, where this computer lends one by that name; null for any other name. */
  resolve(wanted: string): string | null;
  /** The engine is someone's now with another model than this: it is not switched under them. */
  busy(model: string): boolean;
  /** Brings the engine up with the model; rejects when it does not come up. */
  up(model: string): Promise<void>;
  /** The sentence, sent to the request's caller as it is made. `sent` false: nothing went out, and the caller is still to be answered. */
  speak(id: string, said: { model: string; text: string; voice?: string; language?: string; reference?: string }): Promise<{ ok: true } | { error: string; sent: boolean; code?: string }>;
  /** Holds the engine up; what it returns lets it go. */
  hold(): () => void;
  clock: Clock;
}

/** An engine no request has asked for this long is let go; the next request loads it again. */
export const VOICE_IDLE_MS = 10 * 60_000;
/** The longest text spoken for one request, as the asking side cuts its own (`VOICE_MOST_CHARS`). */
const MOST_CHARS = 400;

const refusal = (status: number, code: string, message: string): HttpAnswer => ({ status, body: { error: wireError(code, message) } });

export class LanVoice {
  private release: (() => void) | null = null;
  private cancelIdle: (() => void) | null = null;
  private busy = 0;
  /** The model the hold is on. */
  private held = '';

  constructor(private readonly deps: LanVoiceDeps) {}

  /** Null: the sound went out, and the request is answered. */
  async speak(id: string, body: unknown): Promise<HttpAnswer | null> {
    const request = (body ?? {}) as Record<string, unknown>;
    const text = typeof request.input === 'string' ? request.input.trim().slice(0, MOST_CHARS) : '';
    if (!text) return refusal(400, 'no_text', 'There is nothing to say.');
    const model = typeof request.model === 'string' ? this.deps.resolve(request.model) : null;
    if (!model) return refusal(404, 'model_not_found', 'This Kotomimi lends no such voice model.');
    // A hold left from an earlier sentence in another model is no one's use of the engine: it is let go before the
    // engine is asked whether it is someone's, or a device that changed its model would be refused for as long as it is kept.
    if (this.busy === 0 && this.held !== model) this.dispose();
    // A sentence being made here, or its model still coming up, has the engine before its status says so: two
    // devices that ask for two models at once do not start one over the other.
    if (this.busy > 0 && this.held !== model) return refusal(503, 'voice_busy', 'The voice engine of this computer is in use with another model.');
    if (this.deps.busy(model)) return refusal(503, 'voice_busy', 'The voice engine of this computer is in use with another model.');
    const voice = typeof request.voice === 'string' ? request.voice.trim() : '';
    const language = typeof request.language === 'string' && /^[a-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/i.test(request.language) ? request.language : '';
    const reference = typeof request.voice_ref === 'string' && /^[a-f0-9]{64}$/.test(request.voice_ref) ? request.voice_ref : '';

    this.release ??= this.deps.hold();
    this.held = model;
    this.cancelIdle?.();
    this.cancelIdle = null;
    this.busy += 1;
    try {
      await this.deps.up(model);
      const spoken = await this.deps.speak(id, { model, text, ...(voice ? { voice } : {}), ...(language ? { language } : {}), ...(reference ? { reference } : {}) });
      // Some of it went out: the caller has what was made, and reads the rest as cut short.
      if ('ok' in spoken || spoken.sent) return null;
      if (spoken.code === 'voice_ref_unknown') return refusal(409, 'voice_ref_unknown', 'This Kotomimi does not hold the recording to speak from. Hand it over and ask again.');
      return refusal(500, 'server_error', `The sentence could not be spoken: ${spoken.error}`);
    } catch (cause) {
      return refusal(500, 'server_error', `The voice engine could not start: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      this.busy -= 1;
      this.watchIdle();
    }
  }

  /** Sharing stopped: the engine is let go. */
  dispose(): void {
    this.cancelIdle?.();
    this.cancelIdle = null;
    this.release?.();
    this.release = null;
  }

  /** The engine is let go once no device has asked for a while. */
  private watchIdle(): void {
    if (this.busy > 0 || !this.release) return;
    this.cancelIdle?.();
    this.cancelIdle = this.deps.clock.setTimeout(() => {
      this.cancelIdle = null;
      if (this.busy > 0) return;
      this.release?.();
      this.release = null;
    }, VOICE_IDLE_MS);
  }
}
