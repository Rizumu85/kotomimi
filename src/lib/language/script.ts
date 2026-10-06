/**
 * Fork: the language a sentence is in, as far as its writing says.
 *
 * A recognizer left to detect the language writes the sentence and does not
 * say which language it found. Most of the languages met in a room write
 * themselves in a script of their own, so the writing answers: kana is
 * Japanese, hangul Korean, Cyrillic is taken for Russian, and so on. A
 * sentence in Latin letters could be any of dozens of languages: it is named
 * only where its commonest words leave no doubt between the six most often
 * met, and is otherwise left unnamed — it is still translated; it only gets
 * no reading aids.
 *
 * Han characters with no kana are read as Chinese: a Japanese sentence
 * written in kanji alone is rare in speech, and short.
 */
const SCRIPTS: ReadonlyArray<readonly [language: string, letters: RegExp]> = [
  ['ko', /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/g],
  ['ru', /[\u0400-\u04ff]/g],
  ['th', /[\u0e00-\u0e7f]/g],
  ['ar', /[\u0600-\u06ff]/g],
  ['hi', /[\u0900-\u097f]/g],
  ['el', /[\u0370-\u03ff]/g],
  ['he', /[\u0590-\u05ff]/g],
];
const KANA = /[\u3040-\u30ff]/g;

/** The little words a language cannot do without, for the six Latin-letter languages most often met. */
const WORDS: Readonly<Record<string, readonly string[]>> = {
  en: ['the', 'and', 'is', 'are', 'you', 'this', 'that', 'what', 'to', 'of', 'my', 'have', 'it', 'not', 'with', 'for', 'was', 'do', 'from', 'really'],
  es: ['el', 'la', 'los', 'las', 'que', 'es', 'y', 'de', 'hola', 'muy', 'pero', 'soy', 'estoy', 'una', 'un', 'por', 'para', 'hoy', 'no', 'con', 'buenas', 'gracias', 'esto', 'este', 'tiempo'],
  fr: ['le', 'la', 'les', 'est', 'et', 'je', 'tu', 'vous', 'nous', 'pas', 'bonjour', 'très', 'une', 'un', 'des', 'que', 'de', 'ce', 'il', 'avec', 'merci', 'suis', 'pour'],
  de: ['der', 'die', 'das', 'und', 'ist', 'ich', 'nicht', 'du', 'wir', 'ein', 'eine', 'hallo', 'sehr', 'heute', 'mit', 'für', 'bin', 'es', 'zu', 'danke', 'auch'],
  it: ['il', 'lo', 'la', 'che', 'è', 'e', 'sono', 'non', 'ciao', 'molto', 'oggi', 'una', 'un', 'per', 'di', 'con', 'grazie', 'questo', 'mi'],
  pt: ['o', 'a', 'os', 'as', 'que', 'é', 'e', 'eu', 'não', 'olá', 'muito', 'hoje', 'uma', 'um', 'para', 'você', 'de', 'com', 'obrigado', 'isso', 'estou'],
};

/** A Latin-letter sentence's language: the one whose little words it uses most, when that is at least two of them and clearly more than any other's. */
function languageByWords(text: string): string | undefined {
  const words = text.toLowerCase().match(/[a-z\u00c0-\u024f']+/g) ?? [];
  if (words.length < 3) return undefined;
  const scores = Object.entries(WORDS).map(([language, list]) => [language, words.filter((word) => list.includes(word)).length] as const).sort((a, b) => b[1] - a[1]);
  const [first, second] = scores;
  return first[1] >= 2 && first[1] >= second[1] + 2 ? first[0] : undefined;
}
const HAN = /[\u3400-\u9fff]/g;

/** The language's base code, or undefined where the writing does not say. */
export function languageByScript(text: string): string | undefined {
  const count = (letters: RegExp) => text.match(letters)?.length ?? 0;
  // Kana anywhere makes it Japanese, whatever else is written around it.
  if (count(KANA) > 0) return 'ja';
  let best: string | undefined;
  let most = 0;
  for (const [language, letters] of [...SCRIPTS, ['zh', HAN] as const]) {
    const n = count(letters);
    if (n > most) { most = n; best = language; }
  }
  return best ?? languageByWords(text);
}

/** Fewer Han characters than this, and no kana, may as well be Japanese ("大丈夫", "了解"): a sentence of them is Chinese. */
const HAN_SENTENCE = 5;

/**
 * Whether a sentence is in the speaker's own language and not in the one they
 * practise, as far as its writing says. A speaker who is given feedback on
 * what they say in another language still says a sentence of their own now
 * and then: that one is no practice, and is not sent for feedback. Where the
 * writing leaves a doubt the answer is no — the sentence is taken as practice.
 */
export function saidInOwn(text: string, own: string, practised: string): boolean {
  const base = (code: string) => code.toLowerCase().split(/[-_]/)[0];
  const mine = base(own);
  if (mine === base(practised) || languageByScript(text) !== mine) return false;
  // Chinese and Japanese share their characters: a few of them alone say nothing.
  if (mine === 'zh' && base(practised) === 'ja') return (text.match(HAN)?.length ?? 0) >= HAN_SENTENCE;
  return true;
}
