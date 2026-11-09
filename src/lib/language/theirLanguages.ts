/**
 * Fork: the other side's languages switched by hand ("对方说"): a row of them, their main one — the pair's target —
 * lit, and at most one more lit beside it (`MoreLanguages.lit`). The settings and the wrist panel press the same row,
 * through these.
 *
 * - Pressing one that is not lit lights it. Where two are lit already, the one lit first goes dark: the main one, and
 *   the other takes its place. Where what hears them takes one language only (`two` false), the press moves the light.
 * - Pressing the one lit beside the main one puts it out; pressing the main one hands the main to it. Pressing the
 *   only one lit does nothing: one stays lit.
 * - One added joins the row lit, as a press would light it; one taken out goes dark, the main to the other lit, or to
 *   the first left in the row.
 *
 * "Any language" (`AUTO`) can be lit beside the main one, never be it.
 */
import { AUTO } from '../provider/languages';

export interface TheirLanguages {
  /** The pair's target: lit. */
  main: string;
  /** Every language of theirs, the main one among them, in the order shown. */
  row: readonly string[];
  /** The one lit beside the main one; '' none. */
  lit: string;
  /** What hears them can be told two at once. */
  two: boolean;
}

export type TheirNext = Omit<TheirLanguages, 'two'>;

const base = (code: string) => code.trim().toLowerCase().split(/[-_]/)[0];
const same = (a: string, b: string) => a !== '' && b !== '' && base(a) === base(b);

/** Whether `code` is lit. */
export const isLit = (t: TheirLanguages, code: string): boolean => same(code, t.main) || same(code, t.lit);

/** The row after `code` is pressed; null where nothing changes. */
export function pressTheirs(t: TheirLanguages, code: string): TheirNext | null {
  const { main, row, lit } = t;
  if (same(code, main)) return lit && lit !== AUTO ? { main: lit, row, lit: '' } : null;
  if (same(code, lit)) return { main, row, lit: '' };
  if (!t.two) return code === AUTO ? null : { main: code, row, lit: '' };
  if (code === AUTO || !lit) return { main, row, lit: code };
  // Two lit already: the main one, lit first, goes dark. "Any language" beside it gives way instead.
  return lit === AUTO ? { main, row, lit: code } : { main: lit, row, lit: code };
}

/** The row with `code` added, and lit. */
export function addTheirs(t: TheirLanguages, code: string): TheirNext {
  const row = t.row.some((one) => same(one, code)) ? t.row : [...t.row, code];
  return pressTheirs({ ...t, row }, code) ?? { main: t.main, row, lit: t.lit };
}

/** The row with `code` taken out; null where it is the last that can be their main language. */
export function removeTheirs(t: TheirLanguages, code: string): TheirNext | null {
  const row = t.row.filter((one) => !same(one, code));
  if (same(code, t.lit)) return { main: t.main, row, lit: '' };
  if (!same(code, t.main)) return { main: t.main, row, lit: t.lit };
  const next = t.lit && t.lit !== AUTO ? t.lit : row.find((one) => one !== AUTO);
  if (!next) return null;
  return { main: next, row, lit: same(next, t.lit) ? '' : t.lit };
}

/**
 * Fork: the user's own row ("我说"), the same kind of row: their own language — the pair's source, which what the other
 * side says is translated into — filled, and the others they speak beside it, in use where the other side has them lit.
 * Pressing another makes it their own; "+" adds one, or takes one out, their own then passing to the next in the row.
 */
export interface MyLanguages {
  main: string;
  row: readonly string[];
}

export type MyNext = MyLanguages;

/** The row after `code` is pressed: it becomes the user's own; null where it is already. */
export function pressMine(t: MyLanguages, code: string): MyNext | null {
  return same(code, t.main) ? null : { main: code, row: t.row };
}

/** The row with `code` added beside the user's own. */
export function addMine(t: MyLanguages, code: string): MyNext {
  return { main: t.main, row: t.row.some((one) => same(one, code)) ? t.row : [...t.row, code] };
}

/** The row with `code` taken out; null where it is the only one. */
export function removeMine(t: MyLanguages, code: string): MyNext | null {
  const row = t.row.filter((one) => !same(one, code));
  if (row.length === 0) return null;
  return { main: same(code, t.main) ? row[0] : t.main, row };
}
