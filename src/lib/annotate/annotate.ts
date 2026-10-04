/**
 * A text as annotated lines. Each line is read in the language its script
 * gives away — kana, Hangul, Cyrillic — so a row that mixes languages (a
 * corrected Japanese sentence over a Chinese explanation) is annotated line
 * by line. A line of Han characters alone takes the row's language, when the
 * caller knows it: 大丈夫 in a Japanese row gets its reading, and the same
 * characters in a Chinese row get none. And in a Chinese row a Chinese
 * sentence that quotes a Japanese word stays Chinese: readings over an
 * explanation written in Chinese would be noise.
 */
import { annotateJapanese } from './japanese';
import { romanizeKorean } from './korean';
import { transliterateRussian } from './russian';
import { KANJI, quotesJapanese, scriptLanguage } from './script';
import type { AnnotatedLanguage, AnnotatedLine, AnnotateOptions, JapaneseTokenizer } from './types';

export interface AnnotateInputs extends AnnotateOptions {
  /** The row's language when it is one of the annotated ones; null when it is another, or mixed. */
  language: AnnotatedLanguage | null;
  /** The row is Chinese: a line of it that only quotes Japanese is not read as Japanese. */
  chinese?: boolean;
  /** Absent until the dictionary has loaded: Japanese is then drawn plain. */
  japanese?: JapaneseTokenizer;
}

/** The language a line is read in. */
function languageOf(line: string, o: Pick<AnnotateInputs, 'language' | 'chinese'>): AnnotatedLanguage | null {
  const script = scriptLanguage(line);
  if (script === 'ja' && o.chinese && quotesJapanese(line)) return null;
  return script ?? (o.language === 'ja' && KANJI.test(line) ? 'ja' : null);
}

const plain = (line: string): AnnotatedLine => ({ parts: [{ text: line }] });

export function annotateLine(line: string, o: AnnotateInputs): AnnotatedLine {
  if (!o.furigana && !o.roman) return plain(line);
  const language = languageOf(line, o);
  if (language === 'ja') return o.japanese ? annotateJapanese(line, o.japanese, o) : plain(line);
  if (!o.roman) return plain(line);
  if (language === 'ko') return { parts: [{ text: line }], roman: romanizeKorean(line) };
  if (language === 'ru') return { parts: [{ text: line }], roman: transliterateRussian(line) };
  return plain(line);
}

/** Every line of a text, in order; an empty line stays an empty line. */
export function annotateText(text: string, o: AnnotateInputs): AnnotatedLine[] {
  return text.split('\n').map((line) => annotateLine(line, o));
}

/** Whether annotating this text needs the Japanese dictionary: it is asked for, and a line of it would be read as Japanese. */
export function needsJapanese(text: string, o: Pick<AnnotateInputs, 'furigana' | 'roman' | 'language' | 'chinese'>): boolean {
  if (!o.furigana && !o.roman) return false;
  return text.split('\n').some((line) => languageOf(line, o) === 'ja');
}
