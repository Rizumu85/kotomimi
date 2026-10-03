// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import { annotateLine, annotateText, needsJapanese } from './annotate';
import { annotateJapanese, furiganaParts, katakanaToHiragana, romaji } from './japanese';
import { buildJapaneseTokenizer } from './japaneseTokenizer';
import { romanizeKorean } from './korean';
import { transliterateRussian } from './russian';
import { annotatedLanguage, scriptLanguage } from './script';
import type { JapaneseTokenizer } from './types';

const DICT = resolve(__dirname, '../../../node_modules/@sglkc/kuromoji/dict');
/** The real dictionary, read from disk: the app reads the same files by URL (`japaneseDictionary.ts`). */
const fromDisk = async (name: string) => {
  const data = gunzipSync(readFileSync(resolve(DICT, name)));
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
};

let ja: JapaneseTokenizer;
beforeAll(async () => { ja = await buildJapaneseTokenizer(fromDisk); }, 60_000);

const ruby = (parts: ReadonlyArray<{ text: string; ruby?: string }>) => parts.map((p) => (p.ruby ? `${p.text}[${p.ruby}]` : p.text)).join('');
const BOTH = { furigana: true, roman: true };

describe('the script a line is written in', () => {
  it('reads kana as Japanese, Hangul as Korean, Cyrillic as Russian, and nothing else', () => {
    expect(scriptLanguage('今日は')).toBe('ja');
    expect(scriptLanguage('コーヒー')).toBe('ja');
    expect(scriptLanguage('안녕하세요')).toBe('ko');
    expect(scriptLanguage('Привет')).toBe('ru');
    expect(scriptLanguage('大丈夫')).toBeNull();
    expect(scriptLanguage('今天天气真好')).toBeNull();
    expect(scriptLanguage('Hello')).toBeNull();
  });

  it('reads an app language code by its base', () => {
    expect(annotatedLanguage('ja')).toBe('ja');
    expect(annotatedLanguage('ja-JP')).toBe('ja');
    expect(annotatedLanguage('ko_KR')).toBe('ko');
    expect(annotatedLanguage('ru')).toBe('ru');
    for (const other of ['zh-CN', 'en', 'auto', '', null, undefined]) expect(annotatedLanguage(other)).toBeNull();
  });
});

describe('furigana for one word', () => {
  it('puts the reading over the kanji alone, the word\'s own kana as anchors', () => {
    expect(ruby(furiganaParts('食べる', 'タベル'))).toBe('食[た]べる');
    expect(ruby(furiganaParts('お買い物', 'オカイモノ'))).toBe('お買[か]い物[もの]');
    expect(ruby(furiganaParts('東京', 'トウキョウ'))).toBe('東京[とうきょう]');
    expect(ruby(furiganaParts('行っ', 'イッ'))).toBe('行[い]っ');
    expect(ruby(furiganaParts('見に行く', 'ミニイク'))).toBe('見[み]に行[い]く');
  });

  it('leaves a word with no kanji, or no reading, plain', () => {
    expect(furiganaParts('です', 'デス')).toEqual([{ text: 'です' }]);
    expect(furiganaParts('コーヒー', 'コーヒー')).toEqual([{ text: 'コーヒー' }]);
    expect(furiganaParts('謎語', undefined)).toEqual([{ text: '謎語' }]);
    expect(furiganaParts('謎語', '*')).toEqual([{ text: '謎語' }]);
  });

  it('gives the whole word the whole reading when its kana do not line up with it', () => {
    expect(furiganaParts('今日は', 'コンニチワ')).toEqual([{ text: '今日は', ruby: 'こんにちわ' }]);
  });

  it('turns katakana into hiragana and leaves the rest', () => {
    expect(katakanaToHiragana('トウキョウ・コーヒー')).toBe('とうきょう・こーひー');
  });
});

describe('a Japanese sentence', () => {
  it('gets hiragana over every kanji run and none over kana', () => {
    const line = annotateJapanese('今日は天気がとても良いです。', ja, { furigana: true, roman: false });
    expect(ruby(line.parts)).toBe('今日[きょう]は天気[てんき]がとても良[よ]いです。');
    expect(line.roman).toBeUndefined();
  });

  it('is one plain part when no reading is asked for', () => {
    expect(annotateJapanese('公園に行きましょう。', ja, { furigana: false, roman: false }).parts).toEqual([{ text: '公園に行きましょう。' }]);
  });

  it('romanizes word by word: particles as they are said, auxiliaries joined, a doubled consonant across the joint', () => {
    expect(romaji(ja.tokenize('今日は天気がとても良いです。'))).toBe('kyou wa tenki ga totemo yoi desu.');
    expect(romaji(ja.tokenize('公園に行って散歩しましょう。'))).toBe('kouen ni itte sanpo shimashou.');
    expect(romaji(ja.tokenize('東京へ行きたいのですが、切符を買えますか？'))).toBe('toukyou e ikitai no desu ga, kippu o kaemasu ka?');
  });

  it('carries both aids at once', () => {
    const line = annotateJapanese('経費精算', ja, BOTH);
    expect(ruby(line.parts)).toBe('経費[けいひ]精算[せいさん]');
    expect(line.roman).toBe('keihi seisan');
  });
});

describe('Korean and Russian', () => {
  it('romanizes Korean by pronunciation and keeps what is not Hangul', () => {
    expect(romanizeKorean('안녕하세요, 만나서 반갑습니다.')).toBe('annyeonghaseyo, mannaseo bangapseumnida.');
    expect(romanizeKorean('백마')).toBe('baengma');
  });

  it('transliterates Russian letter by letter, keeping case and punctuation', () => {
    expect(transliterateRussian('Привет, как дела?')).toBe('Privet, kak dela?');
    expect(transliterateRussian('Спасибо большое')).toBe("Spasibo bol'shoye");
    expect(transliterateRussian('Щука ест ёжика')).toBe('Shchuka yest yozhika');
    expect(transliterateRussian('объект')).toBe('obyekt');
  });
});

describe('a text, line by line', () => {
  const o = (language: 'ja' | 'ko' | 'ru' | null, opts = BOTH) => ({ ...opts, language, japanese: ja });

  it('is plain when nothing is asked for', () => {
    expect(annotateLine('今日は天気です', { furigana: false, roman: false, language: 'ja', japanese: ja })).toEqual({ parts: [{ text: '今日は天気です' }] });
  });

  it('reads a line of Han characters alone as Japanese only in a Japanese row', () => {
    expect(ruby(annotateLine('大丈夫', o('ja')).parts)).toBe('大丈夫[だいじょうぶ]');
    expect(annotateLine('大丈夫', o(null))).toEqual({ parts: [{ text: '大丈夫' }] });
  });

  it('annotates a mixed row by each line\'s own script: a corrected sentence over its explanation', () => {
    const lines = annotateText('昨日映画を見ました。\n“看了”要用过去式。', o(null));
    expect(ruby(lines[0].parts)).toBe('昨日[きのう]映画[えいが]を見[み]ました。');
    expect(lines[0].roman).toBe('kinou eiga o mimashita.');
    expect(lines[1]).toEqual({ parts: [{ text: '“看了”要用过去式。' }] });
  });

  it('gives Korean and Russian a romanization line, and only when it is asked for', () => {
    expect(annotateLine('감사합니다', o(null))).toEqual({ parts: [{ text: '감사합니다' }], roman: 'gamsahamnida' });
    expect(annotateLine('Спасибо', o('ru'))).toEqual({ parts: [{ text: 'Спасибо' }], roman: 'Spasibo' });
    expect(annotateLine('감사합니다', o(null, { furigana: true, roman: false }))).toEqual({ parts: [{ text: '감사합니다' }] });
  });

  it('draws Japanese plain until the dictionary has loaded', () => {
    expect(annotateLine('今日は天気です', { ...BOTH, language: 'ja' })).toEqual({ parts: [{ text: '今日は天気です' }] });
  });

  it('says whether a text needs the dictionary', () => {
    expect(needsJapanese('今日は', { ...BOTH, language: null })).toBe(true);
    expect(needsJapanese('大丈夫', { ...BOTH, language: 'ja' })).toBe(true);
    expect(needsJapanese('大丈夫', { ...BOTH, language: null })).toBe(false);
    expect(needsJapanese('감사합니다', { ...BOTH, language: 'ko' })).toBe(false);
    expect(needsJapanese('今日は', { furigana: false, roman: false, language: 'ja' })).toBe(false);
  });
});
