import type { AnnotatedLanguage } from './types';

export const KANA = /[ぁ-ゖァ-ヺーｦ-ﾟ]/;
const HANGUL = /[가-힣ᄀ-ᇿ㄰-㆏]/;
const CYRILLIC = /[Ѐ-ӿ]/;
/** CJK ideographs, and the marks that stand for one in Japanese (々 〆 ヵ ヶ). */
export const KANJI = /[一-鿿㐀-䶿豈-﫿々〆ヵヶ]/;

/** Letters Ukrainian writes and Russian does not. (і alone is Belarusian's too, which reads closer to Russian's table.) */
const UKRAINIAN = /[їєґЇЄҐ]/;

/**
 * The language a line's script gives away, or null: kana is Japanese, Hangul
 * Korean, Cyrillic Russian — or Ukrainian, where it writes a letter only
 * Ukrainian has.
 * A line of Han characters alone is not told apart here — it reads as
 * Chinese or Japanese only by what its row is known to be.
 */
export function scriptLanguage(line: string): AnnotatedLanguage | null {
  if (KANA.test(line)) return 'ja';
  if (HANGUL.test(line)) return 'ko';
  if (CYRILLIC.test(line)) return UKRAINIAN.test(line) ? 'uk' : 'ru';
  return null;
}

/**
 * Characters a Chinese sentence is full of and a Japanese one never writes: particles, and forms only Chinese uses.
 * Fork: without 写 給 錯 誤 該 請 還 没, which Japanese writes (写真, 給料, 誤解, 請求…): a Japanese sentence with one
 * of them was taken for a Chinese explanation, and alone of its neighbours had no readings (seen 2026-11-16).
 */
const CHINESE_ONLY = /[这這吗嗎呢吧们們沒还对對应應该說说请让讓给从從发發现样樣错误读讀寫为后动词关么个时问题过语]/;

const HAN = /[一-鿿㐀-䶿]/;
/** In the 2010 everyday-use list, and outside the old character set the rest is read from. */
const JAPANESE_BESIDES = '塡剝頰';

/**
 * Fork: the Han characters Japanese writes: its own character set's (JIS X 0208 with the makers' additions, as the
 * platform decodes Shift_JIS), some 6,700. The simplified forms of Chinese are not among them (这 们 吗 选 你 另), which
 * tells a Chinese sentence from a Japanese one by its writing: of 461 Chinese sentences the user said, 380 had one,
 * and of 468 Japanese ones none (2026-11-16). Null where the platform cannot decode it: the short list above stands.
 */
let japaneseHan: ReadonlySet<string> | null | undefined;
function japaneseWrites(): ReadonlySet<string> | null {
  if (japaneseHan !== undefined) return japaneseHan;
  try {
    const decoder = new TextDecoder('shift_jis');
    const set = new Set<string>(JAPANESE_BESIDES);
    const pair = new Uint8Array(2);
    for (let lead = 0x81; lead <= 0xfc; lead += 1) {
      if (lead > 0x9f && lead < 0xe0) continue;
      for (let trail = 0x40; trail <= 0xfc; trail += 1) {
        if (trail === 0x7f) continue;
        pair[0] = lead;
        pair[1] = trail;
        const ch = decoder.decode(pair);
        if (ch.length === 1 && HAN.test(ch)) set.add(ch);
      }
    }
    // A decoder that knows none of it (a stand-in) is no witness.
    japaneseHan = set.size > 6000 ? set : null;
  } catch {
    japaneseHan = null;
  }
  return japaneseHan;
}

/** Fork: the text has a character Chinese writes and Japanese does not. */
export function chineseOnly(text: string): boolean {
  if (CHINESE_ONLY.test(text)) return true;
  const japanese = japaneseWrites();
  if (!japanese) return false;
  for (const ch of text) if (HAN.test(ch) && !japanese.has(ch)) return true;
  return false;
}

/** Words a Chinese sentence is held together by, in characters Japanese writes too, but seldom two of in one clause. */
const CHINESE_WORDS = new Set('的是了我你她很也都就吧呢吗啊么什怎这那们个');

/**
 * Fork: Han characters alone, and a Chinese sentence by its writing: a character Japanese does not write, or two of
 * the words Chinese is held together by among four characters or more (我不知道是谁). A row's language says the rest:
 * 大丈夫 is Japanese in a Japanese row.
 */
export function writtenInChinese(text: string): boolean {
  if (chineseOnly(text)) return true;
  let han = 0;
  const words = new Set<string>();
  for (const ch of text) {
    if (!HAN.test(ch)) continue;
    han += 1;
    if (CHINESE_WORDS.has(ch)) words.add(ch);
  }
  return han >= 4 && words.size >= 2;
}

/** What a sentence quotes, in the marks Chinese and Japanese quote with. */
const QUOTED = /“[^”]*”|「[^」]*」|『[^』]*』|"[^"]*"|‘[^’]*’/g;

/**
 * A line of a Chinese row that only quotes Japanese — an explanation of a
 * mistake, with the word in question in it (“見ます”要改成“見た”) — is still a
 * Chinese sentence: its kana are a quotation, not its language. Told by what
 * no Japanese sentence holds, or by kana being a small part of it.
 */
export function quotesJapanese(line: string): boolean {
  if (chineseOnly(line)) return true;
  let kana = 0;
  let han = 0;
  for (const ch of line) {
    if (KANA.test(ch)) kana += 1;
    else if (KANJI.test(ch)) han += 1;
  }
  return kana > 0 && kana * 4 < han;
}

/**
 * A line in Chinese that quotes Japanese, in a row of any language: the grammar feedback's explanation sits in the
 * practised language's row (「“に”后面缺少动词，句子不完整；用“について”表示“关于”。」), and read as Japanese every one
 * of its Chinese characters got a kana reading, which spread the line apart (2026-10-21). Told by what no Japanese
 * sentence holds, or by no kana outside its quotation marks with a sentence's worth of Han characters there. Stricter
 * than `quotesJapanese`, which a Chinese row may afford.
 */
export function explainsInChinese(line: string): boolean {
  if (chineseOnly(line)) return true;
  const outside = line.replace(QUOTED, '');
  if (KANA.test(outside)) return false;
  let han = 0;
  for (const ch of outside) if (KANJI.test(ch)) han += 1;
  return han >= 4;
}

/** Fork: the line has kana inside quotation marks: an explanation that quotes, not something said. */
export function quotesKana(line: string): boolean {
  return (line.match(QUOTED) ?? []).some((quoted) => KANA.test(quoted));
}

/** The row's language is Chinese: `zh`, `zh-CN`, `zh-TW`, `yue`. */
export function isChinese(code: string | null | undefined): boolean {
  const base = (code ?? '').toLowerCase().split(/[-_]/)[0];
  return base === 'zh' || base === 'yue';
}

/** Fork: whether a language is written with a romanization under it: Japanese, Korean, Russian, Ukrainian — not Chinese or Cantonese, whose readings are written above. */
export function romanizedLanguage(code: string | null | undefined): boolean {
  const language = annotatedLanguage(code);
  return language !== null && language !== 'zh' && language !== 'yue';
}

/**
 * Fork: whether a text has a romanization written under it. By its language where that is known, and by its writing
 * where not — a recognizer that names none, or names it only with the final: reading aids go by the writing, and
 * asked of the language alone a Korean sentence had its romanization and nothing laid out for it (2026-10-31).
 * `off`: the languages the user has none under.
 */
export function romanizedText(text: string, code: string | null | undefined, off: readonly string[] = []): boolean {
  const language = annotatedLanguage(code);
  const script = scriptLanguage(text);
  // Cyrillic is Russian by its letters and Ukrainian by its row, as `languageOf` reads it.
  const read = script === 'ru' && language === 'uk' ? 'uk' : script ?? language;
  return read !== null && read !== 'zh' && read !== 'yue' && !off.includes(read);
}

/**
 * An app language code as one this module annotates, or null: `ja`, `ja-JP`, `ko-KR`, `ru`, `uk`, `zh-CN`, `yue`.
 * Cantonese is its own: pinyin spells Mandarin, and over Cantonese it would read wrong.
 */
export function annotatedLanguage(code: string | null | undefined): AnnotatedLanguage | null {
  const base = (code ?? '').toLowerCase().split(/[-_]/)[0];
  return base === 'ja' || base === 'ko' || base === 'ru' || base === 'uk' || base === 'zh' || base === 'yue' ? base : null;
}
