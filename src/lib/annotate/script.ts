import type { AnnotatedLanguage } from './types';

const KANA = /[ぁ-ゖァ-ヺーｦ-ﾟ]/;
const HANGUL = /[가-힣ᄀ-ᇿ㄰-㆏]/;
const CYRILLIC = /[Ѐ-ӿ]/;
/** CJK ideographs, and the marks that stand for one in Japanese (々 〆 ヵ ヶ). */
export const KANJI = /[一-鿿㐀-䶿豈-﫿々〆ヵヶ]/;

/**
 * The language a line's script gives away, or null: kana is Japanese, Hangul
 * Korean, Cyrillic Russian (every Cyrillic language gets Russian's table).
 * A line of Han characters alone is not told apart here — it reads as
 * Chinese or Japanese only by what its row is known to be.
 */
export function scriptLanguage(line: string): AnnotatedLanguage | null {
  if (KANA.test(line)) return 'ja';
  if (HANGUL.test(line)) return 'ko';
  if (CYRILLIC.test(line)) return 'ru';
  return null;
}

/** Characters a Chinese sentence is full of and a Japanese one never writes: particles, and forms only Chinese uses. */
const CHINESE_ONLY = /[这這吗嗎呢吧们們没沒还還对對应應该說说请請让讓给給从從发發现样樣错錯误誤读讀写寫为]/;

/**
 * A line of a Chinese row that only quotes Japanese — an explanation of a
 * mistake, with the word in question in it (“見ます”要改成“見た”) — is still a
 * Chinese sentence: its kana are a quotation, not its language. Told by what
 * no Japanese sentence holds, or by kana being a small part of it.
 */
export function quotesJapanese(line: string): boolean {
  if (CHINESE_ONLY.test(line)) return true;
  let kana = 0;
  let han = 0;
  for (const ch of line) {
    if (KANA.test(ch)) kana += 1;
    else if (KANJI.test(ch)) han += 1;
  }
  return kana > 0 && kana * 4 < han;
}

/** The row's language is Chinese: `zh`, `zh-CN`, `zh-TW`, `yue`. */
export function isChinese(code: string | null | undefined): boolean {
  const base = (code ?? '').toLowerCase().split(/[-_]/)[0];
  return base === 'zh' || base === 'yue';
}

/** An app language code as one this module annotates, or null: `ja`, `ja-JP`, `ko-KR`, `ru`. */
export function annotatedLanguage(code: string | null | undefined): AnnotatedLanguage | null {
  const base = (code ?? '').toLowerCase().split(/[-_]/)[0];
  return base === 'ja' || base === 'ko' || base === 'ru' ? base : null;
}
