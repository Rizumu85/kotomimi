/**
 * Ukrainian in Latin letters by Ukraine's own national system (Cabinet of
 * Ministers resolution 55, 2010) — as upstream writes it
 * (kizuna-ai-lab/sokuji#632). Not Russian's table: г is h, и is y, і is i.
 * є ї й ю я are ye yi y yu ya at the start of a word and ie i i iu ia inside
 * it; зг is zgh; the soft sign and the apostrophe are not written. It spells
 * the word, not its stress.
 */
const TABLE: Readonly<Record<string, string>> = {
  а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z', и: 'y', і: 'i', к: 'k', л: 'l',
  м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch',
  ш: 'sh', щ: 'shch', ь: '',
};
/** Letters written one way at the start of a word and another inside it. */
const INITIAL: Readonly<Record<string, readonly [string, string]>> = {
  є: ['ye', 'ie'], ї: ['yi', 'i'], й: ['y', 'i'], ю: ['yu', 'iu'], я: ['ya', 'ia'],
};
const APOSTROPHES = new Set(["'", '’', 'ʼ']);
const LETTER = /\p{L}/u;

export function transliterateUkrainian(text: string): string {
  let out = '';
  // The letter before, within the word: an apostrophe inside a word (м'ясо) does not begin a new one.
  let previous = '';
  for (const char of text) {
    const lower = char.toLowerCase();
    if (APOSTROPHES.has(char) && LETTER.test(previous)) continue;
    const initial = INITIAL[lower];
    let latin = initial ? initial[LETTER.test(previous) ? 1 : 0] : lower === 'г' && previous === 'з' ? 'gh' : TABLE[lower];
    if (latin === undefined) {
      out += char;
      previous = LETTER.test(char) ? lower : '';
      continue;
    }
    if (char !== lower && latin !== '') latin = latin[0].toUpperCase() + latin.slice(1);
    out += latin;
    previous = lower;
  }
  return out;
}
