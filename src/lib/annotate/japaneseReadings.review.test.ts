// @vitest-environment node
// Fork: the cases of a review of `japaneseReadings.ts` against the real dictionary (2026-10-06; the report,
// REVIEW-japanese-readings.md, is on the branch claude/intelligent-bohr-4ha0y4, and FORK.md says what was done with
// it). Every case here is a line as the app would get it, and the reading a speaker gives it:
//   - "fired and was wrong": a rule changed the reading to a wrong one. Each is a condition that was narrowed.
//   - "keeps": readings that were right, and that the narrower or new rules must not break.
//   - "was not put right": misreadings no rule covered, with the rule that now does.
//   - "left alone": looked at, and left as the dictionary has them (skipped, with the reason).
//   - "found while putting these right": what the rules above did to lines the review did not have.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import { annotateJapanese, katakanaToHiragana } from './japanese';
import { buildJapaneseTokenizer } from './japaneseTokenizer';
import type { JapaneseTokenizer } from './types';

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

/** One `it` per line, so each line passes or fails by itself. */
const lines = (cases: ReadonlyArray<readonly [string, string]>) => {
  for (const [line, reading] of cases) it(`${line} → ${reading}`, () => expect(read(line)).toBe(reading));
};
const skipped = (cases: ReadonlyArray<readonly [string, string]>) => {
  // Skipped when the review wrote them; each is on now that its rule is there.
  for (const [line, reading] of cases) it(`${line} → ${reading}`, () => expect(read(line)).toBe(reading));
};

describe('fired and was wrong', () => {
  describe('方: この/その/あの方 before a particle other than が is a side or a choice, not a person', () => {
    lines([
      ['この方にする', 'このほうにする'],
      ['あの方に行こう', 'あのほうにいこう'],
      ['その方を選ぶ', 'そのほうをえらぶ'],
    ]);
  });

  describe('方: a plain verb, た or な before 方だ/方です is "tends to, is on the … side" (ほう), not a person', () => {
    lines([
      ['俺は結構食べる方だよ', 'おれはけっこうたべるほうだよ'],
      ['わりと寝る方です', 'わりとねるほうです'],
      ['人見知りする方なんだよね', 'ひとみしりするほうなんだよね'],
      ['よく喋る方だと思う', 'よくしゃべるほうだとおもう'],
      ['頑張った方だと思う', 'がんばったほうだとおもう'],
      ['結構食べた方だよ', 'けっこうたべたほうだよ'],
      ['まだマシな方だね', 'まだましなほうだね'],
    ]);
  });

  describe('何: と and って are なに where they are not quoting', () => {
    lines([
      ['何と戦ってるの', 'なにとたたかってるの'],
      ['え、何って？', 'え、なにって？'],
    ]);
  });

  describe('金: gold and Friday, beside 銀 or 土 or a colour', () => {
    lines([
      ['金と銀', 'きんとぎん'],
      ['金か銀か', 'きんかぎんか'],
      ['金と土', 'きんとど'],
      ['金は空いてる', 'きんはあいてる'],
      ['金に塗る', 'きんにぬる'],
    ]);
  });

  describe('観: -観 before the copula is a view (価値観), not 観る', () => {
    lines([
      ['価値観です', 'かちかんです'],
      ['世界観です', 'せかいかんです'],
      ['恋愛観だ', 'れんあいかんだ'],
      ['人生観だね', 'じんせいかんだね'],
    ]);
  });

  describe('声: after a noun or a verb stem the dictionary’s ごえ is right', () => {
    lines([
      ['アニメ声だね', 'あにめごえだね'],
      ['萌え声', 'もえごえ'],
      ['ロリ声', 'ろりごえ'],
      ['囁き声', 'ささやきごえ'],
    ]);
  });

  describe('水: -水 after a noun is すい (化粧水), whatever follows', () => {
    lines([
      ['化粧水が', 'けしょうすいが'],
      ['炭酸水を', 'たんさんすいを'],
      ['天然水が', 'てんねんすいが'],
    ]);
  });

  describe('風: どんな風 that blows is wind', () => {
    lines([['どんな風が吹いてる', 'どんなかぜがふいてる']]);
  });

  describe('柄: the handle of a tool', () => {
    lines([
      ['傘の柄', 'かさのえ'],
      ['ナイフの柄', 'ないふのえ'],
    ]);
  });

  describe('日本: cheering, which the rule’s own comment says keeps にっぽん', () => {
    lines([['がんばれ日本', 'がんばれにっぽん']]);
  });

  describe('counters: 十分 that means enough', () => {
    lines([
      ['それで十分', 'それでじゅうぶん'],
      ['時間は十分', 'じかんはじゅうぶん'],
      ['もう一時間で十分', 'もういちじかんでじゅうぶん'],
    ]);
  });

  describe('counters: 分目 is ぶんめ, and 八 before it does not double', () => {
    lines([['腹八分目にしとく', 'はらはちぶんめにしとく']]);
  });

  describe('counters: a school class (三年一組) is いちくみ, にくみ', () => {
    lines([
      ['三年一組', 'さんねんいちくみ'],
      ['三年二組', 'さんねんにくみ'],
    ]);
  });

  describe('counters: a katakana unit starting with は-row keeps it (ヘルツ, ヘクタール)', () => {
    lines([
      ['一ヘルツ', 'いちへるつ'],
      ['六ヘルツ', 'ろくへるつ'],
      ['百ヘルツ', 'ひゃくへるつ'],
      ['八ヘクタール', 'はちへくたーる'],
    ]);
  });
});

describe('romanized after a correction', () => {
  // A numeral read with a doubled last sound (ろっ, はっ, いっ) is romanized as a word by itself, so the doubling is
  // lost: 六百円 came out "ro pyakuen". The furigana was right; only the Hepburn line was broken.
  it.each([
    ['六百円', /roppyaku/],
    ['八百円', /happyaku/],
    ['八千円', /hassen/],
    ['一千円', /issen/],
    ['一兆円', /itchou/],
    ['一千万', /issen/],
  ] as const)('%s keeps its doubled consonant', (line, expected) => expect(roman(line)).toMatch(expected));
});

describe('keeps (a narrower or new rule must not break these)', () => {
  lines([
    // 方: the cases the rule was written for.
    ['配信されている方ですね', 'はいしんされているかたですね'],
    ['来てくれてる方なんだね', 'きてくれてるかたなんだね'],
    ['優勝された方です', 'ゆうしょうされたかたです'],
    ['来てくださった方です', 'きてくださったかたです'],
    ['この方は先生です', 'このかたはせんせいです'],
    ['この方が早い', 'このほうがはやい'],
    ['こういう方が増えた', 'こういうかたがふえた'],
    // 何, 金, 観, 声, 水, 風: the people's readings next to the cases above.
    ['何と言っても', 'なんといっても'],
    ['何の話', 'なんのはなし'],
    ['金がない', 'かねがない'],
    ['金かかる', 'かねかかる'],
    ['金で解決', 'かねでかいけつ'],
    ['金はある', 'かねはある'],
    ['金に困ってる', 'かねにこまってる'],
    ['映画観たり', 'えいがみたり'],
    ['アニメ観ます', 'あにめみます'],
    ['みんな声大きい', 'みんなこえおおきい'],
    ['これ声入ってる？', 'これこえはいってる？'],
    ['走るやつ水の上を', 'はしるやつみずのうえを'],
    ['毎日水を', 'まいにちみずを'],
    ['そういう風に聞こえた', 'そういうふうにきこえた'],
    ['どういう風に', 'どういうふうに'],
    ['柄が悪い', 'がらがわるい'],
    // Counters.
    ['あと十分で着く', 'あとじゅっぷんでつく'],
    ['あと十分待って', 'あとじゅっぷんまって'],
    ['三十分待った', 'さんじゅっぷんまった'],
    ['もう十分です', 'もうじゅうぶんです'],
    ['三分の一くらいかな', 'さんぶんのいちくらいかな'],
    ['一セット', 'いっせっと'],
    ['十センチくらい', 'じゅっせんちくらい'],
    ['一キロ走った', 'いっきろはしった'],
    ['二組のカップル', 'ふたくみのかっぷる'],
    ['一人一人', 'ひとりひとり'],
    ['一人分ちょうだい', 'ひとりぶんちょうだい'],
    // What the proposed rules below must leave alone.
    ['損害を被った', 'そんがいをこうむった'],
    ['本を開いて', 'ほんをひらいて'],
    ['メニュー開いて', 'めにゅーひらいて'],
    ['席空いてる', 'せきあいてる'],
    ['その他', 'そのた'],
    ['他人', 'たにん'],
    ['言われた通り', 'いわれたとおり'],
  ]);
});

// Ranked by how often the pattern comes up in casual talk (REVIEW-japanese-readings.md, "Misses").
describe('was not put right', () => {
  describe('1. 他 is ほか in talk; the dictionary always says た', () => {
    skipped([
      ['他の人', 'ほかのひと'],
      ['他に何かある？', 'ほかになにかある？'],
      ['他にも', 'ほかにも'],
      ['他は？', 'ほかは？'],
      ['他のワールド', 'ほかのわーるど'],
    ]);
  });

  describe('2. the days of the month and counted days: ふつか to とおか, はつか, よっか', () => {
    skipped([
      ['二日', 'ふつか'],
      ['三日', 'みっか'],
      ['四日間', 'よっかかん'],
      ['五日後', 'いつかご'],
      ['七日', 'なのか'],
      ['十日くらい', 'とおかくらい'],
      ['二十日', 'はつか'],
      ['二十四日', 'にじゅうよっか'],
      ['二日目', 'ふつかめ'],
      ['二泊三日', 'にはくみっか'],
    ]);
  });

  describe('3. この間, その間 are あいだ', () => {
    skipped([
      ['この間さ', 'このあいださ'],
      ['この間言ってた', 'このあいだいってた'],
      ['その間に', 'そのあいだに'],
    ]);
  });

  describe('4. お腹が空く is すく', () => {
    skipped([
      ['お腹空いた', 'おなかすいた'],
      ['お腹が空いてる', 'おなかがすいてる'],
      ['腹空いた', 'はらすいた'],
    ]);
  });

  describe('5. 入ろう is はいろう (the dictionary has it as one noun, 入牢)', () => {
    skipped([
      ['入ろう', 'はいろう'],
      ['一緒に入ろう', 'いっしょにはいろう'],
    ]);
  });

  describe('6. 被る is かぶる (an avatar, a hat, a character), こうむる only after を', () => {
    skipped([
      ['アバター被ってる', 'あばたーかぶってる'],
      ['帽子被った', 'ぼうしかぶった'],
      ['キャラ被り', 'きゃらかぶり'],
    ]);
  });

  describe('7. a counter after Arabic digits, as speech recognition often writes it', () => {
    skipped([
      ['3本', '3ぼん'],
      ['6本', '6ぽん'],
      ['10分', '10ぷん'],
      // The digits themselves are given the reading nobody could guess: 3 with か after it would say nothing.
      ['3日', 'みっか'],
    ]);
    it('1人, 2人 romanized as hitori, futari', () => {
      expect(roman('1人で')).toBe('hitori de');
      expect(roman('2人とも')).toBe('futari tomo');
    });
  });

  describe('9. 何 before 曜日 and 月 is なん, and 月 after it がつ', () => {
    skipped([
      ['何曜日', 'なんようび'],
      ['何月', 'なんがつ'],
      ['何月生まれ', 'なんがつうまれ'],
    ]);
  });

  describe('10. 十分 as minutes, where the dictionary has the word じゅうぶん', () => {
    skipped([
      ['十分後に集合ね', 'じゅっぷんごにしゅうごうね'],
      ['十分くらい', 'じゅっぷんくらい'],
      ['十分しか寝てない', 'じゅっぷんしかねてない'],
    ]);
  });

  describe('11. 金ない is かね (ない is an adjective, not a particle or verb)', () => {
    skipped([
      ['金ない', 'かねない'],
      ['金なくて', 'かねなくて'],
      ['金ないから', 'かねないから'],
    ]);
  });

  describe('12. 風 after という, って and a な-word is ふう', () => {
    skipped([
      ['という風に', 'というふうに'],
      ['って風に', 'ってふうに'],
      ['変な風に聞こえる', 'へんなふうにきこえる'],
    ]);
  });

  describe('13. 開く that is open, intransitive, is あく', () => {
    skipped([
      ['店開いてる？', 'みせあいてる？'],
      ['ドアが開いた', 'どあがあいた'],
    ]);
  });

  describe('14. 描く is かく in talk about drawing', () => {
    skipped([
      ['絵描いてる', 'えかいてる'],
      ['絵を描くの好き', 'えをかくのすき'],
    ]);
  });

  describe('15. single words the dictionary reads in their written-language form', () => {
    skipped([
      ['明後日行く', 'あさっていく'],
      ['入り口どこ？', 'いりぐちどこ？'],
      ['いつも通り', 'いつもどおり'],
      ['生声聞いた', 'なまごえきいた'],
      ['一声かけて', 'ひとこえかけて'],
    ]);
  });

  describe('16. 方 that is a person, where the rule does not see it', () => {
    skipped([
      ['知ってる方いますか', 'しってるかたいますか'],
      ['先生方', 'せんせいがた'],
      ['皆さん方', 'みなさんがた'],
    ]);
  });

  describe('17. native counters NATIVE names but never reaches: the dictionary tags them 名詞-一般 or サ変接続, not 接尾', () => {
    skipped([
      ['一手間かける', 'ひとてまかける'],
      ['一仕事終えた', 'ひとしごとおえた'],
      ['一工夫', 'ひとくふう'],
      ['一夏の思い出', 'ひとなつのおもいで'],
      ['一部屋空いてる', 'ひとへやあいてる'],
      ['一勝負しよう', 'ひとしょうぶしよう'],
    ]);
  });

  describe('18. less frequent', () => {
    skipped([
      ['一ページ目', 'いっぺーじめ'],
      ['一ポイント', 'いっぽいんと'],
      ['二十歳になった', 'はたちになった'],
      ['何なら', 'なんなら'],
      ['何と比べて', 'なにとくらべて'],
      ['日中', 'にっちゅう'],
      ['風邪薬', 'かぜぐすり'],
      ['両声類', 'りょうせいるい'],
      // Only where nothing follows it: 今日中に and 今日中だよ are already じゅう.
      ['今日中', 'きょうじゅう'],
    ]);
  });
});

// Looked at and left as the dictionary has them: the words around do not say which reading is meant, or both are said.
describe('left alone', () => {
  for (const [line, reading, why] of [
    ['一足遅かった', 'ひとあしおそかった', 'a pair of shoes (いっそく) is written the same'],
    // Rank 8 of the review. Speech recognition does write いつ this way: 「何時だかね」 was in what the app heard.
    ['何時まで', 'なんじまで', 'いつまで is written the same'],
    ['三桁', 'みけた', 'さんけた is said as often'],
    ['角を曲がって', 'かどをまがって', 'かく and つの are written the same, and only the meaning tells them apart'],
    ['表に出て', 'おもてにでて', 'a table (ひょう) is written the same'],
    ['他人事じゃない', 'ひとごとじゃない', 'たにんごと is said too'],
  ] as const) it.skip(`${line} → ${reading}: ${why}`, () => expect(read(line)).toBe(reading));
});

describe('found while putting these right', () => {
  describe('声: the voice itself after a name or a verb that describes it, as it was in what the app heard', () => {
    lines([
      ['あんま声真似という声真似', 'あんまこえまねというこえまね'],
      ['ムーイ声切った覚えない', 'むーいこえきったおぼえない'],
      ['笑う声がする', 'わらうこえがする'],
      ['アニメ声出して', 'あにめごえだして'],
    ]);
  });

  describe('開く and 被る: only what opens by itself is あく, and only what is suffered こうむる', () => {
    lines([
      ['花が開いた', 'はながひらいた'],
      ['差が開いた', 'さがひらいた'],
      ['目が開いてる', 'めがあいてる'],
      ['ドア開いて', 'どあひらいて'],
      ['帽子を被った', 'ぼうしをかぶった'],
      ['損害を被った', 'そんがいをこうむった'],
    ]);
  });

  describe('何と: an exclamation before a word of quality stays なんと', () => {
    lines([
      ['何と素晴らしい', 'なんとすばらしい'],
      ['何と比べて', 'なにとくらべて'],
    ]);
  });

  describe('風: a wind that is described is a wind', () => {
    lines([
      ['爽やかな風だ', 'さわやかなかぜだ'],
      ['ああいう風に', 'ああいうふうに'],
      ['どういう風？', 'どういうふう？'],
    ]);
  });

  describe('十分 at the end of what is said, after an hour, is minutes', () => {
    lines([
      ['今三時十分', 'いまさんじじゅっぷん'],
      ['五時十分です', 'ごじじゅっぷんです'],
    ]);
  });

  describe('a number in digits', () => {
    lines([
      // Given the reading nobody could guess, and shown it.
      ['10日', 'とおか'],
      ['20日間', 'はつかかん'],
      ['14日', 'じゅうよっか'],
      ['1人で', 'ひとりで'],
      ['20歳です', 'はたちです'],
      // Read as usual: the digits stand as they are, and only the counter changes.
      ['12人', '12にん'],
      ['3人', '3にん'],
      ['21本', '21ぽん'],
      ['100本', '100ぽん'],
      ['3階', '3がい'],
      ['4分', '4ぷん'],
      ['1ヘルツ', '1へるつ'],
      ['30日', '30にち'],
      // A full-width digit is a word the dictionary reads; it shows a reading only where that was changed.
      ['５個', '５こ'],
      ['８本', 'はっぽん'],
    ]);
    it('is romanized with the reading it was given', () => {
      expect(roman('10日')).toBe('tooka');
      expect(roman('二十日')).toBe('hatsuka');
      expect(roman('二十歳')).toBe('hatachi');
      expect(roman('3本')).toBe('3bon');
    });
  });

  describe('the days of the month keep にち where they are counted that way', () => {
    lines([
      ['十一日', 'じゅういちにち'],
      ['三十日', 'さんじゅうにち'],
      ['第三日', 'だいさんにち'],
      ['二日酔い', 'ふつかよい'],
    ]);
  });

  describe('single words', () => {
    lines([
      ['両声類なんだ', 'りょうせいるいなんだ'],
      ['日中は暑い', 'にっちゅうはあつい'],
      ['風邪薬飲んだ', 'かぜぐすりのんだ'],
      ['今まで通り', 'いままでどおり'],
      ['二十歳になった', 'はたちになった'],
      ['三年一組', 'さんねんいちくみ'],
      ['一パーセント', 'いっぱーせんと'],
      ['六パーセント', 'ろくぱーせんと'],
    ]);
  });
});
