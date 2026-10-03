/**
 * Fork: what each model a LocalAI check found is for, and which a slot of
 * the settings may choose from. Apart from `localai.ts` so the settings view
 * can read it without importing the provider that imports the view. Pure.
 */
import type { ModelOption } from '../../lib/provider/types';

/** What a model on the Realtime server is for: a pipeline the socket runs, a recognizer, a text model, or something no stage uses (a VAD, a TTS voice). */
export type LocalAIModelKind = 'pipeline' | 'asr' | 'text' | 'other';

/** A model the check found: the Realtime server's own — with its kind, when the server says — or one a stage's other server lists (`from`). */
export interface LocalAIModel extends ModelOption {
  kind?: LocalAIModelKind;
  /** Listed by the translation or the feedback model's own server, not the Realtime server. */
  from?: 'translate' | 'coach';
}

/**
 * A model's kind from LocalAI's `/v1/models/capabilities`: `transcript` is a
 * recognizer, `chat` or `completion` a text model, and a model with no
 * capability of its own is a pipeline — it only strings other models
 * together. Anything else (`vad`, `tts`, `embeddings`) no stage here uses.
 */
export function kindOf(capabilities: unknown): LocalAIModelKind {
  const list = Array.isArray(capabilities) ? capabilities.filter((c): c is string => typeof c === 'string') : [];
  if (list.includes('transcript')) return 'asr';
  if (list.includes('chat') || list.includes('completion')) return 'text';
  return list.length === 0 ? 'pipeline' : 'other';
}

/** The slots a model is chosen for. */
export type LocalAIModelSlot = 'pipeline' | 'asr' | 'translate' | 'coach';

/**
 * The models a slot may choose from: only the ones that can do its work. The
 * text slots read their own server's list when they name one. A server that
 * says nothing of its models' kinds (not a LocalAI) leaves every model in
 * every slot, as before — nothing is hidden on a guess.
 */
export function modelsFor(models: readonly LocalAIModel[], slot: LocalAIModelSlot, ownServer = true): LocalAIModel[] {
  if ((slot === 'translate' || slot === 'coach') && !ownServer) return models.filter((m) => m.from === slot);
  const server = models.filter((m) => m.from === undefined);
  if (!server.some((m) => m.kind !== undefined)) return server;
  const kind: LocalAIModelKind = slot === 'pipeline' ? 'pipeline' : slot === 'asr' ? 'asr' : 'text';
  return server.filter((m) => m.kind === kind);
}
