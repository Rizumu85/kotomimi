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
 * written with spaces. Never under 1.2 s.
 *
 * And never so long that the captions fall behind a fast speaker: a hold
 * only ever delays the next caption, so it is bounded. An answer is held
 * no more than 2.5 s; with a second one waiting behind the next, only the
 * least; and of a longer queue the oldest are passed over. A caption is
 * then at most about two and a half seconds behind where it would have
 * been, and the first pause in the talk brings it level — a caption read
 * but seconds behind the voice is no better than one missed. (The first
 * version held up to 5 s, and 2.5 s each of a queue: with captions coming
 * every two seconds that drifts.)
 *
 * Pure: the component keeps the clock (`SubtitleLanes`).
 */
import type { LegName } from '../conversation/types';
import type { Entry, Row } from '../projection/types';

export const HOLD_LEAST_MS = 1200;
export const HOLD_MOST_MS = 2500;

const baseOf = (language: string | undefined): string => (language ?? '').toLowerCase().split(/[-_]/)[0];

/** Characters read in a second, by the language's base code; any other: `READ_CPS`. */
const READ_CPS_OF: Readonly<Record<string, number>> = { zh: 9, yue: 9, ja: 5, ko: 10 };
export const READ_CPS = 17;

/** How long a text takes to read in its language, within the least and the most a caption is held. */
export function readMs(text: string, language: string | undefined): number {
  const ms = (text.trim().length / (READ_CPS_OF[baseOf(language)] ?? READ_CPS)) * 1000;
  return Math.min(HOLD_MOST_MS, Math.max(HOLD_LEAST_MS, Math.round(ms)));
}

/** How long an answer is held while `waiting` newer ones are ready (at least one): its reading time — the least, with more than one. */
export function holdMs(text: string, language: string | undefined, waiting: number): number {
  return waiting > 1 ? HOLD_LEAST_MS : readMs(text, language);
}

/** Which answer is shown after the one at `at`, the newest being at `last`: the next — or, far behind, the one before the newest. */
export function nextShown(at: number, last: number): number {
  return last - at > 2 ? last - 1 : at + 1;
}

export interface Answered { id: string; text: string; language: string }

type Exchange = Extract<Entry, { kind: 'exchange' }>;

/**
 * Fork: the other side said this, whole, in the language the answers are in: their language left to be detected, or
 * told one and written in the reader's. Nothing translates it (`pipeline.ts`), so it is its own answer. Waiting for one
 * that never came it stayed in the small line, under the sentence before's translation, and every sentence after it
 * too (2026-10-31). Not the speaker's: theirs, in that language, is what grammar feedback answers.
 */
export function answersItself(entry: Exchange): boolean {
  const target = baseOf(entry.languages.target);
  return entry.leg === 'participant' && baseOf(entry.languages.source) !== target
    && entry.source.length > 0 && entry.source.every((row) => row.final && baseOf(row.language) === target)
    && !entry.translation.some((row) => row.text.trim());
}

/** A translated caption, or standalone coaching feedback, or a sentence that is its own answer. Combined feedback never takes a translation's turn. */
export function captionRows(entry: Exchange): readonly Row[] {
  if (entry.translation.some((row) => row.text.trim())) return entry.translation;
  if (answersItself(entry)) return entry.source;
  return entry.feedback?.filter((row) => !row.accompaniesTranslation) ?? [];
}

/** A leg's answered sentences, oldest first: translated captions and standalone coaching feedback. */
export function answeredOf(entries: readonly Entry[], leg: LegName): Answered[] {
  const out: Answered[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'exchange' || entry.leg !== leg) continue;
    const rows = captionRows(entry);
    const text = rows.map((row) => row.text).join('').trim();
    if (text) out.push({ id: entry.id, text, language: rows[0]?.language || (rows[0]?.purpose === 'feedback' ? entry.languages.source : entry.languages.target) });
  }
  return out;
}

/** What a line shows of a list taken in turn: the one shown, and since when. */
export interface TurnShown { id: string; since: number }

/**
 * Fork: which of a list of answers is shown at `now`, given what was, and when to ask again (Infinity: when the list
 * changes): the newest, once each before it has been read (`holdMs`, `nextShown`). The clock of the line grammar
 * feedback is written in (`fedOf`): feedback often comes after the user has gone on, and shown only beside its own
 * sentence it was lost with it; and a tick for the next sentence must not take a correction's place unread.
 */
export function answerTurn(answered: readonly Answered[], before: TurnShown | undefined, now: number): { shown: TurnShown | undefined; due: number } {
  const last = answered.length - 1;
  if (last < 0) return { shown: undefined, due: Infinity };
  let at = before ? answered.findIndex((answer) => answer.id === before.id) : -1;
  let shown = at < 0 ? undefined : before;
  if (!shown) { at = last; shown = { id: answered[last].id, since: now }; }
  while (at < last) {
    const due = shown.since + holdMs(answered[at].text, answered[at].language, last - at);
    if (due > now) return { shown, due };
    at = nextShown(at, last);
    shown = { id: answered[at].id, since: now };
  }
  return { shown, due: Infinity };
}

/** Fork: a leg's sentences that have grammar feedback, oldest first: what the feedback's line shows in turn. */
export function fedOf(entries: readonly Entry[], leg: LegName): Answered[] {
  const out: Answered[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'exchange' || entry.leg !== leg) continue;
    const text = (entry.feedback ?? []).map((row) => row.text).join('').trim();
    if (text) out.push({ id: entry.id, text, language: entry.languages.source });
  }
  return out;
}

/**
 * Fork: the user's own row (`lanes.ts`) takes their sentences in turn, as a pair takes its answers.
 *
 * It showed the newest sentence the moment it had a word, so the answer to the one before was on screen only until
 * the user spoke again: of 1544 answered sentences in a week's records, 79 never showed their translation and 255
 * showed it for under a second (2026-11-17). Someone who goes on talking is who most wants to see what was just sent.
 * So a sentence stays until its answer has been read (`holdMs`, the same clock and the same bounds as a pair's: with
 * more than one waiting each has the least, and far behind the oldest are passed over), and one still waiting for its
 * answer is waited on a moment (`ANSWER_WAIT_MS`). Nobody spoke since: nothing is held, and the row is as it was.
 */
export const ANSWER_WAIT_MS = 1500;
export const UNANSWERED_FROM = 2;

export interface RowSentence {
  id: string;
  /** What answers it so far (`captionRows`), or nothing yet. */
  answer: string;
  language: string;
  /**
   * Nothing will answer it: a mishearing, or a side that is answered nothing (a run that only transcribes) — told by
   * more than `UNANSWERED_FROM` sentences with no answer to any. The first ones are waited on: taken for such a run,
   * a first sentence the user went on from at once never showed its translation.
   */
  unanswered: boolean;
}

/** What a row shows: the sentence, since when its answer has been on screen, and since when a newer one has waited behind it unanswered. */
export interface RowShown { id: string; since?: number; behind?: number }

/** A leg's sentences with anything written, oldest first, as a row takes them in turn. */
export function rowSentences(entries: readonly Entry[], leg: LegName): RowSentence[] {
  const out: Array<RowSentence & { misheard: boolean }> = [];
  for (const entry of entries) {
    if (entry.kind !== 'exchange' || entry.leg !== leg) continue;
    const rows = captionRows(entry);
    const answer = rows.map((row) => row.text).join('').trim();
    if (!answer && !entry.source.some((row) => row.text.trim())) continue;
    const misheard = entry.source.length > 0 && entry.source.every((row) => row.misheard);
    out.push({ id: entry.id, answer, language: rows[0]?.language || (rows[0]?.purpose === 'feedback' ? entry.languages.source : entry.languages.target), unanswered: misheard, misheard });
  }
  const silent = out.length > UNANSWERED_FROM && !out.some((sentence) => sentence.answer);
  return out.map(({ misheard, ...sentence }) => ({ ...sentence, unanswered: misheard || silent }));
}

/**
 * Which sentence a row shows at `now`, given what it showed, and when to ask again (Infinity: when the conversation
 * changes). The newest, unless the one shown has an answer not yet read, or one on its way.
 */
export function rowTurn(sentences: readonly RowSentence[], before: RowShown | undefined, now: number): { shown: RowShown | undefined; due: number } {
  const last = sentences.length - 1;
  if (last < 0) return { shown: undefined, due: Infinity };
  let at = before ? sentences.findIndex((sentence) => sentence.id === before.id) : -1;
  let shown = at < 0 ? undefined : before;
  // Nothing shown yet, or what was shown is gone (the conversation was cleared): the newest, at once.
  if (!shown) { at = last; shown = { id: sentences[last].id }; }
  for (;;) {
    const sentence = sentences[at];
    if (sentence.answer && shown.since === undefined) shown = { ...shown, since: now };
    if (at === last) return { shown, due: Infinity };
    let due = now;
    if (sentence.answer) {
      due = shown.since! + holdMs(sentence.answer, sentence.language, last - at);
    } else if (!sentence.unanswered) {
      if (shown.behind === undefined) shown = { ...shown, behind: now };
      due = shown.behind! + ANSWER_WAIT_MS;
    }
    if (due > now) return { shown, due };
    at = nextShown(at, last);
    shown = { id: sentences[at].id };
  }
}
