/**
 * Fork: which language a finished sentence is in, when the recognizer did not
 * say. Two steps, cheapest first:
 *
 * - the writing (`script.ts`): kana, hangul, Cyrillic and the like, and the
 *   little words of the six Latin-letter languages most often met;
 * - a small text language detector (`tinyld`, 64 languages), for the pairs
 *   the writing cannot tell apart — English and French, Spanish and
 *   Portuguese — where a sentence is long enough for statistics to work.
 *
 * It never invents a language outside the candidates it was given. A guess is
 * a best effort: the pipeline uses it to route translation and feedback, not
 * to refuse a sentence.
 */
import { detectAll } from 'tinyld';
import { languageByScript, oneOfTwo } from './script';

/** How a language was named: the writing itself, or statistics over the text. */
export type GuessSource = 'script' | 'text';

export interface LanguageGuess {
  /** A base code (`en`, `zh`, `ja`), as the app speaks of languages. */
  language: string;
  source: GuessSource;
  /** The detector's own score, 0..1; 1 for a script that names the language. */
  confidence: number;
}

const baseOf = (code: string): string => code.trim().toLowerCase().split(/[-_]/)[0];

const inCandidates = (language: string, candidates: readonly string[]): boolean =>
  candidates.length === 0 || candidates.some((candidate) => baseOf(candidate) === language);

/** Below this a sentence is too short for the statistics to say much. */
const TEXT_MIN_CHARS = 12;
/** The detector's score a guess must reach, and how far ahead of the next candidate it must be. */
const TEXT_MIN_SCORE = 0.45;
const TEXT_MIN_MARGIN = 0.25;

/** These scripts are shared by several languages; they identify a language only within an unambiguous pair. */
const SHARED_SCRIPTS: Readonly<Record<string, readonly string[]>> = {
  ru: ['ru', 'uk', 'be', 'bg', 'mk', 'sr', 'kk', 'ky', 'mn', 'tg'],
  ar: ['ar', 'fa', 'ur', 'ps', 'sd', 'ug'],
  hi: ['hi', 'mr', 'ne', 'sa', 'bho', 'mai'],
};

/** The language the writing itself names, when that is one of the candidates. */
export function scriptLanguage(text: string, candidates: readonly string[] = []): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const bases = candidates.map(baseOf).filter(Boolean);
  // Two candidates: `oneOfTwo` knows the Latin-letter pair and the Han/Kana doubt.
  const found = bases.length === 2 ? oneOfTwo(trimmed, bases[0]!, bases[1]!) : languageByScript(trimmed);
  const shared = found ? SHARED_SCRIPTS[found] : undefined;
  if (shared && (bases.length === 0 || bases.filter((language) => shared.includes(language)).length !== 1)) return null;
  return found && inCandidates(found, bases) ? found : null;
}

/**
 * The language statistics name, among the candidates. Null when the text is
 * too short, the score too low, or the winner not one of the candidates.
 */
export function textLanguage(text: string, candidates: readonly string[] = []): LanguageGuess | null {
  const trimmed = text.trim();
  if (trimmed.length < TEXT_MIN_CHARS) return null;
  const bases = candidates.map(baseOf).filter(Boolean);
  const scored = detectAll(trimmed)
    .map((one) => ({ language: baseOf(one.lang), score: one.accuracy }))
    .filter((one) => inCandidates(one.language, bases));
  const first = scored[0];
  if (!first || first.score < TEXT_MIN_SCORE) return null;
  // A second candidate close behind is no answer: the two are not told apart.
  const second = scored.find((one) => one.language !== first.language);
  if (second && first.score - second.score < TEXT_MIN_MARGIN) return null;
  return { language: first.language, source: 'text', confidence: first.score };
}

/** A sentence's language: its writing first, then the small text detector. */
export function identifyLanguage(text: string, candidates: readonly string[] = []): LanguageGuess | null {
  const written = scriptLanguage(text, candidates);
  if (written) return { language: written, source: 'script', confidence: 1 };
  return textLanguage(text, candidates);
}

/** The port the pipeline asks, as the punctuation model is one: pure, synchronous, and safe to call per sentence. */
export type LanguageIdentifier = (text: string, candidates?: readonly string[]) => LanguageGuess | null;

export const identify: LanguageIdentifier = identifyLanguage;
