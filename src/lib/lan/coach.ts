/**
 * Fork: `POST /v1/chat/completions` of a Kotomimi sharing its models, where
 * the model named is its feedback model — a chat, in OpenAI's shape on both
 * sides, answered by this computer's native feedback engine. The device's own
 * messages are passed on as they are: the prompt for grammar feedback is the
 * asking device's (its two languages, its own instructions).
 *
 * The engine is held while devices use it, and let go once none has asked
 * for a while — as the translation models are (`translator.ts`).
 */
import type { Clock } from '../contract/clock';
import { wireError } from './protocol';
import type { HttpAnswer } from './translator';

export interface CoachDeps {
  /** The engine's answer to a chat with this model. */
  answer(model: string, messages: unknown, extra: Record<string, unknown>): Promise<string>;
  /** Holds the engine up; what it returns lets it go. */
  hold(): () => void;
  clock: Clock;
}

/** An engine no request has asked for this long is let go; the next request loads it again. */
export const COACH_IDLE_MS = 10 * 60_000;
/** The most a device may have written for it in one answer: feedback is a few lines. */
const MOST_TOKENS = 1024;
/** What of a request is the asking device's to choose. */
const PASSED_ON = ['temperature', 'top_p', 'top_k', 'seed', 'stop', 'chat_template_kwargs'] as const;

const refusal = (status: number, code: string, message: string): HttpAnswer => ({ status, body: { error: wireError(code, message) } });

export class LanCoach {
  private release: (() => void) | null = null;
  private cancelIdle: (() => void) | null = null;
  private busy = 0;
  private ids = 0;

  constructor(private readonly deps: CoachDeps) {}

  async complete(model: string, body: unknown): Promise<HttpAnswer> {
    const request = (body ?? {}) as Record<string, unknown>;
    if (!Array.isArray(request.messages) || request.messages.length === 0) return refusal(400, 'no_text', 'There is no message to answer.');
    const extra: Record<string, unknown> = {};
    for (const key of PASSED_ON) if (request[key] !== undefined) extra[key] = request[key];
    const asked = Number(request.max_tokens);
    extra.max_tokens = Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), MOST_TOKENS) : MOST_TOKENS;

    this.release ??= this.deps.hold();
    this.cancelIdle?.();
    this.cancelIdle = null;
    this.busy += 1;
    let text: string;
    try {
      text = await this.deps.answer(model, request.messages, extra);
    } catch (cause) {
      return refusal(500, 'server_error', `The feedback failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      this.busy -= 1;
      this.watchIdle();
    }
    const id = `chatcmpl-kotomimi-feedback-${++this.ids}`;
    const created = Math.floor(this.deps.clock.now() / 1000);
    if (request.stream === true) {
      // A client that asked for a stream reads one: the whole answer as its only piece.
      const chunk = (delta: Record<string, unknown>, finish: string | null) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      return { status: 200, contentType: 'text/event-stream', body: `${chunk({ role: 'assistant', content: text }, null)}${chunk({}, 'stop')}data: [DONE]\n\n` };
    }
    return { status: 200, body: { id, object: 'chat.completion', created, model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] } };
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
    }, COACH_IDLE_MS);
  }
}
