/**
 * Fork: reading aids for displayed text — furigana over kanji, and a
 * romanization line — computed on this device from the text alone. No model
 * and no network: a morphological dictionary for Japanese, pronunciation
 * rules for Korean, a letter table for Russian.
 */

/** A run of text, with the reading to draw above it when it has one. */
export interface RubyPart {
  text: string;
  ruby?: string;
}

/** One line as it is drawn: its parts in order, and its romanization when asked for and available. */
export interface AnnotatedLine {
  parts: RubyPart[];
  roman?: string;
}

/** The languages that have a reading aid here. */
export type AnnotatedLanguage = 'ja' | 'ko' | 'ru';

export interface AnnotateOptions {
  /** Hiragana over kanji (Japanese only). */
  furigana: boolean;
  /** A romanization line under the text. */
  roman: boolean;
}

/** One token of a Japanese sentence, as the tokenizer names it (kuromoji's IPADIC fields this module reads). */
export interface JapaneseToken {
  surface_form: string;
  /** Katakana; absent or `*` for a word the dictionary does not know. */
  reading?: string;
  pos: string;
  pos_detail_1: string;
  /** The dictionary form: です for でし. */
  basic_form?: string;
}

export interface JapaneseTokenizer {
  tokenize(text: string): JapaneseToken[];
}
