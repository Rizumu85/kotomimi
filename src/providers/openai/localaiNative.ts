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
import { useNativeCoachStore, useNativeEngineStore, useNativeTranslatorStore } from '../../stores/nativeEngineStore';
import { nativeCoach } from './nativeCoaches';
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
  /** It finds the language itself when told none: it can hear a leg whose language is left to be detected. */
  detects?: boolean;
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

/**
 * Qwen3-ASR in the native engine reads a stretch at a time, and the engine
 * keeps it live by reading the stretch again as it grows (`openWindow` in
 * `electron/native-engine.js`). A reading takes longer the longer the stretch,
 * and nothing of a stretch is translated before it ends: so a recognition is
 * begun again at a gap between words once it has run eight seconds, and where
 * the detector cuts once it is that old. Measured 2026-10-05 on the seven
 * clips, in the app: begun again after 10 s and at cuts after 20 s, 17.2 %;
 * after 8 s and at every cut, about the same but for one stretch cut short
 * enough to be read badly; after 8 s and at cuts after 8 s, 16.4 %, a line
 * every fifteen seconds at most. Its last words are a reading of the whole
 * stretch, which a slow computer takes seconds over: they are waited for
 * longer.
 */
const QWEN_LANGUAGES = ['zh', 'en', 'yue', 'ar', 'de', 'fr', 'es', 'pt', 'id', 'it', 'ko', 'ru', 'th', 'vi', 'ja', 'tr', 'hi', 'ms', 'nl', 'sv', 'da', 'fi', 'pl', 'cs', 'fil', 'fa', 'el', 'hu', 'mk', 'ro'] as const;
const WINDOW_LIMITS: Partial<NativeLimits> = { rollAfter: 8, rollAt: 8, rollHard: 24, lastWordsMs: 15_000 };

/**
 * In the order they are offered, the one measured best for a language first
 * (Japanese VRChat talk, in the app, 2026-10-05): the Mac's own recognition
 * 12.5 % of the characters wrong; Qwen3-ASR 16.4 %, its text a second behind
 * the voice; R2T2 18.2 %, two and a half seconds behind — and R2T2 has to keep
 * up with the voice, where Qwen3-ASR only refreshes less often on a busy card. A system is offered the ones it can run.
 */
export const NATIVE_MODELS: readonly NativeModel[] = [
  ...APPLE_LANGUAGES.map((language) => ({ id: `${APPLE_PREFIX}${language}`, name: 'Apple Speech', bytes: 0, languages: [language], limits: APPLE_LIMITS })),
  // It reads a whole stretch before it writes, and names the language right from that: measured 2026-10-05 on
  // Korean, Russian, Spanish, English, Chinese and noisy Japanese with no language given. (R2T2 can be left to
  // detect too, but writes the first words of a stretch in the wrong language: it is not offered for that.)
  { id: 'qwen3-asr-1.7b-q8', name: 'Qwen3-ASR 1.7B GGUF', bytes: 2473010048, languages: QWEN_LANGUAGES, limits: WINDOW_LIMITS, detects: true },
  { id: 'r2t2-q8', name: 'Confucius4 R2T2 GGUF', bytes: 2477512064, languages: ['ja', 'zh', 'en', 'ko', 'fr', 'de', 'it', 'pt', 'ru', 'es', 'ar'] },
];

/** The one every system the engine is published for can run. */
export const NATIVE_DEFAULT_MODEL = 'qwen3-asr-1.7b-q8';

/** The model a setting names; the default for a name the app no longer has. */
export const nativeModel = (id: string): NativeModel => NATIVE_MODELS.find((m) => m.id === id) ?? NATIVE_MODELS.find((m) => m.id === NATIVE_DEFAULT_MODEL)!;

const baseOf = (code: string): string => code.trim().toLowerCase().split(/[-_]/)[0];
/** A leg's language left to be detected. */
export const isAutoLanguage = (code: string): boolean => baseOf(code) === 'auto';

/**
 * The model that hears a language, for a setting: the one it names — or, where
 * it names the Mac's recognition, that recognition's model for the language,
 * since each language there is a model of its own. Null: none of them hears it.
 */
export function nativeModelFor(id: string, language: string): NativeModel | null {
  const named = nativeModel(id);
  // A language left to be detected is heard by a model that detects one, and by no other.
  if (isAutoLanguage(language)) return named.detects ? named : null;
  const model = isApple(named.id) ? NATIVE_MODELS.find((m) => m.id === `${APPLE_PREFIX}${baseOf(language)}`) : named;
  return model && model.languages.includes(baseOf(language)) ? model : null;
}

/**
 * Which native model hears what: the one in use, and — language by language —
 * the one that was chosen for it.
 */
export interface NativePick { model: string; byLanguage?: Readonly<Record<string, string>> }

/**
 * The model a language is heard by: the one chosen for that language; else
 * the one in use, where it hears it. Null: neither — the language has no
 * model until one is chosen for it. No other model is taken in its place: a
 * change of language is made with the session stopped, and what hears the
 * new one is the user's to say.
 */
export function nativePicked(pick: NativePick, language: string): NativeModel | null {
  const chosen = pick.byLanguage?.[baseOf(language)];
  // A name the app no longer has is no choice.
  const known = chosen !== undefined && NATIVE_MODELS.some((m) => m.id === chosen);
  return (known ? nativeModelFor(chosen, language) : null) ?? nativeModelFor(pick.model, language);
}

/**
 * A model chosen for some languages: it is the one in use from now on and
 * theirs by name — and the other languages now heard keep, by name too, the
 * model they were heard by, so that choosing for one does not change another.
 */
export function chooseNative(pick: NativePick, id: string, languages: readonly string[], heard: readonly string[] = languages): Required<NativePick> {
  const byLanguage: Record<string, string> = { ...pick.byLanguage };
  const chosenFor = new Set(languages.map(baseOf));
  for (const language of heard) {
    const base = baseOf(language);
    if (chosenFor.has(base) || byLanguage[base]) continue;
    const now = nativePicked(pick, language);
    if (now) byLanguage[base] = now.id;
  }
  for (const language of languages) {
    const model = nativeModelFor(id, language);
    if (model) byLanguage[baseOf(language)] = model.id;
  }
  return { model: id, byLanguage };
}

/** Whether a model hears speech in this language. */
export const nativeHears = (model: NativeModel, language: string): boolean => (isAutoLanguage(language) ? model.detects === true : model.languages.includes(baseOf(language)));

/** The engine is this model's and ready to hear. The Mac's recognition, once asked for, is ready for every language of its own. */
export const nativeReady = (status: NativeEngineStatus, id: string): boolean => status.up.includes(id) || (status.run.state === 'ready' && (status.run.model === id || (isApple(id) && isApple(status.run.model))));

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
export async function nativeGap(chosen: NativePick | string, heard: readonly string[], deps: NativeCheckDeps = {}): Promise<Extract<CheckResult, { ok: false }> | null> {
  const pick: NativePick = typeof chosen === 'string' ? { model: chosen } : chosen;
  const store = useNativeEngineStore.getState();
  const status = await (deps.status ?? store.refresh)();
  if (!status.supported) return { ok: false, reason: 'The native recognition engine is not available for this system.', code: 'native_unsupported' };
  // The model of each language heard: the one chosen for it, or the one in use.
  const unchosen = heard.find((language) => !nativePicked(pick, language));
  if (unchosen !== undefined) return { ok: false, reason: `No native recognition model is chosen for ${unchosen}.`, code: 'native_unchosen', params: { source: unchosen } };
  const models = [...new Map(heard.map((language) => { const one = nativePicked(pick, language)!; return [one.id, one] as const; })).values()];
  const absent = models.find((one) => !nativeDownloaded(status, one.id));
  if (absent) return { ok: false, reason: `${absent.name} is not downloaded.`, code: 'native_missing', params: { name: absent.name } };
  // The engine the app downloads runs one model at a time: two of its models cannot hear in one run.
  const run = models.filter((one) => !isApple(one.id));
  if (run.length > 1) return { ok: false, reason: `${run[0].name} and ${run[1].name} cannot run at the same time.`, code: 'native_two_models', params: { name: run[0].name, other: run[1].name } };
  const waiting = models.filter((one) => !nativeReady(status, one.id));
  if (waiting.length === 0) return null;
  const failed = waiting.find((one) => status.run.state === 'failed' && status.run.model === one.id);
  if (failed) return { ok: false, reason: `The native recognition engine could not start: ${status.run.tail.trim().split('\n').pop() ?? ''}`, code: 'native_failed' };
  const start = deps.start ?? ((which: string) => { void store.start(which); });
  // One start for the system's recognition, whatever its languages, and one for the engine the app downloads; none for one already coming up.
  const asked = new Set<string>();
  for (const one of waiting) {
    const engine = isApple(one.id) ? APPLE_PREFIX : one.id;
    if (asked.has(engine)) continue;
    asked.add(engine);
    const coming = status.run.model === one.id && (status.run.state === 'starting' || status.run.state === 'warming');
    if (!coming) start(one.id);
  }
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

/**
 * The same, for a run whose grammar feedback is given by the native feedback
 * engine: its model downloaded, and the engine up — brought up when it is not.
 */
export async function coachGap(id: string, deps: NativeCheckDeps = {}): Promise<Extract<CheckResult, { ok: false }> | null> {
  const store = useNativeCoachStore.getState();
  const status = await (deps.status ?? store.refresh)();
  const model = nativeCoach(id);
  if (!status.supported) return { ok: false, reason: 'The native feedback engine is not available for this system.', code: 'native_coach_unsupported' };
  if (!nativeDownloaded(status, model.id)) return { ok: false, reason: `${model.name} is not downloaded.`, code: 'native_coach_missing', params: { name: model.name } };
  if (nativeReady(status, model.id)) return null;
  if (status.run.state === 'failed' && status.run.model === model.id) return { ok: false, reason: `The native feedback engine could not start: ${status.run.tail.trim().split('\n').pop() ?? ''}`, code: 'native_coach_failed' };
  if (status.run.state === 'stopped' || status.run.model !== model.id) (deps.start ?? ((which: string) => { void store.start(which); }))(model.id);
  return { ok: false, reason: 'The native feedback engine is starting.', code: 'native_coach_warming' };
}

/** A run with no feedback by the engine has no use for it. */
export function coachIdle(deps: NativeCheckDeps = {}): void {
  const store = useNativeCoachStore.getState();
  if (store.status.run.state === 'stopped') return;
  (deps.stop ?? (() => { void store.stop(); }))();
}

/** Where the feedback engine answers now: its chat base URL; a port of 0 while it is not up. */
export const coachBaseUrl = (): string => `http://127.0.0.1:${useNativeCoachStore.getState().status.run.port}/v1`;

/** Where the translation engine answers now: its chat base URL; a port of 0 while it is not up. */
export const translatorBaseUrl = (): string => `http://127.0.0.1:${useNativeTranslatorStore.getState().status.run.port}/v1`;

const stamp = (state: { status: NativeEngineStatus }): string => `${state.status.engine}|${state.status.run.state}|${state.status.run.model ?? ''}|${Object.entries(state.status.models).map(([id, m]) => `${id}:${m.state}`).join(',')}`;

/** Calls back when an engine's readiness may have changed: it came up, a download ended, a model was deleted. */
export function watchNativeEngine(onChange: () => void): () => void {
  const stops = [useNativeEngineStore.subscribe(stamp, () => onChange()), useNativeTranslatorStore.subscribe(stamp, () => onChange()), useNativeCoachStore.subscribe(stamp, () => onChange())];
  return () => { for (const stop of stops) stop(); };
}
