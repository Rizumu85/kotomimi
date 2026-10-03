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

/** An app language code as one this module annotates, or null: `ja`, `ja-JP`, `ko-KR`, `ru`. */
export function annotatedLanguage(code: string | null | undefined): AnnotatedLanguage | null {
  const base = (code ?? '').toLowerCase().split(/[-_]/)[0];
  return base === 'ja' || base === 'ko' || base === 'ru' ? base : null;
}
