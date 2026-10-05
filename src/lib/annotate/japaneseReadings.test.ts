// @vitest-environment node
// Fork: the readings everyday speech gives, where the dictionary gives another. Against the real dictionary: what a
// rule has to recognize is how the dictionary cuts and reads the sentence, and only it can say.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import { annotateJapanese, katakanaToHiragana } from './japanese';
import { correctReadings } from './japaneseReadings';
import { buildJapaneseTokenizer } from './japaneseTokenizer';
import type { JapaneseToken, JapaneseTokenizer } from './types';

const DICT = resolve(__dirname, '../../../node_modules/@sglkc/kuromoji/dict');
const fromDisk = async (name: string) => {
  const data = gunzipSync(readFileSync(resolve(DICT, name)));
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
};

let ja: JapaneseTokenizer;
beforeAll(async () => { ja = await buildJapaneseTokenizer(fromDisk); }, 60_000);

/** A line as it is read aloud, in hiragana: what stands over the kanji, and the kana as written. */
const read = (line: string) => annotateJapanese(line, ja, { furigana: true, roman: false }).parts.map((p) => p.ruby ?? katakanaToHiragana(p.text)).join('');
const roman = (line: string) => annotateJapanese(line, ja, { furigana: false, roman: true }).roman;
/** As the dictionary alone reads it. */
const plain = (line: string) => ja.tokenize(line).map((t) => katakanaToHiragana(t.reading && t.reading !== '*' ? t.reading : t.surface_form)).join('');

describe('a number and its counter', () => {
  it('doubles the counter’s first sound after 一, 六, 八, 十 and 百', () => {
    expect(plain('一回だけ')).toBe('いちかいだけ');
    expect(read('一回だけ')).toBe('いっかいだけ');
    expect(read('一個目に入れました')).toBe('いっこめにいれました');
    expect(read('もう一種類ある')).toBe('もういっしゅるいある');
    expect(read('一週間')).toBe('いっしゅうかん');
    expect(read('一ヶ月')).toBe('いっかげつ');
    expect(read('一歳')).toBe('いっさい');
    expect(read('一点')).toBe('いってん');
    expect(read('一着')).toBe('いっちゃく');
    expect(read('六回')).toBe('ろっかい');
    expect(read('八回')).toBe('はっかい');
    expect(read('八歳')).toBe('はっさい');
    expect(read('十個')).toBe('じゅっこ');
    expect(read('十歳')).toBe('じゅっさい');
    expect(read('百回')).toBe('ひゃっかい');
    expect(read('二十一回')).toBe('にじゅういっかい');
    expect(read('二十回')).toBe('にじゅっかい');
  });

  it('and turns は-row counters into ぱ-row ones there', () => {
    expect(read('一本ください')).toBe('いっぽんください');
    expect(read('一匹いる')).toBe('いっぴきいる');
    expect(read('一発')).toBe('いっぱつ');
    expect(read('一泊')).toBe('いっぱく');
    expect(read('六本')).toBe('ろっぽん');
    expect(read('八匹')).toBe('はっぴき');
    expect(read('十匹')).toBe('じゅっぴき');
    expect(read('百本')).toBe('ひゃっぽん');
    expect(read('あと十分で着く')).toBe('あとじゅっぷんでつく');
    expect(read('六百円')).toBe('ろっぴゃくえん');
    expect(read('八百円')).toBe('はっぴゃくえん');
  });

  it('leaves the numerals and counters that do not double as they are', () => {
    expect(read('六歳')).toBe('ろくさい');
    expect(read('一日中')).toBe('いちにちじゅう');
    expect(read('一話')).toBe('いちわ');
    expect(read('二回')).toBe('にかい');
    expect(read('五本')).toBe('ごほん');
    // 十三 is not じゅっさん: only the units a numeral multiplies.
    expect(read('十三回')).toBe('じゅうさんかい');
    // Enough, not ten minutes: a word of the dictionary's own.
    expect(read('もう十分です')).toBe('もうじゅうぶんです');
  });

  it('voices the counter after 三 and 何', () => {
    expect(read('三本')).toBe('さんぼん');
    expect(read('二三本作ってる')).toBe('にさんぼんつくってる');
    expect(read('三匹')).toBe('さんびき');
    expect(read('三杯')).toBe('さんばい');
    expect(read('何杯')).toBe('なんばい');
    expect(read('三分')).toBe('さんぷん');
    expect(read('四分')).toBe('よんぷん');
    expect(read('三階')).toBe('さんがい');
    expect(read('三百円')).toBe('さんびゃくえん');
    expect(read('三千円')).toBe('さんぜんえん');
    expect(read('何千')).toBe('なんぜん');
    expect(read('三百回')).toBe('さんびゃっかい');
    expect(read('三人')).toBe('さんにん');
  });

  it('counts people and native counters with ひと and ふた', () => {
    expect(plain('一人で')).toBe('いちにんで');
    expect(read('一人で')).toBe('ひとりで');
    expect(read('俺も一人呼んでる')).toBe('おれもひとりよんでる');
    expect(read('二人とも')).toBe('ふたりとも');
    expect(read('十一人')).toBe('じゅういちにん');
    expect(read('一通りやった')).toBe('ひととおりやった');
    expect(read('二通りある')).toBe('ふたとおりある');
  });

  it('is romanized as it is read', () => {
    expect(roman('一回だけ')).toBe('ikkai dake');
    expect(roman('三本')).toBe('sanbon');
    expect(roman('一人で')).toBe('hitori de');
  });
});

describe('a word with two readings', () => {
  it('reads 行った as いった, and as おこなった only after an object', () => {
    expect(plain('さっき行ったとこ')).toBe('さっきおこなったとこ');
    expect(read('さっき行ったとこ')).toBe('さっきいったとこ');
    expect(read('行ったそばから')).toBe('いったそばから');
    expect(read('イベントを行った')).toBe('いべんとをおこなった');
  });

  it('reads 今 before a noun as いま, and as こん only before the few words that take it', () => {
    expect(plain('今配信してる')).toBe('こんはいしんしてる');
    expect(read('今配信してる')).toBe('いまはいしんしてる');
    expect(read('今三つ上がってます')).toBe('いまみっつあがってます');
    expect(read('今シーズン')).toBe('こんしーずん');
    expect(read('今大会')).toBe('こんたいかい');
    expect(read('今年')).toBe('ことし');
  });

  it('reads 方 as a person where it is one, and as a side where two are compared', () => {
    expect(read('こういう方が増えた')).toBe('こういうかたがふえた');
    expect(read('こういう方がいい')).toBe('こういうほうがいい');
    expect(read('配信されている方ですね')).toBe('はいしんされているかたですね');
    expect(read('来てくれてる方なんだね')).toBe('きてくれてるかたなんだね');
    expect(read('この方は先生です')).toBe('このかたはせんせいです');
    expect(read('この方が早い')).toBe('このほうがはやい');
    expect(read('した方がいい')).toBe('したほうがいい');
    expect(read('行った方がいい')).toBe('いったほうがいい');
  });

  it('reads 何 as なん before だ, で and の, and as なに elsewhere', () => {
    expect(read('何でもできちゃう')).toBe('なんでもできちゃう');
    expect(read('何だろう')).toBe('なんだろう');
    expect(read('何ですか')).toBe('なんですか');
    expect(read('何なの')).toBe('なんなの');
    expect(read('何の話')).toBe('なんのはなし');
    expect(read('何ていうあれ')).toBe('なんていうあれ');
    expect(read('何が起こった')).toBe('なにがおこった');
    expect(read('何これ')).toBe('なにこれ');
    expect(read('何か飲む')).toBe('なにかのむ');
    expect(read('何も')).toBe('なにも');
  });

  it('reads money as かね, and leaves gold its きん', () => {
    expect(read('金払えない')).toBe('かねはらえない');
    expect(read('金がない')).toBe('かねがない');
    expect(read('金を払う')).toBe('かねをはらう');
    expect(read('金の延べ棒')).toBe('きんののべぼう');
    expect(read('金メダル')).toBe('きんめだる');
    expect(read('お金がない')).toBe('おかねがない');
  });

  it('reads the words of place and time as they are said', () => {
    expect(read('この辺に置く')).toBe('このへんにおく');
    expect(read('ここの辺に')).toBe('ここのへんに');
    expect(read('この辺り')).toBe('このあたり');
    expect(read('この後プラベ行くよ')).toBe('このあとぷらべいくよ');
    expect(read('後は任せた')).toBe('あとはまかせた');
    expect(read('三日後')).toBe('みっかご');
    // A number in digits is given its reading where it is one nobody could guess: とおか.
    expect(read('8月10日なの')).toBe('8がつとおかなの');
    expect(read('月が綺麗')).toBe('つきがきれい');
    expect(read('そういう風に聞こえた')).toBe('そういうふうにきこえた');
    expect(read('風が強い')).toBe('かぜがつよい');
    expect(read('グループの中って')).toBe('ぐるーぷのなかって');
  });

  it('reads a noun that stands by itself with its own reading, not the one it has at the end of a compound', () => {
    expect(read('お腹の中空っぽ')).toBe('おなかのなかからっぽ');
    expect(read('じゃあ明日薬を飲もうかな')).toBe('じゃああしたくすりをのもうかな');
    expect(read('走るやつ水の上を')).toBe('はしるやつみずのうえを');
    expect(read('これで全種かな')).toBe('これでぜんしゅかな');
    expect(read('種を蒔く')).toBe('たねをまく');
    expect(read('柄的に')).toBe('がらてきに');
    expect(read('みんな足出すんですか')).toBe('みんなあしだすんですか');
    expect(read('三足')).toBe('さんそく');
    expect(read('これ上がショップの名前')).toBe('これうえがしょっぷのなまえ');
    expect(read('立場上言えない')).toBe('たちばじょういえない');
    expect(read('右下にいる')).toBe('みぎしたにいる');
    expect(read('リジョイン入り直す')).toBe('りじょいんはいりなおす');
    expect(read('映画観たり')).toBe('えいがみたり');
    expect(read('長ければ長いほど')).toBe('ながければながいほど');
    expect(read('日本人なのかな')).toBe('にほんじんなのかな');
    expect(read('日本に行く')).toBe('にほんにいく');
    expect(read('高音が出ない')).toBe('こうおんがでない');
  });
});

describe('the corrections', () => {
  it('change readings only: the words stay as the dictionary cut them', () => {
    const tokens = ja.tokenize('今配信してるから一回だけ行った方がいい') as JapaneseToken[];
    const fixed = correctReadings(tokens);
    expect(fixed.map((t) => t.surface_form)).toEqual(tokens.map((t) => t.surface_form));
    expect(fixed.map((t) => t.pos)).toEqual(tokens.map((t) => t.pos));
    // The dictionary's own tokens are not written on.
    expect(tokens.find((t) => t.surface_form === '今')?.reading).toBe('コン');
  });

  it('hand back the same tokens where nothing is to be changed', () => {
    const tokens = ja.tokenize('今日は天気がいいですね') as JapaneseToken[];
    expect(correctReadings(tokens)).toBe(tokens);
    expect(correctReadings([])).toEqual([]);
  });
});
