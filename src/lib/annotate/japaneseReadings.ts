/**
 * Fork: the readings the dictionary gets wrong in everyday speech, put right
 * from the words around them.
 *
 * The dictionary (IPADIC, 2007) reads each word by itself, and where a word
 * has two readings it gives the one that is commoner in newspapers: 行った
 * as おこなった, 今 before a noun as こん, 金 as きん. It also reads a
 * number and its counter apart, so the sound change between them is lost:
 * 一回 comes out いちかい. Measured on what the app showed of real VRChat
 * talk (FORK.md, "假名注音的读音修正"), these were the mistakes that came
 * back again and again; another dictionary (Sudachi) made as many of its
 * own. So the dictionary stays, and the words it misreads are read again
 * here, each by a rule that names what has to stand beside it.
 *
 * Pure: tokens in, tokens out, only `reading` changed. A rule that does not
 * recognize its case leaves the dictionary's reading alone.
 */
import type { JapaneseToken } from './types';

const K_ROW = 'カキクケコ';
const S_ROW = 'サシスセソ';
const T_ROW = 'タチツテト';
const H_ROW = 'ハヒフヘホ';
const P_ROW = 'パピプペポ';
const P_OF: Readonly<Record<string, string>> = { ハ: 'パ', ヒ: 'ピ', フ: 'プ', ヘ: 'ペ', ホ: 'ポ' };

/** The numerals whose last sound doubles the counter's first: the reading they then take, and before which rows. */
const DOUBLING: Readonly<Record<string, { from: string; to: string; rows: string }>> = {
  一: { from: 'イチ', to: 'イッ', rows: K_ROW + S_ROW + T_ROW + H_ROW },
  八: { from: 'ハチ', to: 'ハッ', rows: K_ROW + S_ROW + T_ROW + H_ROW },
  十: { from: 'ジュウ', to: 'ジュッ', rows: K_ROW + S_ROW + T_ROW + H_ROW },
  六: { from: 'ロク', to: 'ロッ', rows: K_ROW + H_ROW },
  百: { from: 'ヒャク', to: 'ヒャッ', rows: K_ROW + H_ROW },
};
/** The counters that are voiced after 三 and 何: 三本 is さんぼん, 何階 is なんがい. */
const AFTER_THREE: Readonly<Record<string, string>> = { 本: 'ボン', 匹: 'ビキ', 杯: 'バイ', 分: 'プン', 百: 'ビャク', 千: 'ゼン', 階: 'ガイ', 軒: 'ゲン', 発: 'パツ', 泊: 'パク', 歩: 'ポ' };
/**
 * The counters that are native words, and count with ひと and ふた: 一通り
 * is ひととおり, never いっとおり. Only the ones the dictionary leaves apart
 * from their numeral: 一言, 一口, 一息 and their like are words of its own,
 * and are read right as they are.
 */
const NATIVE = new Set(['通り', '切れ', '粒', '握り', '箱', '皿', '組', '桁', '袋', '束', '駅', '晩']);
/**
 * And the ones it takes for plain nouns after the numeral, not for counters
 * (一手間 as いち and てま). 押し is left out: 一押し, the pick of the lot, is
 * いちおし.
 */
const NATIVE_NOUNS = new Set(['部屋', '手間', '仕事', '工夫', '夏', '冬', '勝負', '泳ぎ', '踏ん張り', '頑張り', '巻き']);
/** And of both, the ones 二 is ふた before: 二通り, 二部屋. */
const NATIVE_TWO = new Set(['通り', '切れ', '粒', '握り', '箱', '皿', '組', '桁', '袋', '束', '部屋', '駅', '晩', '夏', '冬']);
/** The larger numerals a smaller one doubles into: 六百, 八千 — not 十三. */
const UNITS = new Set(['百', '千', '兆']);
/** The days counted the native way: 二日 is ふつか, 十日 とおか. Above ten only 十四日, 二十日 and 二十四日 are. */
const DAYS: Readonly<Record<number, string>> = { 2: 'フツ', 3: 'ミッ', 4: 'ヨッ', 5: 'イツ', 6: 'ムイ', 7: 'ナノ', 8: 'ヨウ', 9: 'ココノ', 10: 'トオ' };
const KANJI_DIGIT: Readonly<Record<string, number>> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
/** A full-width digit is a word the dictionary knows, and reads as it does the kanji: ８ is はち. */
const WIDE_DIGIT: Readonly<Record<string, string>> = { '１': '一', '２': '二', '３': '三', '４': '四', '５': '五', '６': '六', '７': '七', '８': '八', '９': '九' };

const DIGITS = /^[0-9０-９]+$/;
const KATAKANA_START = /^[ァ-ヶー]/;

const isNumeral = (t: JapaneseToken | undefined): boolean => t !== undefined && t.pos === '名詞' && t.pos_detail_1 === '数';
const isCounter = (t: JapaneseToken | undefined): boolean => t !== undefined && t.pos === '名詞' && (t.pos_detail_1 === '接尾' || (t.pos_detail_1 === '数' && UNITS.has(t.surface_form)) || t.surface_form === '種類');
const isCopula = (t: JapaneseToken | undefined): boolean => t !== undefined && t.pos === '助動詞' && (t.basic_form === 'だ' || t.basic_form === 'です');
/** A noun that names a thing, a deed or a quality — what a compound is made with. 毎日 is the dictionary's name of a newspaper, and is no such noun here. */
const isContentNoun = (t: JapaneseToken | undefined): boolean => t !== undefined && t.pos === '名詞' && ['一般', 'サ変接続', '形容動詞語幹', '固有名詞'].includes(t.pos_detail_1) && t.surface_form !== '毎日';
/** Nothing more is said after this word: the line ends, or a mark, a final particle or the copula follows. */
const closes = (t: JapaneseToken | undefined): boolean => t === undefined || t.pos === '記号' || t.pos_detail_1 === '終助詞' || isCopula(t);

/** この, こういう and their kin: what stands before 方 when it is a person, and before 辺 when it is へん. */
const THIS_KIND = new Set(['こういう', 'そういう', 'どういう', 'いろんな', '色んな', 'こんな', 'そんな', 'あんな', 'どんな']);
const THIS_ONE = new Set(['この', 'その', 'あの', 'どの']);
const PLACES = new Set(['ここ', 'そこ', 'あそこ', 'どこ']);
/** What follows 方が when 方 is a side being compared (した方がいい), and not a person. */
const BETTER = new Set(['いい', '良い', 'よい', 'まし', '楽', '得', '好き', '便利', '簡単', '安全', '無難', '早い', '速い', '多い', '安い', '近い', '強い']);
/** What 今 is read こん before. Anywhere else before a noun it is いま: 今配信してる. */
const KON = new Set(['シーズン', '大会', '年度', '学期', '国会', '場所', '季', '期', '作', '節', 'クール']);
/** What 何 is read なん before: 何でも, 何だろう, 何の話, 何曜日. */
const NAN = new Set(['でも', 'だ', 'だろ', 'だっ', 'です', 'でしょ', 'でし', 'な', 'なら', 'の', 'て', 'じゃ', 'という', 'ていう', 'っていう', '曜日', '月']);
/** …and before と and って only where they quote: 何と言っても. 何と戦ってるの is なに. */
const QUOTING = new Set(['言う', 'いう', '思う', 'ゆう']);
/** What 中 after it means "all through": 一日中, 世界中. */
const THROUGHOUT = new Set(['日', '年', '晩', '世界', '家', '体', '国', '町', '街', '部屋', '今日', '一年', '一日', '年中']);
/** What has a handle: 傘の柄 is え. */
const HANDLED = new Set(['傘', 'ナイフ', '包丁', '刀', '剣', '箒', 'ほうき', 'スコップ', 'ハンマー', '斧', 'フライパン', '鍋']);
/** Whom -方 is said of as がた: 先生方. */
const GATA = new Set(['先生', '皆さん', '皆様', 'あなた', '貴方', 'お客さん', 'お客様']);
/** What is drawn: 絵を描く is かく, where 夢を描く is えがく. */
const DRAWN = new Set(['絵', 'イラスト', '漫画', 'マンガ', '似顔絵', '落書き', 'アイコン', '立ち絵', 'ファンアート']);
/** What opens by itself (開く as あく): 店開いてる. A flower, a gap and a distance ひらく. */
const OPENED = new Set(['店', '穴', 'ドア', '窓', '扉', '戸', '席', '鍵', '蓋', '口', '目']);
/** What is suffered (被る as こうむる); anything else is put on, or overlaps, and is かぶる. */
const SUFFERED = new Set(['損害', '被害', '迷惑', '影響', '恩恵', '損失', '不利益', '打撃', '痛手', '罪']);
/** What -声 names a kind of voice after, read ごえ: アニメ声, 萌え声. Those the dictionary has as words (地声, 裏声, 鼻声) need no rule. */
const KINDS_OF_VOICE = new Set(['アニメ', '萌え', 'ロリ', 'ショタ', '囁き', 'ささやき', '作り', '男', '女', '猫なで', 'かすれ', 'ダミ', 'だみ', '甘え', 'オネエ', 'イケメン', '怒鳴り', 'うめき']);
/** What gold does and money does not, and a Friday: 金に塗る, 金は空いてる. */
const NOT_MONEY = new Set(['塗る', '染める', '光る', '輝く', '空く', '暇']);

const surface = (t: JapaneseToken | undefined): string => t?.surface_form ?? '';

/** こういう and its kin before the word at `i` — ああいう among them, which the dictionary has in two words. */
const kindBefore = (tokens: readonly JapaneseToken[], i: number): boolean => THIS_KIND.has(surface(tokens[i - 1])) || (surface(tokens[i - 1]) === 'いう' && surface(tokens[i - 2]) === 'ああ');

/** A word's reading again, from its neighbours; undefined where no rule knows better than the dictionary. */
function reread(tokens: readonly JapaneseToken[], i: number): string | undefined {
  const t = tokens[i];
  const before = tokens[i - 1];
  const after = tokens[i + 1];
  switch (t.surface_form) {
    case '行っ':
      // 行う and 行く are written alike here; 行う takes an object, and in talk it is nearly always 行く.
      return t.reading === 'オコナッ' && surface(before) !== 'を' ? 'イッ' : undefined;
    case '今':
      return t.reading === 'コン' && !KON.has(surface(after)) ? 'イマ' : undefined;
    case '腹の中':
      return t.reading === 'ハラノウチ' ? (surface(before) === 'お' ? 'ナカノナカ' : 'ハラノナカ') : undefined;
    case '辺':
      if (t.reading !== 'アタリ') return undefined;
      return THIS_ONE.has(surface(before)) || (surface(before) === 'の' && PLACES.has(surface(tokens[i - 2]))) ? 'ヘン' : undefined;
    case '柄':
      // A handle (え) is seldom talked of, and then as the handle of something; what a thing looks like, or a person is like, often.
      return t.reading === 'エ' && !(surface(before) === 'の' && HANDLED.has(surface(tokens[i - 2]))) ? 'ガラ' : undefined;
    case '薬':
      if (t.reading !== 'ヤク' || t.pos_detail_1 !== '接尾') return undefined;
      if (surface(before) === '風邪') return 'グスリ';
      // Taken for the ending of a compound (-やく) after a word of time: 明日薬を飲む.
      return before?.pos_detail_1 === '副詞可能' ? 'クスリ' : undefined;
    case '水':
      // …but after the noun it ends a compound with, it is that ending: 化粧水, 炭酸水.
      return t.reading === 'スイ' && after?.pos === '助詞' && !isContentNoun(before) ? 'ミズ' : undefined;
    case '種':
      return t.reading === 'タネ' && (before?.pos === '接頭詞' || isNumeral(before)) ? 'シュ' : undefined;
    case '金':
      // Money, where it is spent, owed or lacking: 金がない, 金払う, 金ない. Gold keeps its の, and stands beside
      // silver (金と銀); so does a Friday beside a Saturday.
      if (t.reading !== 'キン' && t.reading !== 'キム') return undefined;
      if (before?.pos === '名詞' || before?.pos === '接頭詞') return undefined;
      if (after?.pos === '助詞' && (surface(after) === 'の' || after.pos_detail_1.includes('並立助詞'))) return undefined;
      if (['に', 'は'].includes(surface(after)) && NOT_MONEY.has(tokens[i + 2]?.basic_form ?? '')) return undefined;
      return after?.pos === '助詞' || after?.pos === '動詞' || (after?.pos === '形容詞' && after.basic_form === 'ない') ? 'カネ' : undefined;
    case '何':
      if (t.reading !== 'ナニ') return undefined;
      if (surface(after) === 'と' || surface(after) === 'って') {
        const next = tokens[i + 2];
        // …and where と exclaims: 何と素晴らしい.
        const exclaims = surface(after) === 'と' && (next?.pos === '形容詞' || next?.pos_detail_1 === '形容動詞語幹');
        return QUOTING.has(next?.basic_form ?? '') || exclaims ? 'ナン' : undefined;
      }
      return NAN.has(surface(after)) ? 'ナン' : undefined;
    case '何と':
      // One word to the dictionary, for the exclamation; before a verb that does not quote it is 何 and と: 何と比べて.
      return t.reading === 'ナント' && after?.pos === '動詞' && !QUOTING.has(after.basic_form ?? '') ? 'ナニト' : undefined;
    case '何分':
      return t.reading === 'ナニブン' ? 'ナンプン' : undefined;
    case '十分':
      // The word for "enough", where minutes are meant: 十分後, 十分くらい.
      return t.reading === 'ジュウブン' && ['後', '前', '間', 'くらい', 'ぐらい', 'ほど', '以内', 'しか', 'おき'].includes(surface(after)) ? 'ジュップン' : undefined;
    case '後':
      // After this (この後), and what is left (後は任せた): あと. のち is written language; ご follows a number or a noun.
      if (t.reading === 'ノチ') return 'アト';
      return t.reading === 'ゴ' && before?.pos !== '名詞' ? 'アト' : undefined;
    case '月':
      // The month after its number: 8月, 何月. The moon, and a month counted (ひと月), keep つき.
      return t.reading === 'ツキ' && (isNumeral(before) || surface(before) === '何') ? 'ガツ' : undefined;
    case '中っ':
      // 中って after の is なか and って; hitting a target (中る) is the rare one.
      return t.reading === 'アタッ' && surface(before) === 'の' ? 'ナカッ' : undefined;
    case '風': {
      // A way of doing (こういう風に, という風に, 変な風に), where the wind is not what blows: どんな風が吹いてる.
      if (t.reading !== 'カゼ') return undefined;
      if (surface(before) === 'な' && before?.pos === '助動詞') return surface(after) === 'に' ? 'フウ' : undefined;
      if (!kindBefore(tokens, i) && !['という', 'って', 'っていう'].includes(surface(before))) return undefined;
      return after === undefined || after.pos === '記号' || ['に', 'な', 'だ', 'です', 'で', 'じゃ', 'って'].includes(surface(after)) ? 'フウ' : undefined;
    }
    case '観':
      // 観た and 観たり with the particle left out before them are taken for the ending -かん. Before the copula it is that ending: 世界観です.
      return t.reading === 'カン' && ((after?.pos === '助動詞' && !isCopula(after) && surface(after) !== 'な') || ['たり', 'て', 'た'].includes(surface(after))) ? 'ミ' : undefined;
    // A noun after another is often taken for the ending of a compound, and given the reading it has in one:
    // みんな足出す as そく, これ上が as じょう. Standing by itself it has its own.
    case '声':
      // 両声類, as it is said of those who speak in both voices.
      if (surface(before) === '両' && surface(after) === '類') return 'セイ';
      if (t.reading === 'コエ' && surface(before) === '生' && before?.pos === '接頭詞') return 'ゴエ';
      if (t.reading !== 'ゴエ') return undefined;
      if (surface(after) === '真似') return 'コエ';
      // …but a compound it is after a verb's stem (囁き声) — not after a verb that describes it: という声, 笑う声.
      if (before?.pos === '動詞') return before.basic_form !== undefined && before.basic_form !== before.surface_form ? undefined : 'コエ';
      // After the words that name a kind of voice it is a compound too: アニメ声. After any other it is the voice
      // itself, with the particle left out: ムーイ声切った.
      return KINDS_OF_VOICE.has(surface(before)) ? undefined : 'コエ';
    case '足':
      return t.reading === 'ソク' && !isNumeral(before) ? 'アシ' : undefined;
    case '羽':
      return t.reading === 'ワ' && !isNumeral(before) ? 'ハネ' : undefined;
    case '上':
      // 立場上 keeps じょう: there it ends the noun before it.
      return t.reading === 'ジョウ' && t.pos_detail_1 === '接尾' && (before?.pos !== '名詞' || before.pos_detail_1 === '代名詞') ? 'ウエ' : undefined;
    case '下':
      return t.reading === 'カ' && t.pos_detail_1 === '接尾' && (before?.pos !== '名詞' || before.pos_detail_1 === '代名詞' || ['右', '左', '真', '斜め'].includes(surface(before))) ? 'シタ' : undefined;
    case '入り':
      return t.reading === 'イリ' && after?.pos === '動詞' ? 'ハイリ' : undefined;
    case '入ろう':
      // The dictionary knows these characters only as a noun, 入牢.
      return t.reading === 'ニュウロウ' ? 'ハイロウ' : undefined;
    case '入り口':
      return t.reading === 'イリクチ' ? 'イリグチ' : undefined;
    case '明後日':
      return t.reading === 'ミョウゴニチ' ? 'アサッテ' : undefined;
    case '通り':
      // いつも通り, 今まで通り: as always. 言われた通り keeps とおり.
      if (t.reading !== 'トオリ' || t.pos !== '名詞') return undefined;
      return surface(before) === 'いつも' || (surface(before) === 'まで' && ['今', 'いま', 'これ'].includes(surface(tokens[i - 2]))) ? 'ドオリ' : undefined;
    case '一声':
      return t.reading === 'イッセイ' && ['かけ', '掛け', 'かける', '掛ける'].includes(surface(after)) ? 'ヒトコエ' : undefined;
    case '殿':
      return t.reading === 'シンガリ' ? 'トノ' : undefined;
    case '長けれ':
      return t.reading === 'タケレ' ? 'ナガケレ' : undefined;
    case '高音':
      return t.reading === 'タカネ' ? 'コウオン' : undefined;
    case '日本':
    case '日本人':
      // にほん is what is said; にっぽん is for names and for cheering.
      if (['がんばれ', '頑張れ', 'ガンバレ'].includes(surface(before))) return undefined;
      return t.reading?.startsWith('ニッポン') ? `ニホン${t.reading.slice(4)}` : undefined;
    case '来ら':
      return t.reading === 'キタラ' ? 'コラ' : undefined;
    case '日':
      // 日中, which the dictionary has only as Japan and China: にっちゅう either way.
      return t.reading === 'ニチ' && t.pos_detail_1 === '固有名詞' && surface(after) === '中' && after?.pos_detail_1 === '固有名詞' ? 'ニッ' : undefined;
    case '他':
      // ほか in talk: 他の人, 他に. その他 and 他人 are words of the dictionary's own.
      return t.reading === 'タ' && (after === undefined || after.pos === '記号' || (after.pos === '助詞' && after.pos_detail_1 !== '接続助詞') || surface(after) === '何') ? 'ホカ' : undefined;
    case 'この間':
    case 'その間':
    case 'あの間':
      return t.reading?.endsWith('カン') ? `${t.reading.slice(0, -2)}アイダ` : undefined;
    case '空い':
      // お腹空いた: hungry, not vacant.
      return t.reading === 'アイ' && (['腹', 'お腹'].includes(surface(before)) || (surface(before) === 'が' && ['腹', 'お腹'].includes(surface(tokens[i - 2])))) ? 'スイ' : undefined;
    case '開い': {
      // 店開いてる, ドアが開いた: open, of what opens by itself. メニュー開いて is ひらいて.
      if (t.reading !== 'ヒライ' || !['た', 'てる', 'ている', 'てない', 'て'].includes(surface(after))) return undefined;
      const what = surface(before) === 'が' ? tokens[i - 2] : before;
      // て alone asks someone to open a thing: only where the thing is said to be open (が).
      if (surface(after) === 'て' && surface(before) !== 'が') return undefined;
      return OPENED.has(surface(what)) ? 'アイ' : undefined;
    }
    case '中':
      if (t.reading === 'ナカ' && surface(before) === '今日' && after === undefined) return 'ジュウ';
      return t.reading === 'チュウ' && t.pos_detail_1 === '接尾' && THROUGHOUT.has(surface(before)) ? 'ジュウ' : undefined;
    case '方': {
      if (t.reading === 'カタ' && t.pos_detail_1 === '接尾' && GATA.has(surface(before))) return 'ガタ';
      if (t.reading !== 'ホウ') return undefined;
      const compared = surface(after) === 'が' && (tokens[i + 2]?.pos === '形容詞' || BETTER.has(surface(tokens[i + 2])));
      if (kindBefore(tokens, i)) return compared ? undefined : 'カタ';
      // この方は先生です: a person. この方にする: the one chosen.
      if (THIS_ONE.has(surface(before))) return ['は', 'も', 'です', 'でし', 'だ', 'だっ'].includes(surface(after)) ? 'カタ' : undefined;
      // A person spoken of politely, by what they are doing or were kind enough to do: 配信されている方, 来てくださった方.
      // After a plain verb it is a side: 結構食べる方だ, 頑張った方だ.
      const two = tokens[i - 2];
      const someone = (before?.pos === '動詞' && before.pos_detail_1 === '非自立')
        || (surface(before) === 'た' && two?.pos === '動詞' && (two.pos_detail_1 === '接尾' || two.pos_detail_1 === '非自立'));
      if (!someone) return undefined;
      const politely = ['です', 'だ', 'でし', '々', 'たち', 'な'].includes(surface(after));
      const there = after?.pos === '動詞' && ['いる', 'いらっしゃる', 'おる'].includes(after.basic_form ?? '');
      return politely || there ? 'カタ' : undefined;
    }
    default:
      if (t.pos !== '動詞') return undefined;
      // 被る: put on (帽子被った), or the same as another's (アバター被ってる). こうむる takes what is suffered.
      if (t.surface_form.startsWith('被') && t.reading?.startsWith('コウム')) {
        return surface(before) === 'を' && SUFFERED.has(surface(tokens[i - 2])) ? undefined : `カブ${t.reading.slice(3)}`;
      }
      // 描く of a picture is かく.
      if (t.surface_form.startsWith('描') && t.reading?.startsWith('エガ')) {
        return DRAWN.has(surface(before)) || (surface(before) === 'を' && DRAWN.has(surface(tokens[i - 2]))) ? `カ${t.reading.slice(2)}` : undefined;
      }
      return undefined;
  }
}

/** A reading to give: the token it is of, and the reading. */
type Change = readonly [index: number, reading: string];

/** The number that ends with the numeral at `end`, where it is one that is simply read: digits, or kanji up to 99. */
function numberAt(tokens: readonly JapaneseToken[], end: number): { value: number; start: number } | undefined {
  let start = end;
  while (isNumeral(tokens[start - 1])) start -= 1;
  const text = tokens.slice(start, end + 1).map(surface).join('');
  if (DIGITS.test(text)) return { value: Number(text.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))), start };
  const found = /^([二三四五六七八九])?(十)?([一二三四五六七八九])?$/.exec(text);
  if (!found || !text) return undefined;
  if (!found[2]) return found[1] && found[3] ? undefined : { value: KANJI_DIGIT[found[1] ?? found[3]], start };
  return { value: (found[1] ? KANJI_DIGIT[found[1]] : 1) * 10 + (found[3] ? KANJI_DIGIT[found[3]] : 0), start };
}

/**
 * The days that are counted the native way, after a number in kanji or in
 * digits: 二日 ふつか, 十日 とおか, 十四日 じゅうよっか, 二十日 はつか. A
 * number in digits is given its reading too — it has none of its own, and
 * 10 with か after it says nothing.
 */
function days(tokens: readonly JapaneseToken[], i: number): Change[] | undefined {
  const number = tokens[i];
  const counter = tokens[i + 1];
  const tail = counter.surface_form === '日' && counter.reading === 'ニチ' ? 'カ' : counter.surface_form === '日間' && counter.reading === 'ニチカン' ? 'カカン' : null;
  if (!tail) return undefined;
  const count = numberAt(tokens, i);
  // 第三日 is だいさんにち.
  if (!count || surface(tokens[count.start - 1]) === '第') return undefined;
  const { value } = count;
  const inDigits = DIGITS.test(number.surface_form);
  if (value >= 2 && value <= 10) return count.start === i ? [[i, DAYS[value]], [i + 1, tail]] : undefined;
  if (value === 14 || value === 24) return [[i, inDigits ? `${value === 14 ? 'ジュウ' : 'ニジュウ'}ヨッ` : 'ヨッ'], [i + 1, tail]];
  if (value === 20) return inDigits ? [[i, 'ハツ'], [i + 1, tail]] : [[i - 1, 'ハ'], [i, 'ツ'], [i + 1, tail]];
  return undefined;
}

/** 二十歳 is はたち, in kanji or in digits. */
function twenty(tokens: readonly JapaneseToken[], i: number): Change[] | undefined {
  const counter = tokens[i + 1];
  if (counter.surface_form !== '歳' || counter.reading !== 'サイ') return undefined;
  const count = numberAt(tokens, i);
  if (!count || count.value !== 20) return undefined;
  if (DIGITS.test(tokens[i].surface_form)) return count.start === i ? [[i, 'ハタ'], [i + 1, 'チ']] : undefined;
  return [[i - 1, 'ハ'], [i, 'タ'], [i + 1, 'チ']];
}

/**
 * A counter after a number written in digits, as speech recognition often
 * writes it. The digits have no reading of their own, so the counter is read
 * from what the number ends in: 3本 ぼん, 6本 ぽん, 10分 ぷん. 1人 and 2人
 * are ひとり and ふたり, and there the digit is given its reading too.
 */
function afterDigits(tokens: readonly JapaneseToken[], i: number): Change[] | undefined {
  const counter = tokens[i + 1];
  const count = numberAt(tokens, i);
  if (!count || !counter.reading) return undefined;
  const { value } = count;
  if (counter.surface_form === '人' && counter.reading === 'ニン' && count.start === i && (value === 1 || value === 2)) return [[i, value === 1 ? 'ヒト' : 'フタ'], [i + 1, 'リ']];
  // A unit in katakana keeps its sound: 1ヘルツ.
  if (KATAKANA_START.test(counter.surface_form)) return undefined;
  const last = value % 10;
  if (last === 3 && AFTER_THREE[counter.surface_form]) return [[i + 1, AFTER_THREE[counter.surface_form]]];
  if (last === 4 && counter.surface_form === '分' && counter.reading === 'フン') return [[i + 1, 'プン']];
  // いっ, ろっ, はっ, じゅっ and ひゃっ before the は-row: 1本 いっぽん, 20本 にじゅっぽん, 100本 ひゃっぽん.
  const doubles = last === 1 || last === 6 || last === 8 || (value > 0 && last === 0 && value % 1000 !== 0);
  const first = counter.reading[0];
  return doubles && P_OF[first] ? [[i + 1, P_OF[first] + counter.reading.slice(1)]] : undefined;
}

/**
 * A numeral and the counter after it, read together: 一人 and 二人, the
 * days of the month, the doubled sound of 一回, 六本, 八百 and 十分, and the
 * voicing after 三 and 何. Returns the readings to give, or undefined where
 * they are right as they are.
 */
function counted(tokens: readonly JapaneseToken[], i: number): Change[] | undefined {
  const number = tokens[i];
  const counter = tokens[i + 1];
  if (!isNumeral(number) || counter === undefined) return undefined;
  const digit = number.reading ? WIDE_DIGIT[number.surface_form] ?? number.surface_form : number.surface_form;
  // 一手間, 一仕事: nouns to the dictionary, counted the native way all the same.
  if (NATIVE_NOUNS.has(counter.surface_form) && counter.pos === '名詞' && number.reading && !isNumeral(tokens[i - 1])) {
    if (digit === '一') return [[i, 'ヒト']];
    if (digit === '二' && NATIVE_TWO.has(counter.surface_form)) return [[i, 'フタ']];
  }
  if (!isCounter(counter) || !counter.reading) return undefined;
  const day = days(tokens, i) ?? twenty(tokens, i);
  if (day) return day;
  if (DIGITS.test(digit)) return afterDigits(tokens, i);
  if (!number.reading) return undefined;
  // 一人, 二人 — but 十一人 is じゅういちにん.
  if (counter.surface_form === '人' && counter.reading === 'ニン' && !isNumeral(tokens[i - 1])) {
    if (digit === '一') return [[i, 'ヒト'], [i + 1, 'リ']];
    if (digit === '二') return [[i, 'フタ'], [i + 1, 'リ']];
  }
  // 腹八分目: the counter is ぶんめ, and the numeral before it as it is.
  if (counter.surface_form === '分目') return [[i + 1, 'ブンメ']];
  // 三年一組 is a class at school, いちくみ.
  if (counter.surface_form === '組' && surface(tokens[i - 1]) === '年') return undefined;
  if (NATIVE.has(counter.surface_form) && !isNumeral(tokens[i - 1])) {
    if (digit === '一') return [[i, 'ヒト']];
    if (digit === '二' && NATIVE_TWO.has(counter.surface_form)) return [[i, 'フタ']];
    return undefined;
  }
  // 十分 where it ends what is said is "enough" — それで十分 — unless minutes are being counted: あと十分, 三時十分.
  if (digit === '十' && counter.surface_form === '分' && !isNumeral(tokens[i - 1]) && !['あと', '約', '残り', '大体', '時', '時間'].includes(surface(tokens[i - 1])) && closes(tokens[i + 2])) {
    return [[i, 'ジュウ'], [i + 1, 'ブン']];
  }
  const voiced = digit === '三' || digit === '何' ? AFTER_THREE[counter.surface_form] : undefined;
  if (voiced) return [[i + 1, voiced]];
  if (digit === '四' && counter.surface_form === '分' && counter.reading === 'フン') return [[i + 1, 'プン']];
  const doubling = DOUBLING[digit];
  // 百 may already be voiced by the numeral before it (三百回): its last sound doubles all the same.
  const doubled = doubling && number.reading === doubling.from ? doubling.to : digit === '百' && /ャク$/.test(number.reading) ? `${number.reading.slice(0, -1)}ッ` : undefined;
  if (!doubling || !doubled) return undefined;
  // 十三 and 一百 are not doubled: only the units a numeral multiplies.
  if (counter.pos_detail_1 === '数' && (digit === '十' || digit === '百' || (digit === '一' && counter.surface_form === '百'))) return undefined;
  const first = counter.reading[0];
  // A unit in katakana keeps its own sound, and は-row ones leave the numeral whole: 一ヘルツ is いちヘルツ. Before
  // ぱ only 一 and 十 double: 一パーセント, 十ページ.
  if (KATAKANA_START.test(counter.surface_form)) {
    if (doubling.rows.includes(first) && !H_ROW.includes(first)) return [[i, doubled]];
    return P_ROW.includes(first) && (digit === '一' || digit === '十') ? [[i, doubled]] : undefined;
  }
  if (!doubling.rows.includes(first)) return undefined;
  return [[i, doubled], [i + 1, P_OF[first] ? P_OF[first] + counter.reading.slice(1) : counter.reading]];
}

/** The tokens with the readings everyday speech gives them. The same array when nothing is changed. */
export function correctReadings(tokens: readonly JapaneseToken[]): readonly JapaneseToken[] {
  // Read from what is already corrected: a counter that is itself a numeral (百 in 三百回) carries its new reading on.
  let now: readonly JapaneseToken[] = tokens;
  const set = (i: number, reading: string) => {
    if (now[i].reading === reading) return;
    const next = now === tokens ? tokens.map((t) => t) : (now as JapaneseToken[]);
    next[i] = { ...next[i], reading };
    now = next;
  };
  for (let i = 0; i < tokens.length; i += 1) {
    const changes = counted(now, i);
    if (changes) {
      for (const [at, reading] of changes) set(at, reading);
      continue;
    }
    const reading = reread(now, i);
    if (reading) set(i, reading);
  }
  return now;
}
