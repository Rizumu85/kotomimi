/**
 * Fork: where a translation lost its way. A small model now and then writes the same few letters over and over until
 * its tokens run out: Index-Translate turned 「咕噜咕噜咕噜噜咕噜…」, 19 letters, into ゴロ five hundred times over —
 * ten seconds in which every later sentence waited for it, and then a VRChat chatbox paging through a thousand
 * letters (the user, 2026-11-16).
 *
 * An answer is cut where its end is one short thing said again and again (`RUN_REPEATS` times or more, `RUN_LETTERS`
 * letters or more) and it has already grown far past what its sentence could need (`ROOM`). Laughter written out, or a
 * long sound someone really made, is repeated in the sentence too, and its translation stays within that room.
 */
const UNIT_MOST = 20;
const RUN_REPEATS = 8;
const RUN_LETTERS = 40;
/** The letters an answer may have before a repeating end is taken for a loop: three for each of the sentence's, and twenty. */
const ROOM = (sentence: number): number => sentence * 3 + 20;

/**
 * Where to cut `answer`, the translation of `sentence` so far, as a count of its UTF-16 units; -1 where it has not
 * lost its way. What is kept of the repeating is about as long as the sentence, and three times the thing at least.
 */
export function runawayAt(answer: string, sentence: string): number {
  const letters = Array.from(answer);
  const said = Array.from(sentence).length;
  if (letters.length <= ROOM(said)) return -1;
  const end = letters.length;
  for (let unit = 1; unit <= UNIT_MOST; unit += 1) {
    // How far back from the end every letter is the one `unit` before it.
    let from = end - unit;
    while (from > 0 && letters[from - 1] === letters[from - 1 + unit]) from -= 1;
    const run = end - from;
    if (run < RUN_LETTERS || run < unit * RUN_REPEATS) continue;
    const kept = Math.max(unit * 3, Math.floor(Math.max(0, said - from) / unit) * unit);
    return letters.slice(0, from + kept).join('').length;
  }
  return -1;
}

/**
 * The tokens a translation of `sentence` is given at most, where its model is given a limit at all: six for each of
 * its letters, and forty-eight. A model that loops stops there, on a device that goes on writing after the request
 * was dropped (a phone or tablet lending its model does one thing at a time: the next sentence waits for it).
 */
export function tokensFor(sentence: string): number {
  return Array.from(sentence).length * 6 + 48;
}

/** A translation request's extras, with the limit on its tokens lowered to what `sentence` can need, where it has one. */
export function boundedFor(extra: Readonly<Record<string, unknown>>, sentence: string): Readonly<Record<string, unknown>> {
  return typeof extra.max_tokens === 'number' ? { ...extra, max_tokens: Math.min(extra.max_tokens, tokensFor(sentence)) } : extra;
}
