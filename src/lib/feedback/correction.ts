/**
 * Fork: grammar feedback as a corrected sentence. The feedback stage answers a sentence with its corrected form on
 * the first line and why on the next (`tidyAnswer` in `src/providers/openai/pipeline.ts`), or with a tick where it
 * is right. Shown as written — the sentence, an arrow, another sentence and its reason — it had to be read with
 * care to see what had changed (the user, 2026-10-23). Here the two sentences are laid over each other: what the
 * speaker said, with what goes struck out and what comes written in, word by word, and the reason under it, as a
 * teacher marks a page.
 *
 * Words are the language's own (`Intl.Segmenter`): Japanese and Chinese have no spaces to tell them by. Pure.
 */

export type CorrectionPart = { text: string; kind: 'same' | 'gone' | 'added' };

export interface Correction {
  /** The sentence said, with what goes and what comes in their places. A sentence found right is one `same` part. */
  parts: CorrectionPart[];
  /** Why, in the feedback's words; blank where it gave none. */
  why: string;
  /** The sentence was right as it was. */
  fine: boolean;
}

/** The mark a sentence ends with. */
const ENDS = /[。．.！!？?]$/u;

/** Of the two sentences' words, at least this much kept: below it the correction is another sentence, not a marked one. */
const KEPT_LEAST = 0.4;
/** Longer sentences are not laid over each other: the comparison grows with the square of their words. */
const WORDS_MOST = 160;

/** `Intl.Segmenter`, which the project's ES2020 library does not declare; every Chromium the app runs in has it. */
type WordSegmenter = { segment(text: string): Iterable<{ segment: string }> };
const Segmenter = (Intl as unknown as { Segmenter?: new (locale?: string, options?: { granularity: 'word' }) => WordSegmenter }).Segmenter;

/** The words of a sentence, spaces and marks each their own, in the language given where one is. */
export function wordsOf(text: string, language?: string): string[] {
  // Without a segmenter: a run of letters is a word, and any other character one of its own (Han and kana among them).
  if (!Segmenter) return text.match(/[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}]|[\p{L}\p{N}]+|\s+|./gu) ?? [];
  let segmenter: WordSegmenter;
  try {
    segmenter = new Segmenter(language || undefined, { granularity: 'word' });
  } catch {
    segmenter = new Segmenter(undefined, { granularity: 'word' });
  }
  return Array.from(segmenter.segment(text), (s) => s.segment);
}

/** Two lists of words as the edit that turns the first into the second: what stays, what goes, what comes. */
function diff(a: readonly string[], b: readonly string[]): CorrectionPart[] {
  const n = a.length;
  const m = b.length;
  // The longest run the two have in common, from each point on.
  const keep: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) keep[i][j] = a[i] === b[j] ? keep[i + 1][j + 1] + 1 : Math.max(keep[i + 1][j], keep[i][j + 1]);
  }
  const out: CorrectionPart[] = [];
  const put = (text: string, kind: CorrectionPart['kind']) => {
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text;
    else out.push({ text, kind });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { put(a[i], 'same'); i++; j++; }
    else if (keep[i + 1][j] >= keep[i][j + 1]) put(a[i++], 'gone');
    else put(b[j++], 'added');
  }
  while (i < n) put(a[i++], 'gone');
  while (j < m) put(b[j++], 'added');
  return out;
}

/** A kept word too small to stand between two changes on its own — one letter or mark: drawn as part of the change. */
const LONE = /^\S$/u;

/** Changes that a lone kept word splits are joined, and a change's gone part comes before its added one. */
function tidy(parts: readonly CorrectionPart[]): CorrectionPart[] {
  const changed = (p: CorrectionPart | undefined) => p !== undefined && p.kind !== 'same';
  const out: CorrectionPart[] = [];
  for (let k = 0; k < parts.length; k++) {
    const p = parts[k];
    if (p.kind === 'same' && LONE.test(p.text) && changed(out[out.length - 1]) && changed(parts[k + 1])) {
      out.push({ text: p.text, kind: 'gone' }, { text: p.text, kind: 'added' });
      continue;
    }
    out.push({ ...p });
  }
  // One change: everything that goes, then everything that comes, so a word is struck before its correction.
  const merged: CorrectionPart[] = [];
  for (let k = 0; k < out.length; ) {
    if (out[k].kind === 'same') { merged.push(out[k]); k++; continue; }
    let gone = '';
    let added = '';
    while (k < out.length && out[k].kind !== 'same') {
      if (out[k].kind === 'gone') gone += out[k].text;
      else added += out[k].text;
      k++;
    }
    if (gone) merged.push({ text: gone, kind: 'gone' });
    if (added) merged.push({ text: added, kind: 'added' });
  }
  return merged;
}

/**
 * The feedback on `said` as a correction of it; null where it is not one to lay over the sentence — no corrected
 * sentence on its first line, one too far from what was said to mark, or sentences too long to compare.
 */
export function correctionOf(said: string, answer: string, language?: string): Correction | null {
  const sentence = said.trim();
  const lines = answer.split('\n').map((line) => line.trim()).filter(Boolean);
  if (!sentence || lines.length === 0) return null;
  const why = lines.slice(1).join(' ');
  if (lines[0] === '✓') return { parts: [{ text: sentence, kind: 'same' }], why, fine: true };
  // A corrected sentence that left off the mark the sentence ends with has not taken it away: it is given it back.
  const end = sentence.match(ENDS)?.[0];
  const corrected = end && !ENDS.test(lines[0]) ? lines[0] + end : lines[0];
  const a = wordsOf(sentence, language);
  const b = wordsOf(corrected, language);
  if (a.length > WORDS_MOST || b.length > WORDS_MOST) return null;
  const parts = diff(a, b);
  const kept = parts.filter((p) => p.kind === 'same').reduce((sum, p) => sum + p.text.replace(/\s/g, '').length, 0);
  const longer = Math.max(sentence.replace(/\s/g, '').length, corrected.replace(/\s/g, '').length);
  if (longer === 0 || kept / longer < KEPT_LEAST) return null;
  // Said and corrected alike: the feedback found nothing to change, whatever it wrote after.
  if (parts.every((p) => p.kind === 'same')) return { parts, why, fine: true };
  return { parts: tidy(parts), why, fine: false };
}

/** A language code's base: `ja-JP` and `ja` are one language. */
const baseOf = (language?: string): string => (language ?? '').toLowerCase().split(/[-_]/)[0];

/** The last corrections made, by what they were made of: a surface redraws many times over one sentence. */
const made = new Map<string, Correction | null>();
const MADE_MOST = 64;

/**
 * The correction to draw where `answer`, grammar feedback on `said` (the caller knows it is: `useCoached`), found
 * something to change; null where it found nothing (a tick is drawn as it is) or is not one to mark (`correctionOf`).
 */
export function fixOf(said: string, saidLanguage: string | undefined, answer: string): Correction | null {
  if (!said.trim() || !answer.trim()) return null;
  const key = `${baseOf(saidLanguage)}\u0000${said}\u0000${answer}`;
  if (!made.has(key)) {
    if (made.size >= MADE_MOST) made.delete(made.keys().next().value as string);
    const correction = correctionOf(said, answer, saidLanguage);
    made.set(key, correction && !correction.fine ? correction : null);
  }
  return made.get(key) ?? null;
}
