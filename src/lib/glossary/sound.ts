/**
 * Fork: the words of the user's dictionary found by how they sound, not only by how they are spelled. Recognition
 * writes a name another way nearly every time — 糖豆 as 唐豆, 悠米露 as 优米路, リズム as リスム — and a row of
 * mishearings caught only the spellings listed, so the user added one after another (2026-11-05). What is matched:
 *
 * - Chinese, by pinyin (`pinyin-pro`, already in the app for the subtitles' readings). A word of two syllables must
 *   sound the same tone for tone: 唐豆 is 糖豆, 汤豆 is not, and an everyday word that only shares the syllables keeps
 *   its own. A longer one may differ in tones, and in one syllable by a sound near it (z/zh, n/l, an/ang …).
 * - Japanese written in kana, with voicing, long vowels, small kana and the double consonant set aside.
 *
 * The words' own spellings and their listed mishearings are matched, so a mishearing listed once stands for every
 * spelling that sounds like it. Latin letters are left to the exact matching: a name in them is spelled the same.
 */
import { pinyin } from 'pinyin-pro';
import type { GlossaryEntry } from './types';

const HAN = /^\p{Script=Han}+$/u;
const KANA = /^[\p{Script=Hiragana}\p{Script=Katakana}ー]+$/u;
const HAN_RUN = /\p{Script=Han}+/gu;
const KANA_RUN = /[\p{Script=Hiragana}\p{Script=Katakana}ー]+/gu;

const INITIALS = ['zh', 'ch', 'sh', 'b', 'p', 'm', 'f', 'd', 't', 'n', 'l', 'g', 'k', 'h', 'j', 'q', 'x', 'r', 'z', 'c', 's', 'y', 'w'];
/** Initials and finals heard one for the other: by many speakers, and by recognition. */
const NEAR_INITIALS = [['zh', 'z'], ['ch', 'c'], ['sh', 's'], ['n', 'l'], ['f', 'h'], ['r', 'l']];
const NEAR_FINALS = [['an', 'ang'], ['en', 'eng'], ['in', 'ing'], ['ian', 'iang'], ['uan', 'uang']];

interface Syllable { plain: string; tone: string }

/** The syllables of a run of Han characters, each read as its words give it. */
function syllables(han: string): Syllable[] {
  return pinyin(han, { toneType: 'num', type: 'array', v: true }).map((one) => {
    const m = /^([a-zü]+?)([0-5])?$/.exec(one.toLowerCase());
    return m ? { plain: m[1], tone: m[2] ?? '0' } : { plain: one.toLowerCase(), tone: '0' };
  });
}

const split = (plain: string): [string, string] => {
  const initial = INITIALS.find((i) => plain.startsWith(i) && plain.length > i.length) ?? '';
  return [initial, plain.slice(initial.length)];
};
const nearPair = (pairs: string[][], a: string, b: string) => pairs.some(([x, y]) => (a === x && b === y) || (a === y && b === x));

/** Whether two syllables are near: the one sound heard for the other, the rest the same. */
function near(a: string, b: string): boolean {
  const [ai, af] = split(a);
  const [bi, bf] = split(b);
  return (af === bf && nearPair(NEAR_INITIALS, ai, bi)) || (ai === bi && nearPair(NEAR_FINALS, af, bf));
}

/** A neutral tone is said lightly and written either way: it matches any. */
const sameTone = (a: string, b: string) => a === b || a === '0' || b === '0' || a === '5' || b === '5';

/** Whether a stretch of syllables sounds like a word's. */
function soundsLike(heard: Syllable[], word: Syllable[]): boolean {
  if (heard.length !== word.length) return false;
  if (word.length === 2) return heard.every((s, i) => s.plain === word[i].plain && sameTone(s.tone, word[i].tone));
  let nearOnes = 0;
  for (let i = 0; i < word.length; i++) {
    if (heard[i].plain === word[i].plain) continue;
    if (!near(heard[i].plain, word[i].plain) || ++nearOnes > 1) return false;
  }
  return true;
}

/** Kana as it sounds, roughly: one script, voicing and the long vowel, small kana and the double consonant set aside. */
function kanaKey(kana: string): string {
  const katakana = [...kana].map((c) => {
    const code = c.codePointAt(0)!;
    return code >= 0x3041 && code <= 0x3096 ? String.fromCodePoint(code + 0x60) : c;
  }).join('');
  const small: Record<string, string> = { ァ: 'ア', ィ: 'イ', ゥ: 'ウ', ェ: 'エ', ォ: 'オ', ャ: 'ヤ', ュ: 'ユ', ョ: 'ヨ', ヮ: 'ワ', ヵ: 'カ', ヶ: 'ケ' };
  return katakana.normalize('NFD').replace(/[゙゚]/g, '').replace(/[ーッ]/g, '')
    .replace(/[ァィゥェォャュョヮヵヶ]/g, (c) => small[c]).normalize('NFC');
}

interface Found { start: number; end: number; source: string }

/**
 * The text with every stretch that sounds like a word of the dictionary written as the word. What is already one of
 * the words is left as it is, so text that has been through this comes out the same.
 */
export function foldBySound(text: string, entries: readonly GlossaryEntry[]): string {
  // The conversation draws every row again as it grows: a sentence once read is not read again for the same table.
  let seen = cache.get(entries);
  if (!seen) cache.set(entries, (seen = new Map()));
  const had = seen.get(text);
  if (had !== undefined) return had;
  const out = fold(text, entries);
  if (seen.size >= 500) seen.delete(seen.keys().next().value!);
  seen.set(text, out);
  return out;
}

/** What each table made of each text, while that table is the one in use. */
const cache = new WeakMap<readonly GlossaryEntry[], Map<string, string>>();

function fold(text: string, entries: readonly GlossaryEntry[]): string {
  const hanWords: Array<{ source: string; sound: Syllable[] }> = [];
  const kanaWords: Array<{ source: string; key: string; length: number }> = [];
  for (const entry of entries) {
    for (const form of [entry.source, ...entry.aliases]) {
      if (HAN.test(form) && form.length >= 2 && form.length <= 8) hanWords.push({ source: entry.source, sound: syllables(form) });
      else if (KANA.test(form) && kanaKey(form).length >= 2) kanaWords.push({ source: entry.source, key: kanaKey(form), length: [...form].length });
    }
  }
  if (hanWords.length === 0 && kanaWords.length === 0) return text;

  // Where the words already stand: nothing over them is touched.
  const kept: Array<[number, number]> = [];
  for (const entry of entries) {
    if (!entry.source) continue;
    for (let at = text.indexOf(entry.source); at >= 0; at = text.indexOf(entry.source, at + 1)) kept.push([at, at + entry.source.length]);
  }
  const free = (start: number, end: number) => !kept.some(([a, b]) => start < b && a < end);

  const found: Found[] = [];
  if (hanWords.length > 0) {
    for (const run of text.matchAll(HAN_RUN)) {
      const heard = syllables(run[0]);
      // pinyin-pro reads one syllable to a character: the indices line up.
      if (heard.length !== run[0].length) continue;
      for (const word of hanWords) {
        const n = word.sound.length;
        for (let i = 0; i + n <= heard.length; i++) {
          const start = run.index! + i;
          const end = start + n;
          if (text.slice(start, end) === word.source || !free(start, end)) continue;
          if (soundsLike(heard.slice(i, i + n), word.sound)) found.push({ start, end, source: word.source });
        }
      }
    }
  }
  if (kanaWords.length > 0) {
    for (const run of text.matchAll(KANA_RUN)) {
      const chars = [...run[0]];
      for (const word of kanaWords) {
        // A long vowel or a double consonant more or fewer changes the length by one or two.
        for (let length = Math.max(1, word.length - 2); length <= word.length + 2; length++) {
          for (let i = 0; i + length <= chars.length; i++) {
            const piece = chars.slice(i, i + length).join('');
            const start = run.index! + chars.slice(0, i).join('').length;
            const end = start + piece.length;
            if (piece === word.source || !free(start, end)) continue;
            if (kanaKey(piece) === word.key) found.push({ start, end, source: word.source });
          }
        }
      }
    }
  }
  if (found.length === 0) return text;

  // The longest first, then the earliest; none over another.
  found.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start);
  const taken: Found[] = [];
  for (const f of found) if (!taken.some((t) => f.start < t.end && t.start < f.end)) taken.push(f);
  taken.sort((a, b) => b.start - a.start);
  let out = text;
  for (const t of taken) out = out.slice(0, t.start) + t.source + out.slice(t.end);
  return out;
}
