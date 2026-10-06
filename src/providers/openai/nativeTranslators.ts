/**
 * Fork: the translation models of the native translation engine — llama.cpp's
 * server, downloaded and run by the app (`electron/native-engine.js`) — as
 * the settings show them, and the words each is asked with.
 *
 * They are translation models, not chat models: each was trained on one
 * form of request and answers that form best, so the request is written
 * here, model by model, from its makers' own card — one user message, no
 * system message, and the sampling the card names. Their files, addresses
 * and checksums are the main process's.
 */

export interface NativeTranslator {
  id: string;
  name: string;
  /** The download, in bytes. The runtime itself is fetched with the first one. */
  bytes: number;
  /** Whose form of request it takes. */
  prompt: 'index' | 'hunyuan';
  /** What it translates between, in the app's base codes; `'any'` for a model of well over a hundred languages. */
  languages: readonly string[] | 'any';
  /** No longer offered for download: shown only where it is already on the computer. */
  retired?: boolean;
}

/** Hunyuan MT's languages, as its card lists them. */
const HUNYUAN = ['zh', 'en', 'fr', 'pt', 'es', 'ja', 'tr', 'ru', 'ar', 'ko', 'th', 'it', 'de', 'vi', 'ms', 'id', 'fil', 'hi', 'pl', 'cs', 'nl', 'km', 'my', 'fa', 'gu', 'ur', 'te', 'mr', 'he', 'bn', 'ta', 'uk', 'bo', 'kk', 'mn', 'ug'] as const;

/**
 * Best first, as measured on thirty sentences of Japanese VRChat talk into
 * Chinese (2026-10-05): serious errors in about 3, 8 and 8 of them. Hunyuan MT
 * 1.5 does nothing its successor does not — the same languages, the same
 * size, as many errors, and words of its own added besides — so it is no
 * longer offered: a computer that has it keeps it.
 */
export const NATIVE_TRANSLATORS: readonly NativeTranslator[] = [
  { id: 'index-translate-2b', name: 'Index-Translate 2B', bytes: 1312164352, prompt: 'index', languages: 'any' },
  { id: 'hy-mt2-1.8b', name: 'Hunyuan MT 2 1.8B', bytes: 1133080448, prompt: 'hunyuan', languages: HUNYUAN },
  { id: 'hy-mt1.5-1.8b', name: 'Hunyuan MT 1.5 1.8B', bytes: 1133080512, prompt: 'hunyuan', languages: HUNYUAN, retired: true },
];

export const NATIVE_DEFAULT_TRANSLATOR = NATIVE_TRANSLATORS[0].id;

/** The model a setting names; the first for a name the app no longer has. */
export const nativeTranslator = (id: string): NativeTranslator => NATIVE_TRANSLATORS.find((m) => m.id === id) ?? NATIVE_TRANSLATORS[0];

const baseOf = (code: string): string => code.trim().toLowerCase().split(/[-_]/)[0];
const isAuto = (code: string): boolean => code.trim() === '' || code.trim().toLowerCase() === 'auto';
const isTraditional = (code: string): boolean => /^zh[-_](tw|hk|mo|hant)/i.test(code.trim());

/** Whether a model translates this pair. A source left to be detected is no obstacle: the model reads what it is given. */
export function nativeTranslates(model: NativeTranslator, source: string, target: string): boolean {
  if (model.languages === 'any') return true;
  return (isAuto(source) || model.languages.includes(baseOf(source))) && model.languages.includes(baseOf(target));
}

/** A language's name in a language: Chinese for the requests written in Chinese, English for those in English. */
function nameIn(code: string, language: 'zh' | 'en'): string {
  if (baseOf(code) === 'zh') return language === 'zh' ? (isTraditional(code) ? '繁体中文' : '中文') : (isTraditional(code) ? 'Traditional Chinese' : 'Chinese');
  try {
    const name = new Intl.DisplayNames([language === 'zh' ? 'zh-CN' : 'en'], { type: 'language' }).of(baseOf(code));
    if (name && name !== baseOf(code)) return name;
  } catch { /* an odd code: itself, below */ }
  return code;
}

/** Where the sentence goes in a request's words, and — in a request that takes one — the sentence said before it. */
export const TEXT_SLOT = '{{TEXT}}';
export const BEFORE_SLOT = '{{BEFORE}}';

/** A request for one sentence: the whole user message with `TEXT_SLOT` where the sentence goes, and what else the body carries. */
export interface TranslatorRequest {
  wrap: string;
  /**
   * The request where a sentence was said just before this one: the same, with `BEFORE_SLOT` where that sentence
   * goes. Only of a model trained on such a request; absent, the sentence is asked alone.
   */
  wrapAfter?: string;
  extra: Record<string, unknown>;
}

/**
 * The request a model takes for `source → target`.
 *
 * Index-Translate: its card's plain translation request, in Chinese, the
 * languages by their Chinese names and the source's left out when it is to
 * be detected; greedy, thinking off.
 *
 * Hunyuan MT: its card's two forms — in Chinese when either side is Chinese,
 * in English otherwise — with the sampling the card recommends. And, in
 * Chinese, its card's form for a translation with what came before: a
 * sentence of a talk is often half of a thought (Japanese leaves its subject
 * out), and translated alone it is guessed at.
 *
 * Index-Translate is asked alone, always: its card has no such form, and
 * given the sentence before in any of three ways it translated that sentence
 * instead of its own in one to three of twelve (measured 2026-10-06; Hunyuan
 * MT 2, by its card's form, in none, and better in three).
 */
export function translatorRequest(model: NativeTranslator, source: string, target: string): TranslatorRequest {
  if (model.prompt === 'index') {
    return {
      wrap: `请将以下${isAuto(source) ? '' : nameIn(source, 'zh')}文本翻译为${nameIn(target, 'zh')}，直接输出翻译结果，不要进行任何解释。\n\n${TEXT_SLOT}`,
      extra: { temperature: 0, max_tokens: 512, chat_template_kwargs: { enable_thinking: false } },
    };
  }
  const chinese = baseOf(target) === 'zh' || (!isAuto(source) && baseOf(source) === 'zh');
  return {
    wrap: chinese
      ? `将以下文本翻译为${nameIn(target, 'zh')}，注意只需要输出翻译后的结果，不要额外解释：\n\n${TEXT_SLOT}`
      : `Translate the following segment into ${nameIn(target, 'en')}, without additional explanation.\n\n${TEXT_SLOT}`,
    ...(chinese ? { wrapAfter: `${BEFORE_SLOT}\n参考上面的信息，把下面的文本翻译成${nameIn(target, 'zh')}，注意不需要翻译上文，也不要额外解释：\n${TEXT_SLOT}` } : {}),
    extra: { temperature: 0.7, top_p: 0.6, top_k: 20, repeat_penalty: 1.05, max_tokens: 512 },
  };
}
