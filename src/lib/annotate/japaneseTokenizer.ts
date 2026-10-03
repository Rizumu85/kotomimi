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
import type { JapaneseTokenizer } from './types';

/** One dictionary file by its name (`base.dat.gz`), already gunzipped. */
export type DictionaryFile = (name: string) => Promise<ArrayBufferLike>;

export function buildJapaneseTokenizer(file: DictionaryFile): Promise<JapaneseTokenizer> {
  return new Promise((resolve, reject) => {
    const loader = new DictionaryLoader('');
    loader.loadArrayBuffer = (url, done) => {
      file(url.split('/').pop() ?? url).then((buffer) => done(null, buffer), (error) => done(error, null));
    };
    loader.load((error, dictionaries) => {
      if (error) reject(error instanceof Error ? error : new Error(String(error)));
      else resolve(new Tokenizer(dictionaries));
    });
  });
}
