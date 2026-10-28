// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import { annotateLine, annotateText, holdLastReading, needsJapanese } from './annotate';
import { annotateJapanese, furiganaParts, katakanaToHiragana, romaji } from './japanese';
import { buildJapaneseTokenizer } from './japaneseTokenizer';
import { romanizeKorean } from './korean';
import { transliterateRussian } from './russian';
import { transliterateUkrainian } from './ukrainian';
import { annotateChinese } from './chinese';
import { annotatedLanguage, explainsInChinese, isChinese, quotesJapanese, scriptLanguage } from './script';
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
    expect(annotatedLanguage('zh-CN')).toBe('zh');
    expect(annotatedLanguage('uk')).toBe('uk');
    for (const other of ['yue', 'en', 'auto', '', null, undefined]) expect(annotatedLanguage(other)).toBeNull();
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

  it('leaves a Chinese sentence that quotes Japanese alone, in a Chinese row: feedback explains in Chinese', () => {
    expect(isChinese('zh-CN')).toBe(true);
    expect(isChinese('zh_TW')).toBe(true);
    expect(isChinese('ja')).toBe(false);
    // What no Japanese sentence holds, or kana as a small part of the line.
    expect(quotesJapanese('“一度”后面接动词时要用过去式“見た”，不能用现在时“見ます”。')).toBe(true);
    expect(quotesJapanese('“は”和“が”的区别：这里应该用“が”。')).toBe(true);
    expect(quotesJapanese('動詞時態與過去時間不符，“見ます”要改成“見た”。')).toBe(true);
    // The corrected sentence above the explanation is Japanese, however many kanji it holds.
    expect(quotesJapanese('一度映画を見た。とても面白かったです。')).toBe(false);
    expect(quotesJapanese('東京大学卒業予定です')).toBe(false);
    // Fork (2026-10-21): in a row of any language — the feedback's explanation sits in the practised language's row.
    expect(needsJapanese('“見ます”要改成“見た”。这里时态不对。', { furigana: true, roman: false, language: null, chinese: true })).toBe(false);
    expect(needsJapanese('“見ます”要改成“見た”。这里时态不对。', { furigana: true, roman: false, language: null })).toBe(false);
    expect(needsJapanese('一度映画を見た。\n“見ます”要改成“見た”。这里时态不对。', { furigana: true, roman: false, language: null, chinese: true })).toBe(true);
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

describe('pinyin over Chinese, and Ukrainian by its own system (upstream #632)', () => {
  const ZH = { furigana: true, roman: false, pinyin: true };
  it('puts tone-marked pinyin over each Han character, taking a polyphone’s reading from its words', () => {
    expect(annotateChinese('我们去银行吧。')).toEqual([
      { text: '我', ruby: 'wǒ' }, { text: '们', ruby: 'men' }, { text: '去', ruby: 'qù' }, { text: '银', ruby: 'yín' }, { text: '行', ruby: 'háng' }, { text: '吧', ruby: 'ba' }, { text: '。' },
    ]);
    // What is not Chinese stays one part.
    expect(annotateChinese('用 VRChat 玩')).toEqual([{ text: '用', ruby: 'yòng' }, { text: ' VRChat ' }, { text: '玩', ruby: 'wán' }]);
  });

  it('gives pinyin to a line of a Chinese row only when it is asked for, and never to Japanese or Cantonese', () => {
    expect(annotateLine('你好', { ...ZH, language: 'zh', chinese: true }).parts).toEqual([{ text: '你', ruby: 'nǐ' }, { text: '好', ruby: 'hǎo' }]);
    expect(annotateLine('你好', { ...ZH, pinyin: false, language: 'zh', chinese: true })).toEqual({ parts: [{ text: '你好' }] });
    // Han characters alone in a row of another language, or with no language, are not read as Chinese.
    expect(annotateLine('大丈夫', { ...ZH, language: null })).toEqual({ parts: [{ text: '大丈夫' }] });
    expect(annotatedLanguage('yue')).toBeNull();
    expect(annotatedLanguage('zh-TW')).toBe('zh');
  });

  it('writes Ukrainian by the 2010 national system, word-initial letters apart', () => {
    expect(transliterateUkrainian('Згода')).toBe('Zghoda');
    expect(transliterateUkrainian('Київ, Україна')).toBe('Kyiv, Ukraina');
    expect(transliterateUkrainian('Ярослав їжак')).toBe('Yaroslav yizhak');
    expect(transliterateUkrainian("м'ясо, сім'я")).toBe('miaso, simia');
    expect(transliterateUkrainian('Добрий день')).toBe('Dobryi den');
  });

  it('tells a Ukrainian line by its own letters, or by the row, and keeps the Russian table for Russian', () => {
    expect(scriptLanguage('Україна')).toBe('uk');
    expect(scriptLanguage('Россия')).toBe('ru');
    expect(annotateLine('Добрий день', { furigana: false, roman: true, language: 'uk' }).roman).toBe('Dobryi den');
    expect(annotateLine('Добрый день', { furigana: false, roman: true, language: 'ru' }).roman).toBe("Dobryy den'");
  });
});

describe('a Chinese explanation that quotes Japanese, in a row of any language (2026-10-21)', () => {
  const FEEDBACK = '“に”后面缺少动词，句子不完整；用“について”表示“关于”。';
  it('is told apart from Japanese, which keeps its readings', () => {
    expect(explainsInChinese(FEEDBACK)).toBe(true);
    expect(explainsInChinese('还要加上“と”才对。')).toBe(true);
    // Kana outside the quotes: Japanese, quoting.
    expect(explainsInChinese('「行こう」と言った。')).toBe(false);
    // A short line of kanji alone stays the row's: 大丈夫 in a Japanese row keeps its reading.
    expect(explainsInChinese('大丈夫')).toBe(false);
  });

  it('gets no readings in the practised language row', () => {
    const tokenizer = { tokenize: () => [] };
    const line = annotateLine(FEEDBACK, { furigana: true, roman: true, language: 'ja', japanese: tokenizer });
    expect(line).toEqual({ parts: [{ text: FEEDBACK }] });
  });
});

describe('holdLastReading (fork)', () => {
  it('holds back the last reading of a sentence still being heard, and leaves the rest and the romanization', () => {
    const lines = [
      { parts: [{ text: '今日', ruby: 'きょう' }, { text: 'は' }], roman: 'kyou wa' },
      { parts: [{ text: '東京', ruby: 'とうきょう' }, { text: 'に' }, { text: '行', ruby: 'い' }, { text: 'って' }], roman: 'toukyou ni itte' },
    ];
    expect(holdLastReading(lines)).toEqual([
      lines[0],
      { parts: [{ text: '東京', ruby: 'とうきょう' }, { text: 'に' }, { text: '行' }, { text: 'って' }], roman: 'toukyou ni itte' },
    ]);
    // Nothing read: as it is.
    const bare = [{ parts: [{ text: 'hello' }] }];
    expect(holdLastReading(bare)).toBe(bare);
  });
});
