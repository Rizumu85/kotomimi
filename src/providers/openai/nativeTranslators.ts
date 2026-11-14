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
  /** Estimated video memory while loaded, in MB; absent for unmeasured retired models. */
  vramMB?: number;
  /** Whose form of request it takes. */
  prompt: 'index' | 'hunyuan' | 'plamo' | 'revise';
  /** What it translates between, in the app's base codes; `'any'` for a model of well over a hundred languages. */
  languages: readonly string[] | 'any';
  /** No longer offered for download: shown only where it is already on the computer. */
  retired?: boolean;
}

/** Hunyuan MT's languages, as its card lists them. */
const HUNYUAN = ['zh', 'en', 'fr', 'pt', 'es', 'ja', 'tr', 'ru', 'ar', 'ko', 'th', 'it', 'de', 'vi', 'ms', 'id', 'fil', 'hi', 'pl', 'cs', 'nl', 'km', 'my', 'fa', 'gu', 'ur', 'te', 'mr', 'he', 'bn', 'ta', 'uk', 'bo', 'kk', 'mn', 'ug', 'yue'] as const;

/**
 * PLaMo 3 Translate's languages, as its card lists them, by the app's codes (its `tl` is `fil`, its `zh-hans` and
 * `zh-hant` are `zh`). No Cantonese.
 */
const PLAMO = ['ja', 'en', 'zh', 'ko', 'ar', 'az', 'be', 'bg', 'bn', 'ca', 'ceb', 'de', 'es', 'et', 'eu', 'fa', 'fr', 'gu', 'he', 'hi', 'hr', 'hu', 'hy', 'id', 'it', 'jv', 'ka', 'kk', 'km', 'lt', 'lv', 'ml', 'mr', 'ms', 'my', 'ne', 'nl', 'pa', 'pl', 'ru', 'si', 'sk', 'sl', 'sr', 'sw', 'ta', 'te', 'th', 'fil', 'ur', 'uz', 'vi'] as const;

/**
 * Best first, as measured on thirty sentences of Japanese VRChat talk into
 * Chinese (2026-10-05): serious errors in about 3, 8 and 8 of them. Hunyuan MT
 * 1.5 does nothing its successor does not — the same languages, the same
 * size, as many errors, and words of its own added besides — so it is no
 * longer offered: a computer that has it keeps it.
 *
 * PLaMo 3 Translate (2026-11-07, 105 sentences — 57 of the app's own stretches of Japanese VRChat talk as Qwen3-ASR
 * read them, and casual lines between Chinese, Japanese, Korean and English — judged blind): the 2B reads the most
 * natural (best of four in 39, Index-Translate in 26) with serious errors in 9 against Index-Translate's 4, so it
 * stands beside the default, not before it; the 0.8B holds a third of the video memory at twice the speed, with 11.
 * Both are free for non-commercial use only, and need llama.cpp b12182 or later.
 *
 * The retired model's id (`hy-mt1.5-1.8b`) keeps its dot, where the sidecar's
 * catalog and the app's own catalog name the same weights `hy-mt15-1.8b`: each
 * runtime finds a downloaded model by its id, so renaming this one would orphan
 * what a computer already has (the engine would report it absent). They are
 * never listed together, and the languages both name are the same (`HUNYUAN`).
 */
export const NATIVE_TRANSLATORS: readonly NativeTranslator[] = [
  { id: 'index-translate-2b', vramMB: 1536, name: 'Index-Translate 2B', bytes: 1312164352, prompt: 'index', languages: 'any' },
  { id: 'plamo-3-translate-2b', vramMB: 1946, name: 'PLaMo 3 Translate 2B', bytes: 1807201888, prompt: 'plamo', languages: PLAMO },
  { id: 'hy-mt2-1.8b', vramMB: 1434, name: 'Hunyuan MT 2 1.8B', bytes: 1133080448, prompt: 'hunyuan', languages: HUNYUAN },
  { id: 'hy-mt2-streamrevise-v4', vramMB: 1390, name: 'Hunyuan MT 2 StreamRevise', bytes: 1069288640, prompt: 'revise', languages: ['zh', 'en', 'ja'] },
  { id: 'plamo-3-translate-0.8b', vramMB: 614, name: 'PLaMo 3 Translate 0.8B', bytes: 573125696, prompt: 'plamo', languages: PLAMO },
  { id: 'hy-mt1.5-1.8b', name: 'Hunyuan MT 1.5 1.8B', bytes: 1133080512, prompt: 'hunyuan', languages: HUNYUAN, retired: true },
];

export const NATIVE_DEFAULT_TRANSLATOR = NATIVE_TRANSLATORS[0].id;

/** The model a setting names; the first for a name the app no longer has. */
export const nativeTranslator = (id: string): NativeTranslator => NATIVE_TRANSLATORS.find((m) => m.id === id) ?? NATIVE_TRANSLATORS[0];

const baseOf = (code: string): string => code.trim().toLowerCase().split(/[-_]/)[0];
const isAuto = (code: string): boolean => code.trim() === '' || code.trim().toLowerCase() === 'auto';
const isTraditional = (code: string): boolean => /^zh[-_](tw|hk|mo|hant)/i.test(code.trim());
/** Chinese or Cantonese: what a request in Chinese is for. */
const isSinitic = (code: string): boolean => baseOf(code) === 'zh' || baseOf(code) === 'yue';

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
  /**
   * Fork: the model also translates a sentence while it is still being said (`reviseRequest`): the two languages as
   * it is told them. Absent: a sentence is translated once, when it is closed.
   */
  revise?: { source?: string; target: string };
}

/** The languages a model that revises was taught, by the names it is told them. */
const REVISE_LANGUAGES: Readonly<Record<string, string>> = { zh: 'Chinese', en: 'English', ja: 'Japanese' };

/** The name such a model is told a sentence's language by, where the leg's is left to be detected; null for one it was not taught, or none known. */
export function reviseLanguage(code: string | undefined): string | null {
  if (!code || isAuto(code)) return null;
  return REVISE_LANGUAGES[baseOf(code)] ?? null;
}

/**
 * The request a model takes for `source → target`.
 *
 * Index-Translate: its card's plain translation request, in Chinese, the
 * languages by their Chinese names and the source's left out when it is to
 * be detected; greedy, thinking off.
 *
 * Hunyuan MT: its card's two forms — in Chinese when either side is Chinese
 * or Cantonese, in English otherwise — with the sampling the card recommends.
 * And, in Chinese, its card's form for a translation with what came before: a
 * sentence of a talk is often half of a thought (Japanese leaves its subject
 * out), and translated alone it is guessed at.
 *
 * Index-Translate is asked alone, always: its card has no such form, and
 * given the sentence before in any of three ways it translated that sentence
 * instead of its own in one to three of twelve (measured 2026-10-06; Hunyuan
 * MT 2, by its card's form, in none, and better in three).
 */
export function translatorRequest(model: NativeTranslator, source: string, target: string): TranslatorRequest {
  if (model.prompt === 'plamo') {
    // Its chat template writes its own request from the sentence and the languages (`chat_template_kwargs`); a
    // source left to be detected is left out, and it tells the language itself. Greedy, as its card's examples.
    const code = (language: string) => (baseOf(language) === 'zh' ? (isTraditional(language) ? 'zh-hant' : 'zh-hans') : baseOf(language) === 'fil' ? 'tl' : baseOf(language));
    return {
      wrap: TEXT_SLOT,
      extra: {
        temperature: 0,
        max_tokens: 512,
        stop: ['<|plamo:tag|>', '<|plamo:bos|>'],
        chat_template_kwargs: { target_lang: code(target), ...(isAuto(source) ? {} : { source_lang: code(source) }) },
      },
    };
  }
  if (model.prompt === 'revise') {
    // Its card's request for a sentence asked the first time, the languages by their English names; greedy, as it
    // was trained and measured. A source left to be detected is asked as a closed sentence only.
    const names = { source: nameIn(source, 'en'), target: nameIn(target, 'en') };
    return {
      wrap: `Translate the following text ${isAuto(source) ? '' : `from ${names.source} `}into ${names.target}. Note that you should only output the translated result without any additional explanation:\n\n${TEXT_SLOT}`,
      extra: { temperature: 0, max_tokens: 512 },
      revise: { target: names.target, ...(isAuto(source) ? {} : { source: names.source }) },
    };
  }
  if (model.prompt === 'index') {
    return {
      wrap: `请将以下${isAuto(source) ? '' : nameIn(source, 'zh')}文本翻译为${nameIn(target, 'zh')}，直接输出翻译结果，不要进行任何解释。\n\n${TEXT_SLOT}`,
      extra: { temperature: 0, max_tokens: 512, chat_template_kwargs: { enable_thinking: false } },
    };
  }
  // Asked in English for Cantonese, it answered Japanese in English, Tamil or Gujarati: in Chinese, in Cantonese.
  const chinese = isSinitic(target) || (!isAuto(source) && isSinitic(source));
  return {
    wrap: chinese
      ? `将以下文本翻译为${nameIn(target, 'zh')}，注意只需要输出翻译后的结果，不要额外解释：\n\n${TEXT_SLOT}`
      : `Translate the following segment into ${nameIn(target, 'en')}, without additional explanation.\n\n${TEXT_SLOT}`,
    ...(chinese ? { wrapAfter: `${BEFORE_SLOT}\n参考上面的信息，把下面的文本翻译成${nameIn(target, 'zh')}，注意不需要翻译上文，也不要额外解释：\n${TEXT_SLOT}` } : {}),
    extra: { temperature: 0.7, top_p: 0.6, top_k: 20, repeat_penalty: 1.05, max_tokens: 512 },
  };
}

/** What a model that revises is told beside its last answer (its card's words, as it was trained). */
const REVISE_RULE = 'When the source meaning has not changed, preserve the still-correct prefix of the previous translation whenever possible. When content is added or corrected, accuracy and completeness take priority.';

/**
 * Fork: the request for a sentence still being said, of a model trained to revise (Hy-MT2 StreamRevise): the text
 * so far, with the text it was given last time and what it answered then — it keeps what still stands of that and
 * writes on. The first time, with nothing before, it is its plain request (`translatorRequest`'s `wrap`).
 */
export function reviseRequest(languages: { source: string; target: string }, text: string, before?: { source: string; translation: string }): string {
  const pair = `from ${languages.source} into ${languages.target}`;
  if (!before || (!before.source && !before.translation)) return `Translate the following text ${pair}. Note that you should only output the translated result without any additional explanation:\n\n${text}`;
  const blocks = [
    ...(before.source ? [`Previous version of the current source:\n${before.source}`] : []),
    ...(before.translation ? [`Previous translation of the current source:\n${before.translation}`] : []),
    REVISE_RULE,
  ];
  return `[Background Information]\n${blocks.join('\n\n')}\n\nPlease translate the following text ${pair}, taking the provided background information into consideration.\n\n[Source Text]\n${text}`;
}
