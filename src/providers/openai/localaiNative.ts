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
import type { NativeLimits } from './nativeAsr';
import { useNativeEngineStore, useNativeTranslatorStore } from '../../stores/nativeEngineStore';
import { nativeTranslates, nativeTranslator } from './nativeTranslators';

/** A model of the engine, as the settings show it. Its file, address and checksum are the main process's. */
export interface NativeModel {
  id: string;
  name: string;
  /** The whole download: the model, in bytes. The runtime itself is fetched with the first one. 0: the system fetches it, and does not say how large it is. */
  bytes: number;
  /** What it hears, in the app's base codes. */
  languages: readonly string[];
  /** How long one recognition of it may run, where that is not the default (`nativeAsr.ts`). */
  limits?: Partial<NativeLimits>;
}

/**
 * The Mac's own speech recognition (`electron/apple-speech.js`): one model to
 * a language, since the system fetches each language's assets apart. Its
 * settled text comes ten seconds late while a recognition runs, and all at
 * once when it is closed: so one that has run ten seconds is closed at the
 * next gap between words — not where the detector cuts, which is in the
 * middle of one (measured: 「すごい大きいやつ」 came out as 「すごく。」 and
 * 「いやつ」) — and at a cut only once it has run twice as long.
 */
export const APPLE_PREFIX = 'apple-speech:';
const APPLE_LANGUAGES = ['ja', 'en', 'ko', 'zh', 'es', 'fr', 'de', 'it', 'pt', 'hi', 'yue'] as const;
const APPLE_LIMITS: Partial<NativeLimits> = { rollAfter: 10, rollAt: 20, rollHard: 28 };
const isApple = (id: string | null | undefined): boolean => typeof id === 'string' && id.startsWith(APPLE_PREFIX);

export const NATIVE_MODELS: readonly NativeModel[] = [
  { id: 'r2t2-q8', name: 'Confucius4 R2T2', bytes: 2477512064, languages: ['ja', 'zh', 'en', 'ko', 'fr', 'de', 'it', 'pt', 'ru', 'es', 'ar'] },
  ...APPLE_LANGUAGES.map((language) => ({ id: `${APPLE_PREFIX}${language}`, name: 'Apple Speech', bytes: 0, languages: [language], limits: APPLE_LIMITS })),
];

export const NATIVE_DEFAULT_MODEL = NATIVE_MODELS[0].id;

/** The model a setting names; the default for a name the app no longer has. */
export const nativeModel = (id: string): NativeModel => NATIVE_MODELS.find((m) => m.id === id) ?? NATIVE_MODELS[0];

const baseOf = (code: string): string => code.trim().toLowerCase().split(/[-_]/)[0];

/**
 * The model that hears a language, for a setting: the one it names — or, where
 * it names the Mac's recognition, that recognition's model for the language,
 * since each language there is a model of its own. Null: none of them hears it.
 */
export function nativeModelFor(id: string, language: string): NativeModel | null {
  const named = nativeModel(id);
  const model = isApple(named.id) ? NATIVE_MODELS.find((m) => m.id === `${APPLE_PREFIX}${baseOf(language)}`) : named;
  return model && model.languages.includes(baseOf(language)) ? model : null;
}

/** Whether a model hears speech in this language. */
export const nativeHears = (model: NativeModel, language: string): boolean => model.languages.includes(baseOf(language));

/** The engine is this model's and ready to hear. The Mac's recognition, once asked for, is ready for every language of its own. */
export const nativeReady = (status: NativeEngineStatus, id: string): boolean => status.run.state === 'ready' && (status.run.model === id || (isApple(id) && isApple(status.run.model)));

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
  if (!status.supported) return { ok: false, reason: 'The native recognition engine is not available for this system.', code: 'native_unsupported' };
  // The model of each language heard: one for all of them, or — the Mac's recognition — one to a language.
  const unheard = heard.find((language) => !nativeModelFor(id, language));
  if (unheard !== undefined) return { ok: false, reason: `${nativeModel(id).name} does not hear ${unheard}.`, code: 'no_asr', params: { source: unheard } };
  const models = heard.map((language) => nativeModelFor(id, language)!);
  const absent = models.find((one) => !nativeDownloaded(status, one.id));
  if (absent) return { ok: false, reason: `${absent.name} is not downloaded.`, code: 'native_missing', params: { name: absent.name } };
  const model = models[0] ?? nativeModel(id);
  if (models.every((one) => nativeReady(status, one.id))) return null;
  if (status.run.state === 'failed' && status.run.model === model.id) return { ok: false, reason: `The native recognition engine could not start: ${status.run.tail.trim().split('\n').pop() ?? ''}`, code: 'native_failed' };
  if (status.run.state === 'stopped' || status.run.model !== model.id) (deps.start ?? ((which: string) => { void store.start(which); }))(model.id);
  return { ok: false, reason: 'The native recognition engine is warming up.', code: 'native_warming' };
}

/**
 * Who else is using an engine now: a device this computer shares its models
 * with (`src/lib/lan/nativeShare.ts`). While anyone holds it, the app's own
 * check does not stop it for not being this computer's own choice.
 */
const held = { asr: 0, translation: 0 };
export function holdNative(kind: 'asr' | 'translation'): () => void {
  held[kind] += 1;
  let let_go = false;
  return () => {
    if (let_go) return;
    let_go = true;
    held[kind] -= 1;
  };
}

/** A run that does not hear by the engine has no use for it: it gives its memory back. */
export function nativeIdle(deps: NativeCheckDeps = {}): void {
  const store = useNativeEngineStore.getState();
  if (held.asr > 0) return;
  if (store.status.run.state === 'stopped') return;
  (deps.stop ?? (() => { void store.stop(); }))();
}

/**
 * The same, for a run that translates by the native translation engine: its
 * model downloaded for the pairs the legs translate, and the engine up —
 * brought up when it is not.
 */
export async function translatorGap(id: string, pairs: ReadonlyArray<{ source: string; target: string }>, deps: NativeCheckDeps = {}): Promise<Extract<CheckResult, { ok: false }> | null> {
  const store = useNativeTranslatorStore.getState();
  const status = await (deps.status ?? store.refresh)();
  const model = nativeTranslator(id);
  if (!status.supported) return { ok: false, reason: 'The native translation engine is not available for this system.', code: 'native_translator_unsupported' };
  const untranslated = pairs.find((pair) => !nativeTranslates(model, pair.source, pair.target));
  if (untranslated) return { ok: false, reason: `${model.name} does not translate ${untranslated.source} → ${untranslated.target}.`, code: 'local_models_missing' };
  if (!nativeDownloaded(status, model.id)) return { ok: false, reason: `${model.name} is not downloaded.`, code: 'native_translator_missing', params: { name: model.name } };
  if (nativeReady(status, model.id)) return null;
  if (status.run.state === 'failed' && status.run.model === model.id) return { ok: false, reason: `The native translation engine could not start: ${status.run.tail.trim().split('\n').pop() ?? ''}`, code: 'native_translator_failed' };
  if (status.run.state === 'stopped' || status.run.model !== model.id) (deps.start ?? ((which: string) => { void store.start(which); }))(model.id);
  return { ok: false, reason: 'The native translation engine is starting.', code: 'native_translator_warming' };
}

/** A run that does not translate by the engine has no use for it. */
export function translatorIdle(deps: NativeCheckDeps = {}): void {
  const store = useNativeTranslatorStore.getState();
  if (held.translation > 0) return;
  if (store.status.run.state === 'stopped') return;
  (deps.stop ?? (() => { void store.stop(); }))();
}

/** Where the translation engine answers now: its chat base URL; a port of 0 while it is not up. */
export const translatorBaseUrl = (): string => `http://127.0.0.1:${useNativeTranslatorStore.getState().status.run.port}/v1`;

const stamp = (state: { status: NativeEngineStatus }): string => `${state.status.engine}|${state.status.run.state}|${state.status.run.model ?? ''}|${Object.entries(state.status.models).map(([id, m]) => `${id}:${m.state}`).join(',')}`;

/** Calls back when an engine's readiness may have changed: it came up, a download ended, a model was deleted. */
export function watchNativeEngine(onChange: () => void): () => void {
  const stops = [useNativeEngineStore.subscribe(stamp, () => onChange()), useNativeTranslatorStore.subscribe(stamp, () => onChange())];
  return () => { for (const stop of stops) stop(); };
}
