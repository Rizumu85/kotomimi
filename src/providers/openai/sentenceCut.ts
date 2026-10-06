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
 * A sentence is finished when its closing mark has more said after it, and
 * its text has stood unchanged for a moment (`SETTLE_MS`): a recognizer that
 * shows what it has heard before that is settled rewrites its last words.
 * A very short one ("はい。") waits for the next: alone it is a caption that
 * is gone before it is read, and a translation with nothing to go on.
 *
 * A sentence the speaker merely stops at is not closed here, however long
 * the stop: that is the recognizer's own pause to call. Closing it after
 * 0.9 s was tried (2026-10-06) and cut sentences in two — this computer's
 * recognizer ends whatever it has heard so far with a full stop, so a
 * breath in the middle of a sentence read as its end ("お正月の。" /
 * "イメージあるよね。", each translated alone, and wrongly).
 *
 * Pure.
 */
import { SENTENCE_CLOSERS, SENTENCE_TERMINALS, sentenceEnds } from '../../lib/segmentation/sentenceEnd';

/** A piece's text has to stand this long, unchanged, before it is closed. */
export const SETTLE_MS = 400;
/** The least a piece holds, in letters: of a script written without spaces, and of any other. */
export const PIECE_LEAST_DENSE = 6;
export const PIECE_LEAST = 14;
/** The letters that have to follow a closing mark before the sentence counts as finished: the speaker has gone on. */
export const PIECE_AFTER = 2;

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
 * Just past the last sentence end of `text` that may be cut at: more is said
 * after it, and what is before it is long enough to stand alone. -1: nowhere
 * yet.
 */
export function cutAt(text: string): number {
  const ends = sentenceEnds(text);
  for (let i = ends.length - 1; i >= 0; i--) {
    const end = ends[i];
    if (letters(text.slice(end)) < PIECE_AFTER) continue;
    // Every earlier end leaves less before it.
    return letters(text.slice(0, end)) >= least(text) ? end : -1;
  }
  return -1;
}

const least = (text: string): number => (DENSE.test(text) ? PIECE_LEAST_DENSE : PIECE_LEAST);

/**
 * Where what is left of a stretch begins in its text as it now reads, given
 * the text that was closed as pieces (`done`, the stretch's beginning as it
 * read then). A recognizer may have rewritten that beginning since — its
 * marks and spacing most of all — so where it no longer reads the same, the
 * place is found by its letters alone: as many as were closed, and the marks
 * that close them.
 */
export function restFrom(text: string, done: string): number {
  if (!done) return 0;
  if (text.startsWith(done)) return done.length;
  const want = letters(done);
  let seen = 0;
  let i = 0;
  // By code units: a letter outside the basic plane is two of them, counted once at its first.
  for (const ch of text) {
    if (seen >= want) break;
    if (LETTER.test(ch)) seen += 1;
    i += ch.length;
  }
  while (i < text.length && (SENTENCE_TERMINALS.includes(text[i]) || SENTENCE_CLOSERS.includes(text[i]) || /\s/.test(text[i]))) i += 1;
  return i;
}
