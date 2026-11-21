/**
 * A text as annotated lines. Each line is read in the language its script
 * gives away — kana, Hangul, Cyrillic — so a row that mixes languages (a
 * corrected Japanese sentence over a Chinese explanation) is annotated line
 * by line. A line of Han characters alone takes the row's language, when the
 * caller knows it: 大丈夫 in a Japanese row gets its reading, and the same
 * characters in a Chinese row get none. And in a Chinese row a Chinese
 * sentence that quotes a Japanese word stays Chinese: readings over an
 * explanation written in Chinese would be noise. A line of Han characters in
 * a Chinese row is Chinese, and takes pinyin where that is asked for; of a
 * Cantonese row, Cantonese, and Jyutping.
 *
 * Fork: and a line said in two languages is read clause by clause (`readAs`):
 * recognition writes a sentence that began in Japanese and went on in Chinese
 * as one line (「届かなかったっけ？要再买吗？」), and read whole it had Japanese
 * readings over its Chinese, or none over its Japanese (the user, 2026-11-17).
 */
import { annotateCantonese } from './cantonese';
import { annotateChinese } from './chinese';
import { annotateJapanese, japaneseStretches } from './japanese';
import { romanizeKorean } from './korean';
import { transliterateRussian } from './russian';
import { transliterateUkrainian } from './ukrainian';
import { chineseOnly, explainsInChinese, KANA, KANJI, quotesJapanese, quotesKana, scriptLanguage, writtenInChinese } from './script';
import type { AnnotatedLanguage, AnnotatedLine, AnnotateOptions, JapaneseTokenizer, RomanizedLanguage } from './types';

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
  if (script === 'ja' && (o.chinese ? quotesJapanese(line) || explainsInChinese(line) : explainsInChinese(line))) return null;
  // Ukrainian does not write one of its own letters in every sentence: the row says what the letters cannot.
  if (script === 'ru' && o.language === 'uk') return 'uk';
  if (script) return script;
  if (!KANJI.test(line)) return null;
  // Fork: Han characters alone that only Chinese writes so are Chinese, whatever the row was taken for.
  if (o.language !== 'yue' && writtenInChinese(line)) return 'zh';
  return o.language === 'ja' || o.language === 'zh' || o.language === 'yue' ? o.language : null;
}

/** A clause with what closes it: the marks a sentence pauses or ends at. Not the full stop of a number. */
const CLAUSE = /[^、，,。！!？?；;…]+[、，,。！!？?；;…\s]*|[、，,。！!？?；;…\s]+/g;

interface Read { text: string; language: AnnotatedLanguage | null }

/**
 * Fork: a line as the stretches each read in one language. Only a line with both kana and Han characters can be said
 * in two; one that quotes its kana is an explanation, read whole as before. A clause with kana is Japanese, unless it
 * has a character only Chinese writes (a Chinese clause with a Japanese word in it: left plain); Han characters alone
 * are Chinese by their writing, else what the row is, else what the whole line reads as. What has neither goes with
 * the clause before it.
 */
function readAs(line: string, o: Pick<AnnotateInputs, 'language' | 'chinese'>): Read[] {
  const whole = languageOf(line, o);
  if (!KANA.test(line) || !KANJI.test(line) || quotesKana(line)) return [{ text: line, language: whole }];
  const read: Read[] = [];
  for (const text of line.match(CLAUSE) ?? [line]) {
    const kana = KANA.test(text);
    const han = KANJI.test(text);
    const last = read[read.length - 1];
    // Nothing to read in it (a mark, a number, Latin letters): the clause before's, or the one after's.
    if (!kana && !han) {
      if (last) last.text += text;
      else read.push({ text, language: null });
      continue;
    }
    const language: AnnotatedLanguage | null = kana
      ? (chineseOnly(text) ? null : 'ja')
      : o.language !== 'yue' && writtenInChinese(text) ? 'zh'
        : o.language === 'ja' || o.language === 'zh' || o.language === 'yue' ? o.language : whole;
    if (last && (last.language === language || !(KANA.test(last.text) || KANJI.test(last.text)))) {
      last.text += text;
      last.language = language;
    } else read.push({ text, language });
  }
  // All of one language: the line, read whole as before.
  return read.length > 1 ? read : [{ text: line, language: whole }];
}

const plain = (line: string): AnnotatedLine => ({ parts: [{ text: line }] });

const romanFor = (language: AnnotatedLanguage | null, o: Pick<AnnotateOptions, 'roman' | 'romanOff'>): boolean =>
  o.roman && !(language && o.romanOff?.includes(language as RomanizedLanguage));

export function annotateLine(line: string, o: AnnotateInputs): AnnotatedLine {
  if (!o.furigana && !o.roman && !o.pinyin && !o.jyutping) return plain(line);
  const read = readAs(line, o);
  if (read.length === 1) return annotateAs(read[0].text, read[0].language, o);
  // Each clause in its own language, as one line: the romanization is that of the clauses that have one.
  const parts: AnnotatedLine['parts'] = [];
  const romans: string[] = [];
  for (const clause of read) {
    const annotated = annotateAs(clause.text, clause.language, o);
    for (const part of annotated.parts) {
      const last = parts[parts.length - 1];
      if (last && last.ruby === undefined && part.ruby === undefined) last.text += part.text;
      else parts.push({ ...part });
    }
    if (annotated.roman) romans.push(annotated.roman);
  }
  return { parts, ...(romans.length > 0 ? { roman: romans.join(' ') } : {}) };
}

function annotateAs(line: string, language: AnnotatedLanguage | null, o: AnnotateInputs): AnnotatedLine {
  if (language === 'zh') return o.pinyin ? { parts: annotateChinese(line) } : plain(line);
  if (language === 'yue') return o.jyutping ? { parts: annotateCantonese(line) } : plain(line);
  const roman = romanFor(language, o);
  if (language === 'ja') return o.japanese && (o.furigana || roman) ? annotateJapanese(line, o.japanese, { ...o, roman }) : plain(line);
  if (!roman) return plain(line);
  if (language === 'ko') return { parts: [{ text: line }], roman: romanizeKorean(line) };
  if (language === 'ru') return { parts: [{ text: line }], roman: transliterateRussian(line) };
  if (language === 'uk') return { parts: [{ text: line }], roman: transliterateUkrainian(line) };
  return plain(line);
}

/** Every line of a text, in order; an empty line stays an empty line. */
export function annotateText(text: string, o: AnnotateInputs): AnnotatedLine[] {
  return text.split('\n').map((line) => annotateLine(line, o));
}

/**
 * A text with a romanization under it, in the stretches it is drawn in where it flows (a strip's line): at its spaces,
 * which stay stretches of their own, and Japanese, which has none, between its words. A stretch and its romanization
 * are a block, which wraps as text first and romanization after: of a sentence that wraps, a strip showing one line
 * showed the romanization alone, or its text under the romanization of all of it (2026-10-06, 2026-10-31).
 */
export function romanStretches(text: string, o: Pick<AnnotateInputs, 'language' | 'chinese' | 'japanese'>): string[] {
  return text.split(/(\s+)/).filter(Boolean).flatMap((word) => readAs(word, o).flatMap((clause) => (o.japanese && clause.language === 'ja' ? japaneseStretches(clause.text, o.japanese) : [clause.text])));
}

/** Whether annotating this text needs the Japanese dictionary: it is asked for, and a line of it would be read as Japanese. */
export function needsJapanese(text: string, o: Pick<AnnotateInputs, 'furigana' | 'roman' | 'romanOff' | 'language' | 'chinese'>): boolean {
  if (!o.furigana && !romanFor('ja', o)) return false;
  return text.split('\n').some((line) => readAs(line, o).some((clause) => clause.language === 'ja'));
}

/**
 * Lines with their last reading held back: of a sentence still being heard, the last word may change yet - a
 * dictionary reads it from what follows (行っ: いっ or おこなっ), and recognition rewrites it - so its reading
 * would come and go. It shows once the sentence is final (as upstream's `holdLastReading`, kizuna-ai-lab/sokuji).
 */
export function holdLastReading(lines: readonly AnnotatedLine[]): readonly AnnotatedLine[] {
  for (let l = lines.length - 1; l >= 0; l--) {
    const parts = lines[l].parts;
    for (let p = parts.length - 1; p >= 0; p--) {
      if (parts[p].ruby === undefined) continue;
      const held = parts.map((part, i) => (i === p ? { text: part.text } : part));
      return lines.map((line, i) => (i === l ? { ...line, parts: held } : line));
    }
  }
  return lines;
}
