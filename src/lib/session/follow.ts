/**
 * Fork: the language the user's speech is translated into follows the other side's (`Run`'s follow): talking with a
 * Korean and a Japanese speaker at once, each is answered in theirs. A short VRChat chatbox holds one translation, so
 * the user's speech goes into one language at a time, and that language must not jump about on a stray word.
 *
 * Only the other side's sentences that clearly say a language move it: long enough to tell (`FOLLOW_LEAST`), not the
 * user's own language (their voice come back, or the other side speaking it), and one the user's speech can be
 * translated into. It moves after two such sentences in a row in the new language, or one long one (`FOLLOW_ALONE`).
 */
import { baseLanguage } from '../language/code';

/** How much a sentence must hold to count: a letter of a script written without spaces counts three. */
export const FOLLOW_LEAST = 12;
/** A sentence this long moves it by itself. */
export const FOLLOW_ALONE = 45;

/** Letters, a CJK, kana, Hangul or Thai one weighed as about a word's worth of a spaced script's. */
export function followWeight(text: string): number {
  let weight = 0;
  for (const ch of text) {
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u.test(ch)) weight += 3;
    else if (/\p{L}/u.test(ch)) weight += 1;
  }
  return weight;
}

export interface Follower {
  /** The language followed now. */
  readonly now: string;
  /**
   * A sentence the other side finished, in `language` (as the recognizer or its writing said): the language to
   * follow from now on, where it moves (`moved` once the user's speech goes there); else null.
   */
  heard(text: string, language: string | undefined): string | null;
  /** The user's speech goes into `language` now. */
  moved(language: string): void;
  /** The user's speech could not be translated into `language`: it is not followed there again this run. */
  unfit(language: string): void;
  /** The language followed was set from outside (the user picked a pair): counted from it afresh. */
  reset(now: string, own: string): void;
}

/** `among`: the languages the other side may speak, those chosen for them; absent, any. */
export function createFollower(start: string, own: string, among?: readonly string[]): Follower {
  let now = start;
  let mine = baseLanguage(own) ?? own;
  let last: string | null = null;
  const unfit = new Set<string>();
  const base = (code: string) => (baseLanguage(code) ?? code).toLowerCase();
  const allowed = among ? new Set(among.map(base)) : null;
  return {
    get now() { return now; },
    heard(text, language) {
      if (!language || language === 'auto') return null;
      const said = base(language);
      const weight = followWeight(text);
      if (weight < FOLLOW_LEAST || said === base(mine) || unfit.has(said) || (allowed && !allowed.has(said))) return null;
      if (said === base(now)) {
        last = said;
        return null;
      }
      const moves = last === said || weight >= FOLLOW_ALONE;
      last = said;
      return moves ? language : null;
    },
    moved(language) {
      now = language;
    },
    unfit(language) {
      unfit.add(base(language));
    },
    reset(start2, own2) {
      now = start2;
      mine = baseLanguage(own2) ?? own2;
      last = null;
    },
  };
}
