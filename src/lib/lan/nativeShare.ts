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
import { NATIVE_MODELS, holdNative, nativeDownloaded, nativeModel, nativeModelFor, nativePicked, nativePreference, nativeTaken, translatorBaseUrl, translatorKey } from '../../providers/openai/localaiNative';
import { NATIVE_TRANSLATORS, TEXT_SLOT, nativeTranslates, translatorRequest } from '../../providers/openai/nativeTranslators';
import { useNativeCoachStore, useNativeEngineStore, useNativeTranslatorStore } from '../../stores/nativeEngineStore';
import type { SharedModel } from './protocol';
import type { Recognizer } from './transcriber';
import type { Translator } from './translator';

const isNativeRecognizer = (id: string): boolean => NATIVE_MODELS.some((m) => m.id === id);
const isNativeTranslator = (id: string): boolean => NATIVE_TRANSLATORS.some((m) => m.id === id);

/** The native models this computer can run now: downloaded, each with what it is for. */
export function nativeShared(): SharedModel[] {
  const hearing = useNativeEngineStore.getState().status;
  const translating = useNativeTranslatorStore.getState().status;
  return [
    ...NATIVE_MODELS.filter((m) => nativeDownloaded(hearing, m.id)).map((m): SharedModel => ({ id: m.id, kind: 'asr', languages: [...m.languages, ...(m.detects ? [AUTO] : [])] })),
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

/** The native recognizer for a language: the one named when it is downloaded and hears it, else — nothing named — the first downloaded that does. Null: none, and the app's own models answer. */
export function nativeRecognizerFor(language: string, wanted: string): { modelId: string; streaming: boolean } | null {
  const status = useNativeEngineStore.getState().status;
  const usable = (id: string) => nativeDownloaded(status, id);
  if (wanted && !isNativeRecognizer(wanted)) return null;
  // The engine the app downloads runs one model at a time. The one running — this computer's own choice, or what
  // another device is listening through — answers for whichever of the native models was named, where it hears the
  // language: starting another would stop it under whoever is using it.
  const running = status.run.state !== 'stopped' && status.run.state !== 'failed' && status.run.model ? nativeModelFor(status.run.model, language) : null;
  if (running && isNativeRecognizer(running.id) && usable(running.id)) return { modelId: running.id, streaming: true };
  // The engine is someone's with a model that does not hear this language: it is not switched under them. The
  // system's own recognition (a Mac) runs beside it, and is still offered.
  const taken = nativeTaken('asr');
  const free = (id: string) => usable(id) && (taken === null || id === taken || id.startsWith('apple-speech'));
  if (wanted) {
    const named = nativeModelFor(wanted, language);
    return named && free(named.id) ? { modelId: named.id, streaming: true } : null;
  }
  // Nothing named: this computer's own choice for the language first, so that its owner's next run finds the engine
  // on the model it would start anyway.
  const own = nativePreference().asr;
  const chosen = own ? nativePicked(own, language) : null;
  if (chosen && free(chosen.id)) return { modelId: chosen.id, streaming: true };
  const best = NATIVE_MODELS.find((m) => free(m.id) && nativeModelFor(m.id, language)?.id === m.id);
  return best ? { modelId: best.id, streaming: true } : null;
}

/** The native translator for a pair, the same way. */
export function nativeTranslatorFor(source: string, target: string, wanted: string): string | null {
  const status = useNativeTranslatorStore.getState().status;
  const fits = (id: string) => nativeDownloaded(status, id) && nativeTranslates(NATIVE_TRANSLATORS.find((m) => m.id === id)!, source, target);
  if (wanted && !isNativeTranslator(wanted)) return null;
  // The engine runs one model at a time. The one running — this computer's own choice, or what another device is
  // being served with — answers for any of the engine's models, where it translates the pair: starting another would
  // stop it under whoever is using it.
  const running = status.run.state !== 'stopped' && status.run.state !== 'failed' ? status.run.model : null;
  if (running && isNativeTranslator(running) && fits(running)) return running;
  // In use with a model that does not translate this pair: not switched under whoever is using it.
  const taken = nativeTaken('translation');
  const free = (id: string) => fits(id) && (taken === null || id === taken);
  if (wanted) return free(wanted) ? wanted : null;
  const own = nativePreference().translation;
  if (own && free(own)) return own;
  return NATIVE_TRANSLATORS.find((m) => free(m.id))?.id ?? null;
}

/** A recognizer for a native model, as the sharing host drives one; null for any other model. The engine is held while it listens: the app's own check does not stop it under a device that is using it. */
export function nativeRecognizer(model: { modelId: string }): Recognizer | null {
  if (!isNativeRecognizer(model.modelId)) return null;
  const native = nativeModel(model.modelId);
  const asr = createNativeAsr({
    bridge: ipcNativeBridge,
    start: () => useNativeEngineStore.getState().start(native.id),
    model: native.id,
    ...(native.limits ? { limits: native.limits } : {}),
  });
  let release: (() => void) | null = null;
  const init = asr.init.bind(asr);
  const dispose = asr.dispose.bind(asr);
  asr.init = async (modelId, options) => {
    release ??= holdNative('asr');
    await init(modelId, options);
  };
  asr.dispose = () => {
    release?.();
    release = null;
    dispose();
  };
  return asr;
}

/**
 * A translator that is the native translation engine when it is asked for one
 * of that engine's models, and `other` — the app's own — for any other. The
 * choice is made when it is told its model, which is when it is told
 * anything.
 */
export function nativeOrOwnTranslator(other: () => Translator, doFetch: typeof fetch = (input, init) => fetch(input, init)): Translator {
  let own: Translator | null = null;
  let native: { id: string; source: string; target: string } | null = null;
  let release: (() => void) | null = null;
  const translator: Translator = {
    onError: null,
    async init(sourceLang, targetLang, modelId) {
      if (!modelId || !isNativeTranslator(modelId)) {
        own = other();
        own.onError = (error) => translator.onError?.(error);
        return own.init(sourceLang, targetLang, modelId);
      }
      release ??= holdNative('translation');
      const status = await useNativeTranslatorStore.getState().start(modelId);
      if (status.run.state !== 'ready' || status.run.model !== modelId) throw new Error('The translation engine of this computer could not start.');
      native = { id: modelId, source: sourceLang, target: targetLang };
      return undefined;
    },
    async translate(text, systemPrompt, wrapTranscript) {
      if (own) return own.translate(text, systemPrompt, wrapTranscript);
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
      own?.dispose();
      own = null;
      native = null;
      release?.();
      release = null;
    },
  };
  return translator;
}
