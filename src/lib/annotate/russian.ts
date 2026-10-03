/**
 * Russian in Latin letters: a practical table close to BGN/PCGN, one letter
 * at a time. It shows how a word is spelled, not where its stress falls —
 * stress needs a dictionary, which is not here.
 */
const TABLE: Readonly<Record<string, string>> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
  ъ: '', ы: 'y', ь: "'", э: 'e', ю: 'yu', я: 'ya',
  // The letters Ukrainian and Belarusian add, so a neighbour's text is not left half-converted.
  і: 'i', ї: 'yi', є: 'ye', ґ: 'g', ў: 'w',
};
const VOWELS = new Set('аеёиоуыэюяіїє');

export function transliterateRussian(text: string): string {
  let out = '';
  let previous = '';
  for (const char of text) {
    const lower = char.toLowerCase();
    let latin = TABLE[lower];
    if (latin === undefined) {
      out += char;
      previous = lower;
      continue;
    }
    // «е» opens a syllable as "ye": at a word's start, after a vowel, after ъ or ь.
    if (lower === 'е' && (previous === '' || !/\p{L}/u.test(previous) || VOWELS.has(previous) || previous === 'ъ' || previous === 'ь')) latin = 'ye';
    out += char !== lower && latin !== '' ? latin[0].toUpperCase() + latin.slice(1) : latin;
    previous = lower;
  }
  return out;
}
