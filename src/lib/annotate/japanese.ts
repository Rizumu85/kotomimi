/**
 * Japanese reading aids from a tokenized sentence: hiragana over each run of
 * kanji, and a Hepburn line. The tokenizer gives each word's reading as a
 * whole; the furigana is cut out of it by the kana the word is written with
 * (食べる / タベル → 食[た]べる). Pure: the tokenizer is handed in.
 */
import { toRomaji } from 'wanakana';
import { correctReadings } from './japaneseReadings';
import { KANJI } from './script';
import type { AnnotatedLine, AnnotateOptions, JapaneseToken, JapaneseTokenizer, RubyPart } from './types';

/** Katakana as hiragana; everything else, the long-vowel mark included, as it is. */
export function katakanaToHiragana(text: string): string {
  return text.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isKanji = (char: string) => KANJI.test(char);

/** A word's runs, in order: kanji, or anything else. */
function runs(surface: string): Array<{ text: string; kanji: boolean }> {
  const out: Array<{ text: string; kanji: boolean }> = [];
  for (const char of surface) {
    const kanji = isKanji(char);
    const last = out[out.length - 1];
    if (last && last.kanji === kanji) last.text += char;
    else out.push({ text: char, kanji });
  }
  return out;
}

/**
 * One word as ruby parts. Its kana are anchors in the reading, and each run
 * of kanji takes what lies between them: お買い物 / オカイモノ → お 買[か] い
 * 物[もの]. When the kana do not line up with the reading — an irregular
 * spelling — the whole word carries the whole reading. A word with no
 * kanji, or no reading, is drawn plain.
 */
export function furiganaParts(surface: string, reading: string | undefined): RubyPart[] {
  if (!reading || reading === '*' || !KANJI.test(surface)) return [{ text: surface }];
  const hiragana = katakanaToHiragana(reading);
  const pieces = runs(surface);
  const pattern = pieces.map((p) => (p.kanji ? '(.+)' : escape(katakanaToHiragana(p.text)))).join('');
  const match = new RegExp(`^${pattern}$`).exec(hiragana);
  if (!match) return [{ text: surface, ruby: hiragana }];
  let group = 0;
  return pieces.map((p) => (p.kanji ? { text: p.text, ruby: match[++group] } : { text: p.text }));
}

/** The particles written with one kana and said with another. */
const PARTICLES: Readonly<Record<string, string>> = { は: 'wa', へ: 'e', を: 'o' };
/** The conjunctive particles written onto the verb before them: 行って, 読んで, 行けば. */
const JOINED_PARTICLES = new Set(['て', 'で', 'ば', 'ちゃ', 'じゃ', 'たり', 'だり']);
const PUNCTUATION = /^[\s\p{P}\p{S}]+$/u;

/** Whether a token is written onto the word before it: an auxiliary (ます, た, ない), a joined particle, a suffix. */
function joins(token: JapaneseToken): boolean {
  // The copula is a word of its own (yoi desu, shizuka da); the other auxiliaries are endings (ikimasu, itta, ikanai).
  if (token.pos === '助動詞') return token.basic_form !== 'です' && token.basic_form !== 'だ';
  if (token.pos === '助詞' && token.pos_detail_1 === '接続助詞' && JOINED_PARTICLES.has(token.surface_form)) return true;
  return token.pos_detail_1 === '接尾';
}

/** A token's sound in kana, for the romanization: its reading, or itself when the dictionary has none. */
function kana(token: JapaneseToken): string {
  return token.reading && token.reading !== '*' ? token.reading : token.surface_form;
}

/**
 * A sentence in Hepburn, word by word: a word is a token and what is written
 * onto it, romanized as one so a doubled consonant crosses the joint (行っ +
 * て → itte). は, へ and を as particles are wa, e and o. Punctuation stays
 * on the word before it.
 */
export function romaji(tokens: readonly JapaneseToken[]): string {
  const words: string[] = [];
  let word = '';
  const flush = () => {
    if (word) words.push(toRomaji(word));
    word = '';
  };
  for (const token of tokens) {
    const surface = token.surface_form;
    if (PUNCTUATION.test(surface)) {
      flush();
      const mark = toRomaji(surface).trim();
      if (!mark) continue;
      if (words.length > 0) words[words.length - 1] += mark;
      else words.push(mark);
      continue;
    }
    if (token.pos === '助詞' && PARTICLES[surface] !== undefined) {
      flush();
      words.push(PARTICLES[surface]);
      continue;
    }
    if (!joins(token)) flush();
    word += kana(token);
  }
  flush();
  return words.join(' ');
}

/** One line of Japanese, annotated as asked. */
export function annotateJapanese(line: string, tokenizer: JapaneseTokenizer, options: AnnotateOptions): AnnotatedLine {
  // The dictionary's readings, with the ones everyday speech gives differently put right (`japaneseReadings.ts`).
  const tokens = correctReadings(tokenizer.tokenize(line));
  const parts: RubyPart[] = [];
  for (const token of tokens) {
    for (const part of options.furigana ? furiganaParts(token.surface_form, token.reading) : [{ text: token.surface_form }]) {
      const last = parts[parts.length - 1];
      // Plain runs are drawn as one, so a line with no reading to show is one text node.
      if (last && last.ruby === undefined && part.ruby === undefined) last.text += part.text;
      else parts.push(part);
    }
  }
  return { parts, ...(options.roman ? { roman: romaji(tokens) } : {}) };
}
