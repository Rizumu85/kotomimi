/**
 * Fork: whether a word of the dictionary in a reading was said. A recognizer told the words to expect (Qwen3-ASR)
 * writes a name as the dictionary writes it — and now and then writes one over other words, or over nothing at all
 * (`electron/native-engine.js`, `hintChecked`). The same stretch is read again without the words, and the engine
 * says what that plain reading has in each word's place. A name said is still heard there, spelled some other way,
 * and sounds like the word; other words do not, and the plain reading stands in that place.
 *
 * "Sounds like" is rougher here than where the dictionary looks for a name in a sentence (`sound.ts`): there a
 * stretch must be told from everyday words; here a word the recognizer already put in the sentence is only asked
 * whether anything like it was heard.
 */
import type { HintedPlace } from '../native/nativeEngine';
import { lettersOf, scriptOf, sound } from './phonetic';

const RUNS = /\p{Script=Latin}+|\p{Script=Cyrillic}+|\p{Script=Hangul}+|[\p{Script=Hiragana}\p{Script=Katakana}ー]+|\p{Script=Han}+/gu;

/** A capital letter as it is named, for a word that is spelled out (VRC, AI). */
const NAMES: Record<string, string> = {
  A: 'ei', B: 'bi', C: 'si', D: 'di', E: 'i', F: 'ef', G: 'ji', H: 'eich', I: 'ai', J: 'jei', K: 'kei', L: 'el', M: 'em', N: 'en', O: 'ou',
  P: 'pi', Q: 'kyu', R: 'ar', S: 'es', T: 'ti', U: 'yu', V: 'vi', W: 'daburu', X: 'eks', Y: 'wai', Z: 'zi',
};
const SPELLED = /^[A-Z]{2,5}$/;

/**
 * The consonants of a text as it sounds, whatever it is written in: each run read by its script, the looser key.
 * `spelled`: a short run of capitals is read letter by letter, as an abbreviation is said.
 */
function consonants(text: string, spelled: boolean): string {
  let letters = '';
  for (const run of text.matchAll(RUNS)) {
    const script = scriptOf(run[0]);
    if (!script) continue;
    letters += spelled && SPELLED.test(run[0]) ? [...run[0]].map((c) => NAMES[c]).join('') : lettersOf(run[0], script);
  }
  return sound(letters, true).consonants;
}

function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next.push(Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    row = next;
  }
  return row[b.length];
}

/**
 * Whether what was heard may be the word: the same consonants in order, but for one in a word of four or five and
 * two in a longer one. A word of three or fewer has to have its own: with so few, most stretches would pass.
 */
export function heardAs(word: string, heard: string): boolean {
  // Read as a word, and — capitals — as letters named: either way of saying it may be what was heard.
  for (const spelled of [false, true]) {
    const a = consonants(word, spelled);
    // A word of vowels alone, or in a script not read here: nothing to go by, and it is left as written.
    if (a.length === 0) return true;
    const most = a.length <= 3 ? 0 : a.length <= 5 ? 1 : 2;
    if ([false, true].some((other) => distance(a, consonants(heard, other)) <= most)) return true;
  }
  return false;
}

/** The reading with every hinted word that was not heard given back what the plain reading has in its place. */
export function settleHinted(text: string, places: readonly HintedPlace[]): string {
  let out = text;
  for (const place of [...places].sort((x, y) => y.start - x.start)) {
    if (heardAs(text.slice(place.start, place.end), place.plain)) continue;
    out = out.slice(0, place.start) + place.plain + out.slice(place.end);
  }
  return out;
}
