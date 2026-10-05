/**
 * Fork: the native recognition engine as one more runner of the hearing
 * stage on this computer — beside the app's own models and a LocalAI
 * installed here. It is a runtime the app downloads and runs next to itself
 * (`electron/native-engine.js`), for a model the app's own workers cannot
 * run this fast: it writes while it listens.
 *
 * This module is what the settings and the readiness check read of it: the
 * models it has, which languages they hear, and — for a run that would use
 * it — whether it is ready, with the engine brought up when it is not.
 */
import type { CheckResult } from '../../lib/provider/types';
import type { NativeEngineStatus } from '../../lib/native/nativeEngine';
import { useNativeEngineStore } from '../../stores/nativeEngineStore';

/** A model of the engine, as the settings show it. Its file, address and checksum are the main process's. */
export interface NativeModel {
  id: string;
  name: string;
  /** The whole download: the model, in bytes. The runtime itself is fetched with the first one. */
  bytes: number;
  /** What it hears, in the app's base codes. */
  languages: readonly string[];
}

export const NATIVE_MODELS: readonly NativeModel[] = [
  { id: 'r2t2-q8', name: 'Confucius4 R2T2', bytes: 2477512064, languages: ['ja', 'zh', 'en', 'ko', 'fr', 'de', 'it', 'pt', 'ru', 'es', 'ar'] },
];

export const NATIVE_DEFAULT_MODEL = NATIVE_MODELS[0].id;

/** The model a setting names; the default for a name the app no longer has. */
export const nativeModel = (id: string): NativeModel => NATIVE_MODELS.find((m) => m.id === id) ?? NATIVE_MODELS[0];

const baseOf = (code: string): string => code.trim().toLowerCase().split(/[-_]/)[0];

/** Whether a model hears speech in this language. */
export const nativeHears = (model: NativeModel, language: string): boolean => model.languages.includes(baseOf(language));

/** The engine is this model's and ready to hear. */
export const nativeReady = (status: NativeEngineStatus, id: string): boolean => status.run.state === 'ready' && status.run.model === id;

/** The model is on disk, with the runtime that runs it. */
export const nativeDownloaded = (status: NativeEngineStatus, id: string): boolean => status.engine === 'ready' && status.models[id]?.state === 'downloaded';

export interface NativeCheckDeps {
  /** The engine's state now, and the two things asked of it; the store's by default. */
  status?: () => Promise<NativeEngineStatus>;
  start?: (id: string) => void;
  stop?: () => void;
}

/**
 * What a run that hears by the engine would be refused for, or null when it
 * would start — and the engine kept in step with the choice: brought up when
 * its model is chosen and downloaded, so that it is warm by the time Start is
 * pressed. A start that failed is not tried again by itself: the stage's card
 * says so and offers it.
 */
export async function nativeGap(id: string, heard: readonly string[], deps: NativeCheckDeps = {}): Promise<Extract<CheckResult, { ok: false }> | null> {
  const store = useNativeEngineStore.getState();
  const status = await (deps.status ?? store.refresh)();
  const model = nativeModel(id);
  if (!status.supported) return { ok: false, reason: 'The native recognition engine is not available for this system.', code: 'native_unsupported' };
  const unheard = heard.find((language) => !nativeHears(model, language));
  if (unheard !== undefined) return { ok: false, reason: `${model.name} does not hear ${unheard}.`, code: 'no_asr', params: { source: unheard } };
  if (!nativeDownloaded(status, model.id)) return { ok: false, reason: `${model.name} is not downloaded.`, code: 'native_missing', params: { name: model.name } };
  if (nativeReady(status, model.id)) return null;
  if (status.run.state === 'failed' && status.run.model === model.id) return { ok: false, reason: `The native recognition engine could not start: ${status.run.tail.trim().split('\n').pop() ?? ''}`, code: 'native_failed' };
  if (status.run.state === 'stopped' || status.run.model !== model.id) (deps.start ?? ((which: string) => { void store.start(which); }))(model.id);
  return { ok: false, reason: 'The native recognition engine is warming up.', code: 'native_warming' };
}

/** A run that does not hear by the engine has no use for it: it gives its memory back. */
export function nativeIdle(deps: NativeCheckDeps = {}): void {
  const store = useNativeEngineStore.getState();
  if (store.status.run.state === 'stopped') return;
  (deps.stop ?? (() => { void store.stop(); }))();
}

/** Calls back when the engine's readiness may have changed: it came up, a download ended, a model was deleted. */
export function watchNativeEngine(onChange: () => void): () => void {
  return useNativeEngineStore.subscribe(
    (state) => `${state.status.engine}|${state.status.run.state}|${state.status.run.model ?? ''}|${Object.entries(state.status.models).map(([id, m]) => `${id}:${m.state}`).join(',')}`,
    () => onChange(),
  );
}
