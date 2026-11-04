/**
 * Fork: this computer's native engines, as the sharing host lends them — the
 * native recognizer (the Mac's own speech recognition, or the engine the app
 * downloads) and the native translation engine. To a device that asks, they
 * are models like any other this Kotomimi shares: listed with what they are
 * for, chosen by name or left to this computer, and run by the same engines
 * that run them for this computer's own sessions.
 *
 * Left to this computer, a native model is its choice where one is
 * downloaded for the language: they are the ones measured best.
 *
 * Beside `appModels.ts` and `appHost.ts`, the other modules of `src/lib/lan`
 * that know the app.
 */
import { ipcNativeBridge } from '../native/nativeEngine';
import { AUTO } from '../provider/languages';
import { createNativeAsr } from '../../providers/openai/nativeAsr';
import { NATIVE_COACHES } from '../../providers/openai/nativeCoaches';
import { coachBaseUrl, coachKey } from '../../providers/openai/localaiNative';
import { NATIVE_MODELS, type NativeModel, holdNative, isApple, nativeDownloaded, nativeModel, nativeModelFor, nativePicked, nativePreference, nativeTaken, translatorBaseUrl, translatorKey } from '../../providers/openai/localaiNative';
import { NATIVE_TRANSLATORS, TEXT_SLOT, nativeTranslates, translatorRequest } from '../../providers/openai/nativeTranslators';
import { useNativeCoachStore, useNativeEngineStore, useNativeTranslatorStore } from '../../stores/nativeEngineStore';
import type { SharedModel } from './protocol';
import type { Recognizer } from './transcriber';
import type { Translator } from './translator';

const isNativeRecognizer = (id: string): boolean => NATIVE_MODELS.some((m) => m.id === id);
const isNativeTranslator = (id: string): boolean => NATIVE_TRANSLATORS.some((m) => m.id === id);

/** How long sharing waits for this computer's engines to say what they have before it opens all the same (`nativeKnown`). */
export const NATIVE_KNOWN_WITHIN_MS = 5000;

/**
 * Fork: resolves once each of this computer's engines has said what it has downloaded (`asked`), or after `within`
 * ms whatever they said: until then they look as if they had nothing, and sharing would tell a device so.
 */
export function nativeKnown(within = NATIVE_KNOWN_WITHIN_MS): Promise<void> {
  const stores = [useNativeEngineStore, useNativeTranslatorStore, useNativeCoachStore];
  const known = () => stores.every((store) => store.getState().asked);
  if (known()) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      for (const off of offs) off();
      resolve();
    };
    const offs = stores.map((store) => store.subscribe(() => { if (known()) done(); }));
    const timer = setTimeout(done, within);
  });
}

/** The native models this computer can run now: downloaded, each with what it is for. */
export function nativeShared(): SharedModel[] {
  const hearing = useNativeEngineStore.getState().status;
  const translating = useNativeTranslatorStore.getState().status;
  return [
    ...NATIVE_MODELS.filter((m) => nativeDownloaded(hearing, m.id)).map((m): SharedModel => ({ id: m.id, kind: 'asr', languages: [...m.languages, ...(m.detects ? [AUTO] : [])], ...(isApple(m.id) ? { bilingual: true } : {}) })),
    // A model of every language lists none: the list is what a device reads to rule a model out.
    ...NATIVE_TRANSLATORS.filter((m) => nativeDownloaded(translating, m.id)).map((m): SharedModel => ({ id: m.id, kind: 'translate', languages: m.languages === 'any' ? [] : [...m.languages] })),
    // The feedback engine's models: chat models, lent for grammar feedback in whatever languages they are asked.
    ...NATIVE_COACHES.filter((m) => nativeDownloaded(useNativeCoachStore.getState().status, m.id)).map((m): SharedModel => ({ id: m.id, kind: 'feedback', languages: [] })),
  ];
}

/** The native feedback model a device named, where it is downloaded; null for any other name. */
export function nativeCoachFor(wanted: string): string | null {
  const model = NATIVE_COACHES.find((m) => m.id === wanted);
  return model && nativeDownloaded(useNativeCoachStore.getState().status, model.id) ? model.id : null;
}

/**
 * The native feedback engine's answer to a chat a device sent: the engine is
 * started when it is not up (the first sentence waits for the model to load),
 * and asked on this computer with the key of its run. `extra`: the request's
 * other fields that are its own to choose (temperature and the like).
 */
export async function nativeCoachAnswer(model: string, messages: unknown, extra: Record<string, unknown> = {}, doFetch: typeof fetch = (input, init) => fetch(input, init)): Promise<string> {
  const status = await useNativeCoachStore.getState().start(model);
  if (status.run.state !== 'ready' || status.run.model !== model) throw new Error('The feedback engine of this computer could not start.');
  const response = await doFetch(`${coachBaseUrl()}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${coachKey() || 'no-key'}` },
    body: JSON.stringify({ ...extra, model, stream: false, messages }),
  });
  if (!response.ok) throw new Error(`The feedback engine answered HTTP ${response.status}.`);
  const body = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> } | null;
  const content = body?.choices?.[0]?.message?.content;
  // A thinking model's thoughts are not the feedback.
  return typeof content === 'string' ? content.replace(/<think>[\s\S]*?<\/think>/g, '').trim() : '';
}

/** The native recognizer for a language: the one named when it is downloaded and hears it, else — nothing named — the first downloaded that does. Null: no native recognizer is available. */
export function nativeRecognizerFor(language: string, wanted: string, also?: string): { modelId: string; streaming: boolean; also?: string } | null {
  const status = useNativeEngineStore.getState().status;
  const usable = (id: string) => nativeDownloaded(status, id);
  if (wanted && !isNativeRecognizer(wanted)) return null;
  if (also) {
    const named = wanted ? nativeModelFor(wanted, language) : NATIVE_MODELS.find((m) => isApple(m.id) && m.languages.includes(language));
    // Only the Mac's recognition hears a pair. Another model named that hears the first language is answered alone,
    // and the session is refused as unable to hear the pair, not as having no model for its language.
    if (named && !isApple(named.id)) return usable(named.id) ? { modelId: named.id, streaming: true } : null;
    const second = named ? nativeModelFor(named.id, also) : null;
    return named && second && named.id !== second.id && usable(named.id) && usable(second.id)
      ? { modelId: named.id, streaming: true, also }
      : null;
  }
  // The engine the app downloads runs one model at a time. While it is someone's — a run of this computer, or a
  // device listening through it — its model answers for whichever of that engine's models was named, where it hears
  // the language: starting another would stop it under whoever is using it. A model a device's recognizer here has
  // just claimed counts before the engine's status says so: two sessions of one device arrive together. Nobody's, a
  // model named is the one started; one still up from an earlier run answers only when none was named. The Mac's own
  // recognition is an engine of its own, beside it: named, it is what runs, whichever of the two was started last.
  const taken = claimedAsr() ?? nativeTaken('asr');
  const up = taken ?? (status.run.state !== 'stopped' && status.run.state !== 'failed' ? status.run.model : null);
  const running = up ? nativeModelFor(up, language) : null;
  const sameEngine = (id: string) => !wanted || isApple(wanted) === isApple(id);
  if (running && (taken !== null || !wanted) && isNativeRecognizer(running.id) && usable(running.id) && sameEngine(running.id)) return { modelId: running.id, streaming: true };
  // The engine is someone's with a model that does not hear this language: it is not switched under them. The
  // system's own recognition (a Mac) runs beside it, and is still offered.
  const free = (id: string) => usable(id) && (taken === null || id === taken || isApple(id));
  if (wanted) {
    const named = nativeModelFor(wanted, language);
    return named && free(named.id) ? { modelId: named.id, streaming: true } : null;
  }
  // Nothing named: this computer's own choice for the language first, so that its owner's next run finds the engine
  // on the model it would start anyway.
  // Its own speaker heard in either of two languages is its own run's: "auto" from a device is a language to detect.
  const own = nativePreference().asr;
  const chosen = own ? nativePicked({ model: own.model, byLanguage: own.byLanguage, ...(own.detecting ? { detecting: true } : {}) }, language) : null;
  if (chosen && free(chosen.id)) return { modelId: chosen.id, streaming: true };
  const best = NATIVE_MODELS.find((m) => free(m.id) && nativeModelFor(m.id, language)?.id === m.id);
  return best ? { modelId: best.id, streaming: true } : null;
}

/**
 * Fork: why no recognizer answered a language (`nativeRecognizerFor` gave none): one that hears it is downloaded —
 * the one named, or any — but the engine is in use with another model ('busy'). Null: none that hears it is here.
 */
export function nativeRecognizerRefusal(language: string, wanted: string): 'busy' | null {
  const status = useNativeEngineStore.getState().status;
  if (wanted && !isNativeRecognizer(wanted)) return null;
  const hears = (id: string) => nativeDownloaded(status, id) && nativeModelFor(id, language)?.id === id;
  if (wanted) {
    const named = nativeModelFor(wanted, language);
    return named && hears(named.id) ? 'busy' : null;
  }
  return NATIVE_MODELS.some((m) => hears(m.id)) ? 'busy' : null;
}

/**
 * Fork: the recognizer to offer for download when a device found none here for a language: the one it chose, or of
 * the Mac's languages the one for this language, where it hears it; else the first this system offers that does.
 * Null: one that hears it is downloaded already, or none this system offers does.
 */
export function nativeOfferFor(language: string, wanted: string): NativeModel | null {
  const status = useNativeEngineStore.getState().status;
  if (!status.supported) return null;
  const hears = (m: NativeModel) => nativeModelFor(m.id, language)?.id === m.id;
  const offered = NATIVE_MODELS.filter((m) => status.models[m.id] && hears(m));
  if (offered.some((m) => nativeDownloaded(status, m.id))) return null;
  const named = wanted && isNativeRecognizer(wanted) ? nativeModelFor(wanted, language) : null;
  return (named && offered.find((m) => m.id === named.id)) ?? offered[0] ?? null;
}

/**
 * The engine's models that devices' recognizers here hold, each with how many: a device that opens two sessions at
 * once has the second asked for before the engine's status names the model the first started.
 */
const claims = new Map<string, number>();
const claimedAsr = (): string | null => [...claims.keys()].find((id) => !isApple(id)) ?? null;
const claim = (id: string): (() => void) => {
  claims.set(id, (claims.get(id) ?? 0) + 1);
  const held = holdNative('asr');
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const left = (claims.get(id) ?? 1) - 1;
    if (left > 0) claims.set(id, left);
    else claims.delete(id);
    held();
  };
};

/** The native translator for a pair, the same way. */
export function nativeTranslatorFor(source: string, target: string, wanted: string): string | null {
  const status = useNativeTranslatorStore.getState().status;
  const fits = (id: string) => nativeDownloaded(status, id) && nativeTranslates(NATIVE_TRANSLATORS.find((m) => m.id === id)!, source, target);
  if (wanted && !isNativeTranslator(wanted)) return null;
  // The engine runs one model at a time. While someone is using it, its model answers for any of the engine's models
  // that translates the pair: starting another would stop it under them.
  const taken = nativeTaken('translation');
  if (wanted) {
    // A model named is never answered by one that cannot translate the pair: `appModels` says why instead (`refusal`).
    if (!fits(wanted)) return null;
    if (taken && taken !== wanted) return fits(taken) ? taken : null;
    return wanted;
  }
  // In use with a model that does not translate this pair: not switched under whoever is using it.
  const free = (id: string) => fits(id) && (taken === null || id === taken);
  // Nothing named: this computer's own choice first, so that its owner's next run finds the engine on the model it
  // would start anyway — then the one already up (a load saved), then the best that is nobody else's.
  const own = nativePreference().translation;
  if (own && free(own)) return own;
  const running = status.run.state !== 'stopped' && status.run.state !== 'failed' ? status.run.model : null;
  if (running && isNativeTranslator(running) && free(running)) return running;
  return NATIVE_TRANSLATORS.find((m) => free(m.id))?.id ?? null;
}

/** A recognizer for a native model, as the sharing host drives one; null for any other model. The engine is held while it listens: the app's own check does not stop it under a device that is using it. */
export function nativeRecognizer(model: { modelId: string; also?: string; hints?: readonly string[] }): Recognizer | null {
  if (!isNativeRecognizer(model.modelId)) return null;
  const native = nativeModel(model.modelId);
  const asr = createNativeAsr({
    bridge: ipcNativeBridge,
    start: () => useNativeEngineStore.getState().start(native.id),
    model: native.id,
    ...(model.also ? { also: model.also } : {}),
    ...(model.hints?.length ? { hints: model.hints } : {}),
    ...(native.limits ? { limits: native.limits } : {}),
  });
  let release: (() => void) | null = null;
  const init = asr.init.bind(asr);
  const dispose = asr.dispose.bind(asr);
  asr.init = async (modelId, options) => {
    release ??= claim(native.id);
    await init(modelId, options);
  };
  asr.dispose = () => {
    release?.();
    release = null;
    dispose();
  };
  return asr;
}

/** A native translation engine held for the lifetime of a shared translator. */
export function nativeTranslator(doFetch: typeof fetch = (input, init) => fetch(input, init)): Translator {
  let native: { id: string; source: string; target: string } | null = null;
  let release: (() => void) | null = null;
  const translator: Translator = {
    onError: null,
    async init(sourceLang, targetLang, modelId) {
      if (!modelId || !isNativeTranslator(modelId)) throw new Error('The shared translator is not a native model.');
      release ??= holdNative('translation');
      const status = await useNativeTranslatorStore.getState().start(modelId);
      if (status.run.state !== 'ready' || status.run.model !== modelId) throw new Error('The translation engine of this computer could not start.');
      native = { id: modelId, source: sourceLang, target: targetLang };
      return undefined;
    },
    async translate(text) {
      if (!native) throw new Error('The translator was not told its model.');
      const request = translatorRequest(NATIVE_TRANSLATORS.find((m) => m.id === native!.id)!, native.source, native.target);
      const response = await doFetch(`${translatorBaseUrl()}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${translatorKey() || 'no-key'}` },
        body: JSON.stringify({ ...request.extra, model: native.id, stream: false, messages: [{ role: 'user', content: request.wrap.replace(TEXT_SLOT, () => text) }] }),
      });
      if (!response.ok) throw new Error(`The translation engine answered HTTP ${response.status}.`);
      const body = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> } | null;
      const content = body?.choices?.[0]?.message?.content;
      // A thinking model's thoughts are not the translation.
      return { translatedText: typeof content === 'string' ? content.replace(/<think>[\s\S]*?<\/think>/g, '').trim() : '' };
    },
    dispose() {
      native = null;
      release?.();
      release = null;
    },
  };
  return translator;
}
