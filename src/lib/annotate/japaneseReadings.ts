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
 * from their numeral; 一言, 一口 and their like are words of its own.
 */
const NATIVE = new Set(['通り', '回り', '切れ', '粒', '握り', '箱', '皿', '組', '桁', '袋', '束', '部屋', '駅', '晩', '休み', '息', '声', '味', '癖', '手間', '苦労', '仕事', '安心', '工夫', '筋', '言', '口', '夏', '冬', '昔', '皮', '勝負', '段落', '区切り', '眠り', '泳ぎ', '踏ん張り', '頑張り', '押し', '巻き']);
/** And of those, the ones 二 is ふた before: 二通り, 二部屋. */
const NATIVE_TWO = new Set(['通り', '回り', '切れ', '粒', '握り', '箱', '皿', '組', '桁', '袋', '束', '部屋', '駅', '晩', '言', '口', '夏', '冬', '皮']);
/** The larger numerals a smaller one doubles into: 六百, 八千 — not 十三. */
const UNITS = new Set(['百', '千', '兆']);

const isNumeral = (t: JapaneseToken | undefined): boolean => t !== undefined && t.pos === '名詞' && t.pos_detail_1 === '数';
const isCounter = (t: JapaneseToken | undefined): boolean => t !== undefined && t.pos === '名詞' && (t.pos_detail_1 === '接尾' || (t.pos_detail_1 === '数' && UNITS.has(t.surface_form)) || t.surface_form === '種類');

/** この, こういう and their kin: what stands before 方 when it is a person, and before 辺 when it is へん. */
const THIS_KIND = new Set(['こういう', 'そういう', 'ああいう', 'どういう', 'いろんな', '色んな', 'こんな', 'そんな', 'あんな', 'どんな']);
const THIS_ONE = new Set(['この', 'その', 'あの', 'どの']);
const PLACES = new Set(['ここ', 'そこ', 'あそこ', 'どこ']);
/** What follows 方が when 方 is a side being compared (した方がいい), and not a person. */
const BETTER = new Set(['いい', '良い', 'よい', 'まし', '楽', '得', '好き', '便利', '簡単', '安全', '無難', '早い', '速い', '多い', '安い', '近い', '強い']);
/** What 今 is read こん before. Anywhere else before a noun it is いま: 今配信してる. */
const KON = new Set(['シーズン', '大会', '年度', '学期', '国会', '場所', '季', '期', '作', '節', 'クール']);
/** What 何 is read なん before: 何でも, 何だろう, 何の話. */
const NAN = new Set(['でも', 'だ', 'だろ', 'だっ', 'です', 'でしょ', 'でし', 'な', 'の', 'って', 'て', 'じゃ', 'と', 'という', 'ていう', 'っていう']);
/** What 中 after it means "all through": 一日中, 世界中. */
const THROUGHOUT = new Set(['日', '年', '晩', '世界', '家', '体', '国', '町', '街', '部屋', '今日', '一年', '一日', '年中']);

const surface = (t: JapaneseToken | undefined): string => t?.surface_form ?? '';

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
      // A handle (え) is seldom talked of; what a thing looks like, or a person is like, often.
      return t.reading === 'エ' ? 'ガラ' : undefined;
    case '薬':
      // Taken for the ending of a compound (-やく) after a word of time: 明日薬を飲む.
      return t.reading === 'ヤク' && t.pos_detail_1 === '接尾' && before?.pos_detail_1 === '副詞可能' ? 'クスリ' : undefined;
    case '水':
      return t.reading === 'スイ' && after?.pos === '助詞' ? 'ミズ' : undefined;
    case '種':
      return t.reading === 'タネ' && (before?.pos === '接頭詞' || isNumeral(before)) ? 'シュ' : undefined;
    case '金':
      // Money, where it is spent, owed or lacking: 金がない, 金払う. Gold keeps its の: 金の延べ棒.
      if (t.reading !== 'キン' && t.reading !== 'キム') return undefined;
      if (before?.pos === '名詞' || before?.pos === '接頭詞') return undefined;
      return (after?.pos === '助詞' && surface(after) !== 'の') || after?.pos === '動詞' ? 'カネ' : undefined;
    case '何':
      return t.reading === 'ナニ' && NAN.has(surface(after)) ? 'ナン' : undefined;
    case '何分':
      return t.reading === 'ナニブン' ? 'ナンプン' : undefined;
    case '後':
      // After this (この後), and what is left (後は任せた): あと. のち is written language; ご follows a number or a noun.
      if (t.reading === 'ノチ') return 'アト';
      return t.reading === 'ゴ' && before?.pos !== '名詞' ? 'アト' : undefined;
    case '月':
      // The month after its number: 8月. The moon, and a month counted (ひと月), keep つき.
      return t.reading === 'ツキ' && isNumeral(before) ? 'ガツ' : undefined;
    case '中っ':
      // 中って after の is なか and って; hitting a target (中る) is the rare one.
      return t.reading === 'アタッ' && surface(before) === 'の' ? 'ナカッ' : undefined;
    case '風':
      return t.reading === 'カゼ' && THIS_KIND.has(surface(before)) ? 'フウ' : undefined;
    case '観':
      // 観た and 観たり with the particle left out before them are taken for the ending -かん.
      return t.reading === 'カン' && (after?.pos === '助動詞' || ['たり', 'て', 'た'].includes(surface(after))) ? 'ミ' : undefined;
    // A noun after another is often taken for the ending of a compound, and given the reading it has in one:
    // みんな足出す as そく, これ上が as じょう. Standing by itself it has its own.
    case '声':
      return t.reading === 'ゴエ' ? 'コエ' : undefined;
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
    case '殿':
      return t.reading === 'シンガリ' ? 'トノ' : undefined;
    case '長けれ':
      return t.reading === 'タケレ' ? 'ナガケレ' : undefined;
    case '高音':
      return t.reading === 'タカネ' ? 'コウオン' : undefined;
    case '日本':
    case '日本人':
      // にほん is what is said; にっぽん is for names and cheering.
      return t.reading?.startsWith('ニッポン') ? `ニホン${t.reading.slice(4)}` : undefined;
    case '来ら':
      return t.reading === 'キタラ' ? 'コラ' : undefined;
    case '中':
      return t.reading === 'チュウ' && t.pos_detail_1 === '接尾' && THROUGHOUT.has(surface(before)) ? 'ジュウ' : undefined;
    case '方': {
      if (t.reading !== 'ホウ') return undefined;
      const compared = surface(after) === 'が' && (tokens[i + 2]?.pos === '形容詞' || BETTER.has(surface(tokens[i + 2])));
      if (THIS_KIND.has(surface(before))) return compared ? undefined : 'カタ';
      if (THIS_ONE.has(surface(before))) return surface(after) === 'が' ? undefined : 'カタ';
      // A person spoken of politely: 配信されている方です.
      const politely = ['です', 'だ', 'でし', '々', 'たち'].includes(surface(after));
      if (politely && (before?.pos === '助動詞' || before?.pos === '動詞')) return 'カタ';
      // 来てくれてる方なんだ: someone who does a thing, said of them now.
      return surface(after) === 'な' && before?.pos === '動詞' ? 'カタ' : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * A numeral and the counter after it, read together: 一人 and 二人, the
 * doubled sound of 一回, 六本, 八百 and 十分, and the voicing after 三 and
 * 何. Returns the two readings, or undefined where they are right as they
 * are.
 */
function counted(tokens: readonly JapaneseToken[], i: number): [string, string] | undefined {
  const number = tokens[i];
  const counter = tokens[i + 1];
  if (!isNumeral(number) || !isCounter(counter) || !number.reading || !counter.reading) return undefined;
  const digit = number.surface_form;
  // 一人, 二人 — but 十一人 is じゅういちにん.
  if (counter.surface_form === '人' && counter.reading === 'ニン' && !isNumeral(tokens[i - 1])) {
    if (digit === '一') return ['ヒト', 'リ'];
    if (digit === '二') return ['フタ', 'リ'];
  }
  if (NATIVE.has(counter.surface_form) && !isNumeral(tokens[i - 1])) {
    if (digit === '一') return ['ヒト', counter.reading];
    if (digit === '二' && NATIVE_TWO.has(counter.surface_form)) return ['フタ', counter.reading];
    return undefined;
  }
  const voiced = digit === '三' || digit === '何' ? AFTER_THREE[counter.surface_form] : undefined;
  if (voiced) return [number.reading, voiced];
  if (digit === '四' && counter.surface_form === '分' && counter.reading === 'フン') return [number.reading, 'プン'];
  const doubling = DOUBLING[digit];
  // 百 may already be voiced by the numeral before it (三百回): its last sound doubles all the same.
  const doubled = doubling && number.reading === doubling.from ? doubling.to : digit === '百' && /ャク$/.test(number.reading) ? `${number.reading.slice(0, -1)}ッ` : undefined;
  if (!doubling || !doubled) return undefined;
  // 十三 and 一百 are not doubled: only the units a numeral multiplies.
  if (counter.pos_detail_1 === '数' && (digit === '十' || digit === '百' || (digit === '一' && counter.surface_form === '百'))) return undefined;
  const first = counter.reading[0];
  if (!doubling.rows.includes(first)) return undefined;
  return [doubled, P_OF[first] ? P_OF[first] + counter.reading.slice(1) : counter.reading];
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
    const pair = counted(now, i);
    if (pair) {
      set(i, pair[0]);
      set(i + 1, pair[1]);
      continue;
    }
    const reading = reread(now, i);
    if (reading) set(i, reading);
  }
  return now;
}
