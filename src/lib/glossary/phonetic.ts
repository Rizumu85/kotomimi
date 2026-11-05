/**
 * Fork: a word as it sounds, whatever it is written in. Every script is read into rough Latin letters (pinyin for
 * Han, romaji for kana, a reading of Hangul and Cyrillic, Latin as it is), then into a key of sounds:
 *
 * - `strict`, for two spellings in one script: letters that spell one sound alike (c/k, s/z, ph/f, o/u, e/i/y,
 *   doubled letters) — "Risom" is "Rizum".
 * - `loose`, for two scripts: also what one language cannot tell apart where another does — voiced and unvoiced
 *   (b/p, d/t, g/k), l and r, the hushing sounds (s, z, sh, ch, j, ts), and h. A script that writes a vowel after
 *   every consonant adds one where the other has none (リズム, rizumu, for Rizum; 里祖姆, li zu mu): `soundsAlike`
 *   lets a vowel stand where the other side has none, as long as the consonants are the same.
 *
 * Han against Han and kana against kana are matched more closely, in `sound.ts`.
 */
import { pinyin } from 'pinyin-pro';

export type Script = 'latin' | 'cyrillic' | 'hangul' | 'kana' | 'han';

const SCRIPTS: Array<[Script, RegExp]> = [
  ['latin', /^\p{Script=Latin}+$/u],
  ['cyrillic', /^\p{Script=Cyrillic}+$/u],
  ['hangul', /^\p{Script=Hangul}+$/u],
  ['kana', /^[\p{Script=Hiragana}\p{Script=Katakana}ー]+$/u],
  ['han', /^\p{Script=Han}+$/u],
];

/** The one script a word is written in, or null for a word of several, or of none of these. */
export function scriptOf(word: string): Script | null {
  return SCRIPTS.find(([, re]) => re.test(word))?.[0] ?? null;
}

// ---- Reading each script into Latin letters ----

function latinLetters(word: string): string {
  return word.toLowerCase().replace(/ß/g, 'ss').replace(/æ/g, 'ae').replace(/[øœ]/g, 'o').normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/x/g, 'ks').replace(/qu/g, 'kw').replace(/q/g, 'k').replace(/ck/g, 'k').replace(/c(?=[eiy])/g, 's').replace(/c(?!h)/g, 'k');
}

const CYRILLIC: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', ґ: 'g', д: 'd', е: 'e', є: 'ye', ё: 'yo', ж: 'zh', з: 'z', и: 'i', і: 'i', ї: 'yi', й: 'y', к: 'k',
  л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};
const cyrillicLetters = (word: string) => [...word.toLowerCase()].map((c) => CYRILLIC[c] ?? '').join('');

// Hangul, as it is heard rather than the official spelling: ㅓ as o, ㅡ as a vowel hardly said (`ə`).
const HANGUL_FIRST = ['g', 'kk', 'n', 'd', 'tt', 'r', 'm', 'b', 'pp', 's', 'ss', '', 'j', 'jj', 'ch', 'k', 't', 'p', 'h'];
const HANGUL_VOWEL = ['a', 'e', 'ya', 'ye', 'o', 'e', 'yo', 'ye', 'o', 'wa', 'we', 'we', 'yo', 'u', 'wo', 'we', 'wi', 'yu', 'ə', 'ui', 'i'];
const HANGUL_LAST = ['', 'k', 'k', 'k', 'n', 'n', 'n', 't', 'l', 'k', 'm', 'l', 'l', 'l', 'p', 'l', 'm', 'p', 'p', 't', 't', 'ng', 't', 't', 'k', 't', 'p', 't'];
function hangulLetters(word: string): string {
  return [...word].map((c) => {
    const code = c.codePointAt(0)! - 0xac00;
    if (code < 0 || code > 11171) return '';
    return HANGUL_FIRST[Math.floor(code / 588)] + HANGUL_VOWEL[Math.floor((code % 588) / 28)] + HANGUL_LAST[code % 28];
  }).join('');
}

const KANA: Record<string, string> = {
  ア: 'a', イ: 'i', ウ: 'u', エ: 'e', オ: 'o', カ: 'ka', キ: 'ki', ク: 'ku', ケ: 'ke', コ: 'ko', ガ: 'ga', ギ: 'gi', グ: 'gu', ゲ: 'ge', ゴ: 'go',
  サ: 'sa', シ: 'shi', ス: 'su', セ: 'se', ソ: 'so', ザ: 'za', ジ: 'ji', ズ: 'zu', ゼ: 'ze', ゾ: 'zo', タ: 'ta', チ: 'chi', ツ: 'tsu', テ: 'te', ト: 'to',
  ダ: 'da', ヂ: 'ji', ヅ: 'zu', デ: 'de', ド: 'do', ナ: 'na', ニ: 'ni', ヌ: 'nu', ネ: 'ne', ノ: 'no', ハ: 'ha', ヒ: 'hi', フ: 'fu', ヘ: 'he', ホ: 'ho',
  バ: 'ba', ビ: 'bi', ブ: 'bu', ベ: 'be', ボ: 'bo', パ: 'pa', ピ: 'pi', プ: 'pu', ペ: 'pe', ポ: 'po', マ: 'ma', ミ: 'mi', ム: 'mu', メ: 'me', モ: 'mo',
  ヤ: 'ya', ユ: 'yu', ヨ: 'yo', ラ: 'ra', リ: 'ri', ル: 'ru', レ: 're', ロ: 'ro', ワ: 'wa', ヰ: 'i', ヱ: 'e', ヲ: 'o', ン: 'n', ヴ: 'vu',
};
const SMALL_Y: Record<string, string> = { ャ: 'a', ュ: 'u', ョ: 'o' };
const SMALL_VOWEL: Record<string, string> = { ァ: 'a', ィ: 'i', ゥ: 'u', ェ: 'e', ォ: 'o' };
function kanaLetters(word: string): string {
  let out = '';
  for (const c of word) {
    const code = c.codePointAt(0)!;
    const k = code >= 0x3041 && code <= 0x3096 ? String.fromCodePoint(code + 0x60) : c;
    if (k === 'ッ') continue;
    if (k === 'ー') { out += /[aeiou]$/.exec(out)?.[0] ?? ''; continue; }
    if (SMALL_Y[k]) {
      // キャ kya, シャ sha: the i before is the small kana's glide.
      out = /(sh|ch|j)i$/.test(out) ? out.slice(0, -1) + SMALL_Y[k] : out.replace(/i$/, 'y') + SMALL_Y[k];
      continue;
    }
    if (SMALL_VOWEL[k]) { out = out.replace(/[aeiou]$/, '') + SMALL_VOWEL[k]; continue; }
    out += KANA[k] ?? '';
  }
  return out;
}

/** One pinyin syllable (`pinyin-pro`'s, ü as v) as heard: x sh, q ch, c ts; the buzz after z, c, s, zh, ch, sh, r a vowel hardly said. */
export function pinyinLetters(syllable: string): string {
  if (syllable === 'er') return 'l';
  let s = syllable.replace(/^x/, 'sh').replace(/^q/, 'ch').replace(/^c(?!h)/, 'ts');
  s = s.replace(/^(zh|ch|sh|ts|z|s|r)i$/, '$1ə');
  // 的 de, 了 le: a bare e is said nearer u than i.
  s = s.replace(/^([bpmfdtnlgkhrsz]|zh|ch|sh|ts)e$/, '$1u');
  return s.replace(/v/g, 'yu');
}

/** The Latin letters a word is read as, by its script. Han is read a character at a time, as `pinyin-pro` gives it. */
export function lettersOf(word: string, script: Script): string {
  switch (script) {
    case 'latin': return latinLetters(word);
    case 'cyrillic': return cyrillicLetters(word);
    case 'hangul': return hangulLetters(word);
    case 'kana': return kanaLetters(word);
    case 'han': return pinyin(word, { toneType: 'none', type: 'array', v: true }).map((p) => pinyinLetters(p.toLowerCase())).join('');
  }
}

// ---- Keys ----

const VOWELS = new Set(['a', 'i', 'u', 'ə']);

/** The sounds in some Latin letters, one character each: consonants by kind, vowels as a, i, u, or ə for one hardly said. */
export function soundKey(letters: string, loose: boolean): string {
  let s = letters.toLowerCase().replace(/[^a-zə]/g, '');
  s = s.replace(/ph/g, 'f').replace(/gh/g, 'g').replace(/ng/g, 'n');
  if (loose) {
    s = s.replace(/th/g, 's').replace(/(sh|ch|zh|ts|dz|tz|j|z|c|x)/g, 's').replace(/[pfv]/g, 'b').replace(/t/g, 'd').replace(/[kq]/g, 'g')
      .replace(/r/g, 'l').replace(/h/g, '');
  } else {
    s = s.replace(/th/g, 't').replace(/sh/g, 'S').replace(/ch/g, 'C').replace(/zh/g, 'J').replace(/z/g, 's').replace(/q/g, 'k').replace(/c/g, 'k')
      // An h that is not followed by a vowel is not said (Sarah, Thomas).
      .replace(/h(?![aeiouy])/g, '');
  }
  s = s.replace(/[eiy]/g, 'i').replace(/[ouw]/g, 'u');
  return s.replace(/(.)\1+/g, '$1');
}

export interface Sound {
  key: string;
  /** The consonants, in order. */
  consonants: string;
  /** The vowels before, between and after them: one more than the consonants. */
  vowels: string[];
}

export function sound(letters: string, loose: boolean): Sound {
  const key = soundKey(letters, loose);
  const vowels: string[] = [''];
  let consonants = '';
  for (const c of key) {
    if (VOWELS.has(c)) vowels[vowels.length - 1] += c;
    else { consonants += c; vowels.push(''); }
  }
  return { key, consonants, vowels };
}

/** A vowel one side adds where the other has none, or one hardly said. */
const added = (a: string, b: string) => (a === '' && (b === 'i' || b === 'u' || b === 'ə')) || (a === 'ə' && (b === '' || b === 'i' || b === 'u'));

/** Whether two words of two scripts sound alike: the same consonants, the same vowels but for ones a script adds. */
export function soundsAlike(a: Sound, b: Sound): boolean {
  if (a.consonants !== b.consonants || a.vowels[0] !== b.vowels[0]) return false;
  for (let i = 1; i < a.vowels.length; i++) {
    const x = a.vowels[i];
    const y = b.vowels[i];
    if (x !== y && !added(x, y) && !added(y, x)) return false;
  }
  return true;
}
