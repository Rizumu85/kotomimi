/** Fork: the two internals of `@sglkc/kuromoji` the tokenizer loader builds from (`japaneseTokenizer.ts`); the package types only its public builder. */
declare module '@sglkc/kuromoji/src/loader/DictionaryLoader' {
  class DictionaryLoader {
    constructor(dicPath: string);
    /** Replaced per instance: hands back one dictionary file, gunzipped. */
    loadArrayBuffer: (url: string, done: (error: unknown, buffer: ArrayBufferLike | null) => void) => void;
    load(done: (error: unknown, dictionaries: unknown) => void): void;
  }
  export default DictionaryLoader;
}

declare module '@sglkc/kuromoji/src/Tokenizer' {
  class Tokenizer {
    constructor(dictionaries: unknown);
    tokenize(text: string): Array<{ surface_form: string; reading?: string; pos: string; pos_detail_1: string; basic_form?: string }>;
  }
  export default Tokenizer;
}
