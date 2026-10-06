/**
 * Fork: how long a caption stays before the next takes its place.
 *
 * A lane shows its side's newest answered sentence. Answers do not come
 * evenly: two short sentences are answered a moment apart, or a stretch
 * ends and its last sentence follows the one before at once — and the one
 * before was on the screen for a fraction of a second, gone before it was
 * read. So an answer stays long enough to be read before a newer one takes
 * its place: its length at the pace its language is read at, as subtitling
 * counts it — about nine characters a second of Chinese, five of Japanese
 * (broadcast captions count four), ten of Korean, seventeen of a language
 * written with spaces. Never under 1.2 s, never over 5 s; and where more
 * than one is waiting, no more than 2.5 s, and the oldest of a long queue
 * are passed over: a caption that is read but seconds behind the voice is
 * no better than one that is missed.
 *
 * Pure: the component keeps the clock (`SubtitleLanes`).
 */
import type { LegName } from '../conversation/types';
import type { Entry } from '../projection/types';

export const HOLD_LEAST_MS = 1200;
export const HOLD_MOST_MS = 5000;
export const HOLD_MOST_WAITING_MS = 2500;

/** Characters read in a second, by the language's base code; any other: `READ_CPS`. */
const READ_CPS_OF: Readonly<Record<string, number>> = { zh: 9, yue: 9, ja: 5, ko: 10 };
export const READ_CPS = 17;

/** How long a text takes to read in its language, within the least and the most a caption is held. */
export function readMs(text: string, language: string | undefined): number {
  const base = (language ?? '').toLowerCase().split(/[-_]/)[0];
  const ms = (text.trim().length / (READ_CPS_OF[base] ?? READ_CPS)) * 1000;
  return Math.min(HOLD_MOST_MS, Math.max(HOLD_LEAST_MS, Math.round(ms)));
}

/** How long an answer is held while `waiting` newer ones are ready (at least one). */
export function holdMs(text: string, language: string | undefined, waiting: number): number {
  const need = readMs(text, language);
  return waiting > 1 ? Math.min(need, HOLD_MOST_WAITING_MS) : need;
}

/** Which answer is shown after the one at `at`, the newest being at `last`: the next — or, far behind, the one before the newest. */
export function nextShown(at: number, last: number): number {
  return last - at > 2 ? last - 1 : at + 1;
}

export interface Answered { id: string; text: string; language: string }

/** A leg's answered sentences, oldest first: what has a translation written. */
export function answeredOf(entries: readonly Entry[], leg: LegName): Answered[] {
  const out: Answered[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'exchange' || entry.leg !== leg) continue;
    const text = entry.translation.map((row) => row.text).join('').trim();
    if (text) out.push({ id: entry.id, text, language: entry.translation[0]?.language || entry.languages.target });
  }
  return out;
}
