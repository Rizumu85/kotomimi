/**
 * Fork: what each model a LocalAI check found is for, and which a slot of
 * the settings may choose from. Apart from `localai.ts` so the settings view
 * can read it without importing the provider that imports the view. Pure.
 */
import type { ModelOption } from '../../lib/provider/types';

/**
 * What a model on the Realtime server is for: a pipeline the socket runs, a
 * recognizer, a text model, a translation model that is no chat model
 * (another Kotomimi's own, `src/lib/lan`), or something no stage uses (a
 * VAD, a TTS voice).
 */
export type LocalAIModelKind = 'pipeline' | 'asr' | 'text' | 'translate' | 'other';

/** The name another Kotomimi gives as the owner of every model it shares. */
export const KOTOMIMI_HOST = 'kotomimi';

/** A model the check found: the Realtime server's own — with its kind, when the server says — or one a stage's other server lists (`from`). */
export interface LocalAIModel extends ModelOption {
  kind?: LocalAIModelKind;
  /** Listed by the translation or the feedback model's own server, or by the speech recognition API — not the Realtime server. */
  from?: 'translate' | 'coach' | 'asr';
  /** Served by another Kotomimi: it translates a named pair, and takes any of its recognizers in any session. */
  host?: typeof KOTOMIMI_HOST;
}

/**
 * A model's kind from LocalAI's `/v1/models/capabilities`: `transcript` is a
 * recognizer, `chat` or `completion` a text model, `translate` a translation
 * model, and a model with no capability of its own is a pipeline — it only
 * strings other models together. Anything else (`vad`, `tts`, `embeddings`)
 * no stage here uses.
 */
export function kindOf(capabilities: unknown): LocalAIModelKind {
  const list = Array.isArray(capabilities) ? capabilities.filter((c): c is string => typeof c === 'string') : [];
  if (list.includes('transcript')) return 'asr';
  if (list.includes('chat') || list.includes('completion')) return 'text';
  if (list.includes('translate')) return 'translate';
  return list.length === 0 ? 'pipeline' : 'other';
}

/** The slots a model is chosen for. */
export type LocalAIModelSlot = 'pipeline' | 'asr' | 'translate' | 'coach';

/** The kinds that can do a slot's work: a translation model translates, and gives no feedback. */
const KINDS: Readonly<Record<LocalAIModelSlot, readonly LocalAIModelKind[]>> = {
  pipeline: ['pipeline'],
  asr: ['asr'],
  translate: ['text', 'translate'],
  coach: ['text'],
};

/**
 * The models a slot may choose from: only the ones that can do its work. The
 * text slots read their own server's list when they name one. A server that
 * says nothing of its models' kinds (not a LocalAI) leaves every model in
 * every slot, as before — nothing is hidden on a guess.
 */
export function modelsFor(models: readonly LocalAIModel[], slot: LocalAIModelSlot, ownServer = true): LocalAIModel[] {
  if ((slot === 'translate' || slot === 'coach') && !ownServer) return models.filter((m) => m.from === slot && (m.kind === undefined || KINDS[slot].includes(m.kind)));
  const server = models.filter((m) => m.from === undefined);
  if (!server.some((m) => m.kind !== undefined)) return server;
  return server.filter((m) => m.kind !== undefined && KINDS[slot].includes(m.kind));
}

/**
 * What the other device runs for a slot left blank: the first model it lists
 * that can do the work. Only a device that says what its models are for is
 * asked this way (a LocalAI, another Kotomimi): on any other, nothing is run
 * on a guess, and the model has to be named.
 */
export function serverDefaultModel(models: readonly LocalAIModel[], slot: 'translate' | 'coach'): string {
  if (!models.some((m) => m.from === undefined && m.kind !== undefined)) return '';
  return modelsFor(models, slot)[0]?.id ?? '';
}

/** The Realtime server is another Kotomimi: every model it lists says so. */
export function isKotomimiServer(models: readonly LocalAIModel[]): boolean {
  return models.some((m) => m.from === undefined && m.host === KOTOMIMI_HOST);
}
