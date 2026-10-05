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
import { createNativeAsr } from '../../providers/openai/nativeAsr';
import { NATIVE_MODELS, holdNative, nativeDownloaded, nativeModel, nativeModelFor, translatorBaseUrl } from '../../providers/openai/localaiNative';
import { NATIVE_TRANSLATORS, TEXT_SLOT, nativeTranslates, translatorRequest } from '../../providers/openai/nativeTranslators';
import { useNativeEngineStore, useNativeTranslatorStore } from '../../stores/nativeEngineStore';
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
    ...NATIVE_MODELS.filter((m) => nativeDownloaded(hearing, m.id)).map((m): SharedModel => ({ id: m.id, kind: 'asr', languages: [...m.languages] })),
    // A model of every language lists none: the list is what a device reads to rule a model out.
    ...NATIVE_TRANSLATORS.filter((m) => nativeDownloaded(translating, m.id)).map((m): SharedModel => ({ id: m.id, kind: 'translate', languages: m.languages === 'any' ? [] : [...m.languages] })),
  ];
}

/** The native recognizer for a language: the one named when it is downloaded and hears it, else — nothing named — the first downloaded that does. Null: none, and the app's own models answer. */
export function nativeRecognizerFor(language: string, wanted: string): { modelId: string; streaming: boolean } | null {
  const status = useNativeEngineStore.getState().status;
  const usable = (id: string) => nativeDownloaded(status, id);
  if (wanted) {
    if (!isNativeRecognizer(wanted)) return null;
    const named = nativeModelFor(wanted, language);
    return named && usable(named.id) ? { modelId: named.id, streaming: true } : null;
  }
  const best = NATIVE_MODELS.find((m) => usable(m.id) && nativeModelFor(m.id, language)?.id === m.id);
  return best ? { modelId: best.id, streaming: true } : null;
}

/** The native translator for a pair, the same way. */
export function nativeTranslatorFor(source: string, target: string, wanted: string): string | null {
  const status = useNativeTranslatorStore.getState().status;
  const fits = (id: string) => nativeDownloaded(status, id) && nativeTranslates(NATIVE_TRANSLATORS.find((m) => m.id === id)!, source, target);
  if (wanted) return isNativeTranslator(wanted) && fits(wanted) ? wanted : null;
  // The one already running first: starting another would stop it under whoever is using it.
  const running = status.run.model;
  if (running && isNativeTranslator(running) && fits(running)) return running;
  return NATIVE_TRANSLATORS.find((m) => fits(m.id))?.id ?? null;
}

/** A recognizer for a native model, as the sharing host drives one; null for any other model. The engine is held while it listens: the app's own check does not stop it under a device that is using it. */
export function nativeRecognizer(model: { modelId: string }): Recognizer | null {
  if (!isNativeRecognizer(model.modelId)) return null;
  const native = nativeModel(model.modelId);
  const asr = createNativeAsr({
    bridge: ipcNativeBridge,
    start: () => useNativeEngineStore.getState().start(native.id),
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
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer no-key' },
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
