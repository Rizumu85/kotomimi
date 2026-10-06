/**
 * Fork: where a stretch that is still being heard may be handed on, a
 * sentence at a time.
 *
 * A recognizer closes a stretch at a pause (1.4 s) or at its longest turn
 * (15 s). Someone who talks on is one stretch of several sentences: its text
 * outgrows any caption line, and none of it is translated until all of it
 * has been said. So the leg that answers what it hears (`pipeline.ts`) closes
 * the stretch's finished sentences as they come — each its own segment, sent
 * for its answer at once — while the recognizer goes on hearing the same
 * stretch: its sound is not cut, only its text.
 *
 * What is handed on has to be right, more than it has to be early: a caption
 * closed and translated cannot be taken back. So a sentence is closed only
 * when:
 *
 * - a good deal more has been said after its closing mark — as much as a
 *   piece holds at least (`PIECE_LEAST`, about two seconds of speech). A
 *   recognizer that shows what it has heard before that is settled rewrites
 *   its newest words, and ends whatever it has so far with a full stop; two
 *   seconds on, a sentence is no longer its newest words. And what is left
 *   of the stretch after a cut is then never a scrap ("柄的に。", closed
 *   alone and "translated" as itself, when two letters were enough);
 * - its text has stood unchanged for a moment (`SETTLE_MS`);
 * - it is long enough itself (`PIECE_LEAST`): shorter sentences ("はい。",
 *   "これもかな？") go with the next, as one caption — alone each was gone
 *   before it was read, and a translation with nothing to go on.
 *
 * A caption that changes has to be found again by the eye each time, and
 * one too long does not fit its two lines or a glance: subtitling keeps to
 * about one and a half to seven seconds a caption, which is what these
 * lengths come to. The counts are of letters, by the kind of script:
 * Japanese and Chinese are spoken at five or six letters a second, a
 * language written with spaces at about thirteen.
 *
 * Never anywhere but a sentence end. A sentence the speaker merely stops at
 * is not closed here, however long the stop: that is the recognizer's own
 * pause to call (closing it after 0.9 s cut "お正月の。" from "イメージ
 * あるよね。", 2026-10-06). And a long run with no sentence end is not cut
 * at a comma: that was tried the same day and taken out before anyone used
 * it — half a Japanese sentence has no verb yet, and its translation is a
 * guess. Such a run waits for its end, or for the recognizer's own limit, as
 * it always did.
 *
 * So this only ever does something where a recognizer writes punctuation as
 * it hears (Qwen3-ASR does; R2T2 writes next to none, and its stretches are
 * answered whole, as before).
 *
 * Pure.
 */
import { SENTENCE_CLOSERS, SENTENCE_TERMINALS, sentenceEnds } from '../../lib/segmentation/sentenceEnd';

/** A piece's text has to stand this long, unchanged, before it is closed. */
export const SETTLE_MS = 400;
/**
 * The least a piece holds, in letters — and the least that has to be said after a sentence before it is closed: of a
 * script written without spaces, and of any other. About two seconds said.
 */
export const PIECE_LEAST_DENSE = 10;
export const PIECE_LEAST = 28;

const LETTER = /[\p{L}\p{N}]/u;
/** Kana, Han, Hangul and Thai: written without spaces, a few letters are a sentence. */
const DENSE = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\u0e00-\u0e7f]/;

/** How many letters and digits a text holds. */
export function letters(text: string): number {
  let n = 0;
  for (const ch of text) if (LETTER.test(ch)) n += 1;
  return n;
}

/**
 * Where `text` may be cut: just past its last sentence end that a piece's worth has been said after, where what is
 * before it is a piece's worth too. -1: nowhere yet.
 */
export function cutAt(text: string): number {
  const ends = sentenceEnds(text);
  const few = least(text);
  for (let i = ends.length - 1; i >= 0; i--) {
    const end = ends[i];
    if (letters(text.slice(end)) < few) continue;
    // Every earlier end leaves less before it.
    return letters(text.slice(0, end)) >= few ? end : -1;
  }
  return -1;
}

const least = (text: string): number => (DENSE.test(text) ? PIECE_LEAST_DENSE : PIECE_LEAST);

/** How many of the closed text's last letters are looked for in the text as it now reads, and how far from where they are expected. */
const ANCHOR_LETTERS = 5;
const ANCHOR_REACH = 10;

/**
 * Where what is left of a stretch begins in its text as it now reads, given
 * the text that was closed as pieces (`done`, the stretch's beginning as it
 * read then). A recognizer's last word on a stretch often reads a little
 * otherwise than what it showed on the way — its marks and spacing most of
 * all, but letters too (of eight minutes of talk, measured 2026-10-06: a
 * word added in front, "飲んどいた" become "飲んだ"). So where the text no
 * longer begins as it was closed, the place is found by what the closed text
 * ended with: its last few letters, nearest to where a count of letters
 * expects them — and by that count alone where they are no longer there.
 * Then past the marks that close them.
 */
export function restFrom(text: string, done: string): number {
  if (!done) return 0;
  if (text.startsWith(done)) return done.length;
  // The text's letters, and where each stands in it (in code units; a letter outside the basic plane is two).
  const found: string[] = [];
  const ends: number[] = [];
  let at = 0;
  for (const ch of text) {
    at += ch.length;
    if (LETTER.test(ch)) { found.push(ch.toLowerCase()); ends.push(at); }
  }
  const closed = [...done].filter((ch) => LETTER.test(ch)).map((ch) => ch.toLowerCase());
  const want = closed.length;
  if (want === 0) return 0;
  const tail = closed.slice(-ANCHOR_LETTERS);
  // The nearest place the closed text's last letters end at, in letters.
  let best = -1;
  for (let end = Math.max(tail.length, want - ANCHOR_REACH); end <= Math.min(found.length, want + ANCHOR_REACH); end++) {
    if (tail.every((ch, i) => found[end - tail.length + i] === ch) && (best < 0 || Math.abs(end - want) < Math.abs(best - want))) best = end;
  }
  const upTo = best >= 0 ? best : Math.min(want, found.length);
  let i = upTo > 0 ? ends[upTo - 1] : 0;
  while (i < text.length && (SENTENCE_TERMINALS.includes(text[i]) || SENTENCE_CLOSERS.includes(text[i]) || /\s/.test(text[i]))) i += 1;
  return i;
}
