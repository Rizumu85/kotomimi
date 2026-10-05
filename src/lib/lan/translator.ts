/**
 * Fork: `POST /v1/chat/completions` of a Kotomimi sharing its models — one
 * sentence in, its translation out, by one of this computer's translation
 * models. OpenAI's shape on both sides, with one addition a translation
 * model needs and a chat model does not: the pair, as `source_language` and
 * `target_language`. The system message is not read: each model here has its
 * own prompt for a pair, and a prompt written for a large chat model only
 * confuses a small translator.
 *
 * `model` names a shared translation model, or the pipeline, which leaves
 * the choice to this computer: the best one downloaded for the pair. A model
 * is loaded for a pair at its first request and kept while it is used: the
 * least recently used is let go when there are more than a few, and any that
 * no request has asked for in a while — a computer that lends its models
 * holds the ones in use, and no others.
 */
import type { Clock } from '../contract/clock';
import { buildDefaultLocalPrompt } from '../local-inference/prompts';
import { baseLanguage, LAN_PIPELINE, wireError } from './protocol';

/** The translation engine as the sharing host drives it: `engines.ts`'s `TranslationLike`, named here so `lib` imports no provider. */
export interface Translator {
  init(sourceLang: string, targetLang: string, modelId?: string): Promise<unknown>;
  translate(text: string, systemPrompt: string, wrapTranscript: boolean): Promise<{ translatedText: string }>;
  dispose(): void;
  onError: ((error: string) => void) | null;
}

export interface TranslatorDeps {
  translator(): Translator;
  /** The model for a pair: the one named when it is shared and translates that pair, else the best shared. Null: none. */
  resolve(source: string, target: string, wanted: string): string | null;
  clock: Clock;
}

export interface HttpAnswer { status: number; body: unknown; contentType?: string }

/** Models kept loaded at once: both directions of one conversation, and one to spare. */
const MAX_LOADED = 3;
/** A model no request has asked for this long is let go; the next request loads it again. */
export const TRANSLATOR_IDLE_MS = 10 * 60_000;

/** `busy`: the requests it is answering, or loading for, now. */
interface Loaded { engine: Translator; ready: Promise<unknown>; usedAt: number; busy: number }

const refusal = (status: number, code: string, message: string): HttpAnswer => ({ status, body: { error: wireError(code, message) } });

/** The text to translate: the last user message, whether its content is a string or OpenAI's list of parts. */
function userText(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i] as { role?: unknown; content?: unknown };
    if (m?.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content.trim();
    if (Array.isArray(m.content)) return m.content.map((part) => (typeof (part as { text?: unknown })?.text === 'string' ? (part as { text: string }).text : '')).join('').trim();
  }
  return '';
}

export class LanTranslator {
  private readonly loaded = new Map<string, Loaded>();
  private ids = 0;
  /** Cancels the look at what has gone idle. */
  private cancelSweep: (() => void) | null = null;

  constructor(private readonly deps: TranslatorDeps) {}

  async complete(body: unknown): Promise<HttpAnswer> {
    const request = (body ?? {}) as { model?: unknown; messages?: unknown; stream?: unknown; source_language?: unknown; target_language?: unknown };
    const source = baseLanguage(request.source_language);
    const target = baseLanguage(request.target_language);
    if (!source || !target) return refusal(400, 'languages_required', 'Name the pair: this Kotomimi runs translation models, and they are told what to translate from and into (source_language, target_language).');
    const text = userText(request.messages);
    if (!text) return refusal(400, 'no_text', 'There is no user message to translate.');
    const named = typeof request.model === 'string' && request.model !== LAN_PIPELINE ? request.model : '';
    const model = this.deps.resolve(source, target, named);
    if (!model) return refusal(404, 'model_not_found', `This Kotomimi shares no translation model for ${source} → ${target}.`);

    let translated: string;
    // Held while it loads and answers: room is made for another model only among those answering nobody.
    const entry = this.entryFor(model, source, target);
    entry.busy += 1;
    try {
      await entry.ready;
      translated = (await entry.engine.translate(text, buildDefaultLocalPrompt(source, target), true)).translatedText ?? '';
    } catch (cause) {
      return refusal(500, 'server_error', `The translation failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      entry.busy -= 1;
      entry.usedAt = this.deps.clock.now();
      this.trim('');
    }
    const id = `chatcmpl-kotomimi-${++this.ids}`;
    const created = Math.floor(this.deps.clock.now() / 1000);
    if (request.stream === true) {
      // A client that asked for a stream reads one: the whole answer as its only piece.
      const chunk = (delta: Record<string, unknown>, finish: string | null) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      return { status: 200, contentType: 'text/event-stream', body: `${chunk({ role: 'assistant', content: translated }, null)}${chunk({}, 'stop')}data: [DONE]\n\n` };
    }
    return { status: 200, body: { id, object: 'chat.completion', created, model, choices: [{ index: 0, message: { role: 'assistant', content: translated }, finish_reason: 'stop' }] } };
  }

  /** Sharing stopped: every model is let go. */
  dispose(): void {
    this.cancelSweep?.();
    this.cancelSweep = null;
    for (const { engine } of this.loaded.values()) engine.dispose();
    this.loaded.clear();
  }

  /** Looks, once the model just used could have gone idle, at which have: one look at a time, armed only while a model is loaded. */
  private watchIdle(): void {
    if (this.cancelSweep || this.loaded.size === 0) return;
    this.cancelSweep = this.deps.clock.setTimeout(() => {
      this.cancelSweep = null;
      const now = this.deps.clock.now();
      for (const [key, entry] of [...this.loaded]) {
        if (entry.busy > 0 || now - entry.usedAt < TRANSLATOR_IDLE_MS) continue;
        this.loaded.delete(key);
        entry.engine.dispose();
      }
      this.watchIdle();
    }, TRANSLATOR_IDLE_MS);
  }

  private entryFor(model: string, source: string, target: string): Loaded {
    const key = `${model}|${source}|${target}`;
    let entry = this.loaded.get(key);
    if (!entry) {
      const engine = this.deps.translator();
      const created: Loaded = { engine, ready: engine.init(source, target, model), usedAt: this.deps.clock.now(), busy: 0 };
      entry = created;
      this.loaded.set(key, created);
      // A model that cannot load, or dies later, is forgotten: the next request loads it afresh.
      const forget = () => {
        if (this.loaded.get(key) === created) this.loaded.delete(key);
        engine.dispose();
      };
      created.ready.catch(forget);
      engine.onError = forget;
      this.trim(key);
    }
    entry.usedAt = this.deps.clock.now();
    this.watchIdle();
    return entry;
  }

  /**
   * Lets the least recently used models go, never the one just asked for — and never one that is answering a
   * request: its device would get an error for a sentence it was promised. More than a few stay loaded for as long
   * as that many are in use at once.
   */
  private trim(keep: string): void {
    while (this.loaded.size > MAX_LOADED) {
      const oldest = [...this.loaded.entries()].filter(([key, entry]) => key !== keep && entry.busy === 0).sort((a, b) => a[1].usedAt - b[1].usedAt)[0];
      if (!oldest) return;
      this.loaded.delete(oldest[0]);
      oldest[1].engine.dispose();
    }
  }
}
