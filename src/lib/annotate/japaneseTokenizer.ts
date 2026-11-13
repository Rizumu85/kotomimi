/**
 * The Japanese tokenizer (kuromoji, IPADIC), built from its twelve
 * dictionary files however the caller reads them: by URL in the app
 * (`japaneseDictionary.ts`), from disk in a test. kuromoji's own builder
 * takes one directory path and fetches fixed names under it; the app's
 * files are hashed assets with no common directory, so the loader's file
 * reader is replaced instead.
 */
import DictionaryLoader from '@sglkc/kuromoji/src/loader/DictionaryLoader';
import Tokenizer from '@sglkc/kuromoji/src/Tokenizer';
import type { JapaneseToken, JapaneseTokenizer } from './types';

/** One dictionary file by its name (`base.dat.gz`), already gunzipped. */
export type DictionaryFile = (name: string) => Promise<ArrayBufferLike>;

const DIGITS = /^[0-9０-９]+$/;
const isDigits = (token: JapaneseToken): boolean => token.pos === '名詞' && token.pos_detail_1 === '数' && DIGITS.test(token.surface_form);

/**
 * Fork: a number in full-width digits as one word with no reading, as the dictionary gives one in plain digits (20).
 * It has each full-width digit as a word of its own, read by itself: ２０日 came out に, ぜろ, にち, and the readings
 * a number and its counter are given together (`japaneseReadings.ts`) fell on the last digit alone. One digit stays
 * the dictionary's word. The same array when nothing is joined.
 */
export function digitsWhole(tokens: JapaneseToken[]): JapaneseToken[] {
  if (!tokens.some((token, at) => at > 0 && isDigits(token) && isDigits(tokens[at - 1]))) return tokens;
  const out: JapaneseToken[] = [];
  for (const token of tokens) {
    const last = out[out.length - 1];
    if (last && isDigits(token) && isDigits(last)) {
      const { reading: _read, basic_form: _basic, ...rest } = last;
      out[out.length - 1] = { ...rest, surface_form: last.surface_form + token.surface_form };
    } else out.push(token);
  }
  return out;
}

export function buildJapaneseTokenizer(file: DictionaryFile): Promise<JapaneseTokenizer> {
  return new Promise((resolve, reject) => {
    const loader = new DictionaryLoader('');
    loader.loadArrayBuffer = (url, done) => {
      file(url.split('/').pop() ?? url).then((buffer) => done(null, buffer), (error) => done(error, null));
    };
    loader.load((error, dictionaries) => {
      if (error) reject(error instanceof Error ? error : new Error(String(error)));
      else {
        const tokenizer = new Tokenizer(dictionaries);
        resolve({ tokenize: (text) => digitsWhole(tokenizer.tokenize(text)) });
      }
    });
  });
}
