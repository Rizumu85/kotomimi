/**
 * Fork: the subtitle view's lanes — one for each side heard, each holding
 * that side's newest sentence and what answers it (its translation, or the
 * feedback on it).
 *
 * A caption strip is read at a glance, a few lines of it. The conversation
 * list, moved into such a strip, interleaves the two sides: the answer to
 * what the user said arrives a second later and by then sits above the fold,
 * under whatever the other side said since. And upstream's compact bands
 * flow each side's text as one line, where feedback reads "✓ ✓ ✓" with no
 * sentence to belong to. A lane changes only when its own side says the next
 * sentence, so each side's last sentence stays put, with its answer.
 *
 * The newest sentence is often still being said, and has no answer yet. A
 * pair's answer is then still the sentence before's — and its small line is
 * that sentence followed by everything said since, as one text whose end is
 * what is being heard now. The strip keeps that end in sight (a line too
 * long rolls), so the words appear as they are recognized; when the newest
 * is answered, the line begins again at it, under its own answer.
 *
 * (At first the small line held only the answered sentence, the pair "kept
 * whole" until the next was answered. With a stretch's sentences answered
 * one by one that hid the recognition altogether: nothing moved on the
 * screen while someone spoke, and it read as a slow recognizer — the user,
 * 2026-10-06.)
 *
 * A row is the user's own sentence: it shows the newest at once, so that
 * they see they were heard, and its answer when it comes. Pure.
 */
import type { LegName, SegmentId } from '../conversation/types';
import type { Entry, Row } from '../projection/types';
import { showsSide, type LegFilters, type NoticeEntry } from '../view/filter';

/** A stretch of a lane's text: a row of the conversation, with where it begins in its segment — what karaoke lights it by. */
export interface LanePiece {
  key: string;
  text: string;
  segmentId: SegmentId;
  start: number;
}

export interface LaneText {
  text: string;
  /** The same text, row by row: joined they are `text`. None for a notice's words, or nothing said. */
  pieces: LanePiece[];
  /** The language it is written in: what the provider detected, else the pair's. */
  language?: string;
  /** The first segment it is cut from, for a key that changes with the sentence. */
  segmentId?: SegmentId;
}

export interface Lane {
  leg: LegName;
  /**
   * How the lane is drawn. A pair: the sentence small, over its answer large — what the strip is read for. A row:
   * the sentence and its answer on one small line. The user's own lane is a row while the other side has a lane
   * too: most of the time the strip is read for what the other side says, and what answers the user's own sentence
   * (a tick, a correction) is taken in at a glance.
   */
  shape: 'pair' | 'row';
  /** What this side said last. Absent: the side's source is not shown. Empty text: nothing said yet. */
  source?: LaneText;
  /** What answers it. Absent: not shown. Empty text: nothing has answered yet. */
  answer?: LaneText & { notice?: NoticeEntry };
  /** A sentence newer than the one answered is waiting for its answer (a pair), or the one shown is (a row). */
  pending: boolean;
}

/** The other side first: theirs is what a caption strip is read for. */
const ORDER: readonly LegName[] = ['participant', 'speaker'];

/** Rows as the pieces of one text: joined as written, the whole's outer whitespace gone, rows left blank by that gone with it. */
function piecesOf(rows: readonly Row[]): LanePiece[] {
  const whole = rows.map((row) => row.text).join('');
  const from = whole.length - whole.trimStart().length;
  const to = whole.trimEnd().length;
  const pieces: LanePiece[] = [];
  let at = 0;
  for (const row of rows) {
    const start = Math.max(from, at);
    const end = Math.min(to, at + row.text.length);
    if (end > start) pieces.push({ key: row.key, text: row.text.slice(start - at, end - at), segmentId: row.segmentId, start: row.start + (start - at) });
    at += row.text.length;
  }
  return pieces;
}

const joined = (rows: readonly Row[]): string => rows.map((row) => row.text).join('').trim();

/** A pair's small line holds no more sentences than this: the one answered, and the newest said since. */
export const STREAM_MOST = 5;
/** Written without spaces between sentences (Han, kana, Hangul, full-width marks): nothing is put between two of them. */
const DENSE_END = /[\u2e80-\u9fff\uac00-\ud7af\uff00-\uffef]$/;

/** Sentences as one text, each after the other: a space between two where the first does not end in a script written without. */
function streamOf(sentences: ReadonlyArray<readonly Row[]>): { text: string; pieces: LanePiece[] } {
  const pieces: LanePiece[] = [];
  for (const rows of sentences) {
    const next = piecesOf(rows);
    if (next.length === 0) continue;
    const before = pieces[pieces.length - 1];
    if (before && !DENSE_END.test(before.text)) pieces[pieces.length - 1] = { ...before, text: `${before.text} ` };
    pieces.push(...next);
  }
  return { text: pieces.map((piece) => piece.text).join(''), pieces };
}

/**
 * The lanes of a run, for the legs it hears. A leg both of whose sides are
 * hidden has none; a leg with nothing said yet has an empty one, so the
 * strip is laid out from the start as it will be.
 */
export function buildLanes(
  entries: readonly Entry[],
  legs: readonly LegName[],
  filters: LegFilters,
  words: (notice: NoticeEntry) => string,
): Lane[] {
  const shown = ORDER.filter((leg) => legs.includes(leg) && (showsSide(filters[leg], 'source') || showsSide(filters[leg], 'translation')));
  return shown.map((leg): Lane => {
    const showsSource = showsSide(filters[leg], 'source');
    const showsAnswer = showsSide(filters[leg], 'translation');
    // Under the other side's lane, the user's own is a row.
    const shape = leg === 'speaker' && shown.length > 1 ? 'row' : 'pair';
    const mine = entries.filter((entry) => entry.leg === leg);
    const lane: Lane = { leg, shape, pending: false };
    if (showsSource) lane.source = { text: '', pieces: [] };
    if (showsAnswer) lane.answer = { text: '', pieces: [] };

    // The newest sentence of this side with anything written, and the newest that has been answered.
    const written = (i: number, side: 'source' | 'translation'): string => {
      const entry = mine[i];
      return entry?.kind === 'exchange' ? joined(entry[side]) : '';
    };
    let newest = -1;
    let answered = -1;
    for (let i = mine.length - 1; i >= 0 && (newest < 0 || answered < 0); i--) {
      if (newest < 0 && (written(i, 'source') || written(i, 'translation'))) newest = i;
      if (answered < 0 && written(i, 'translation')) answered = i;
    }
    // A notice after the newest sentence is what the side has to say now, where its answers are shown.
    const last = mine[mine.length - 1];
    const notice = last?.kind === 'notice' && mine.length - 1 > newest ? last : undefined;
    // Which sentence the lane shows: the newest — or, of a pair whose newest has no answer yet, the one before that has.
    const waits = newest >= 0 && answered !== newest && showsAnswer && !notice;
    const at = shape === 'pair' && waits && answered >= 0 ? answered : newest;
    // Said only of a side that has been answered before: a run that answers nothing (it only transcribes) has nothing on its way.
    lane.pending = waits && answered >= 0 && written(newest, 'source') !== '';
    const said = at >= 0 ? mine[at] : undefined;
    if (said?.kind === 'exchange') {
      if (lane.source) {
        const row = said.source[0];
        // A pair whose newest has no answer yet: the sentence shown, then all said since — or, before anything was
        // answered, the last few said. Its end is what is being heard now.
        const from = shape === 'pair' && waits ? Math.max(answered >= 0 ? answered : 0, newest - STREAM_MOST + 1) : at;
        const sentences = mine.slice(from, (shape === 'pair' && waits ? newest : at) + 1).flatMap((entry) => (entry.kind === 'exchange' ? [entry.source] : []));
        lane.source = { ...streamOf(sentences), language: row?.language || said.languages.source, ...(row ? { segmentId: row.segmentId } : {}) };
      }
      if (lane.answer && joined(said.translation)) {
        const row = said.translation[0];
        lane.answer = { text: joined(said.translation), pieces: piecesOf(said.translation), language: row?.language || said.languages.target, ...(row ? { segmentId: row.segmentId } : {}) };
      }
    }
    if (lane.answer && notice) lane.answer = { text: words(notice), pieces: [], notice };
    return lane;
  });
}

/** A pair's source is drawn at this much of the size chosen, and a row's text at this much. */
export const SOURCE_SCALE = 0.62;
export const ROW_SCALE = 0.62;

/**
 * How a strip is spaced. A strip is laid out roomy — a pair's answer has two
 * lines, and air around everything — and its window is fitted to that. A
 * window the user then makes smaller is paid for with the air first: the
 * spacing goes towards tight, where each text has one line at the size chosen
 * and the gaps are as small as still reads well. The window goes no smaller
 * than that. Text is one size throughout: a sentence too long for its lines
 * loses its oldest line (`SubtitleLanes`), and is never drawn smaller.
 *
 * A small line is 2.15 of its size high: what a line with readings written
 * above it (furigana) takes in the app's fonts, measured — at 1.9 such a line
 * came out four pixels taller than one without, and the text under it moved.
 * Tight, 1.9: the readings then reach a little into the line's own leading.
 */
export interface LaneSpacing {
  /** The strip's padding above and below, the space between two lanes (a hairline runs through the middle of it), and inside a pair between its two texts: pixels. */
  padTop: number;
  padBottom: number;
  gap: number;
  inner: number;
  /** The lines a pair's answer has room for, and a line's height in ems: the answer's, the source's (taller: readings are written above it), and a row's. */
  answerLines: number;
  answerLine: number;
  sourceLine: number;
  rowLine: number;
  /** What a small line has under it for its romanization, in ems of the small text: none, or `ROMAN_LINE`. */
  roman: number;
}

/** A line of romanization: its size (0.72 of the small text) by its line height (1.3), and a hair. */
export const ROMAN_LINE = 0.95;
/** A spacing whose small lines each have a line of romanization under them. */
export const withRoman = (spacing: LaneSpacing): LaneSpacing => ({ ...spacing, roman: ROMAN_LINE });

export const ROOMY: LaneSpacing = { padTop: 10, padBottom: 12, gap: 17, inner: 2, answerLines: 2, answerLine: 1.4, sourceLine: 2.15, rowLine: 2.15, roman: 0 };
export const TIGHT: LaneSpacing = { padTop: 4, padBottom: 5, gap: 7, inner: 0, answerLines: 1, answerLine: 1.22, sourceLine: 1.9, rowLine: 1.9, roman: 0 };

/** The spacing a share of the way from roomy (0) to tight (1). */
export function spacingAt(squeeze: number, roomy: LaneSpacing = ROOMY, tight: LaneSpacing = TIGHT): LaneSpacing {
  const t = Math.min(1, Math.max(0, squeeze));
  const mix = (key: keyof LaneSpacing) => roomy[key] + (tight[key] - roomy[key]) * t;
  return {
    padTop: mix('padTop'), padBottom: mix('padBottom'), gap: mix('gap'), inner: mix('inner'),
    answerLines: mix('answerLines'), answerLine: mix('answerLine'), sourceLine: mix('sourceLine'), rowLine: mix('rowLine'), roman: mix('roman'),
  };
}

/** The height one lane takes at a font size, spaced so: in ems of that size, for its share of the strip. */
export function laneEms(lane: Lane, spacing: LaneSpacing): number {
  if (lane.shape === 'row') return ROW_SCALE * (spacing.rowLine + spacing.roman);
  return (lane.source ? SOURCE_SCALE * (spacing.sourceLine + spacing.roman) : 0) + (lane.answer ? spacing.answerLine * spacing.answerLines : 0);
}

/** The height a strip of these lanes takes at a font size, spaced so. */
export function lanesHeight(lanes: readonly Lane[], fontSize: number, spacing: LaneSpacing = ROOMY): number {
  if (lanes.length === 0) return 0;
  let height = spacing.padTop + spacing.padBottom + spacing.gap * (lanes.length - 1);
  for (const lane of lanes) {
    height += fontSize * laneEms(lane, spacing);
    if (lane.shape === 'pair' && lane.source && lane.answer) height += spacing.inner;
  }
  return Math.ceil(height);
}

/** How far a strip of this height is from roomy towards tight: 0 at its roomy height or more, 1 at its tight height or less. */
export function squeezeOf(height: number, roomy: number, tight: number): number {
  if (!(roomy > tight) || height >= roomy) return 0;
  return Math.min(1, (roomy - height) / (roomy - tight));
}

/** How many lines each text of a strip has: what is longer loses its oldest line. */
export interface LaneLines { source: number; answer: number; row: number }

/** No text is given more lines than this, however high the window. */
const LINES_MOST: LaneLines = { source: 3, answer: 6, row: 3 };
/** Whose turn it is for the next line a higher window affords: the user's own row first — one line is the least it can do with — then the answer twice for the source's once. */
const LINES_ORDER: ReadonlyArray<keyof LaneLines> = ['row', 'answer', 'source', 'answer'];

/**
 * The lines a strip's texts have room for in a window `spare` pixels higher
 * than the strip is laid out for. A window the user made higher is for the
 * sentence on screen: a long one is written out on more lines at the size
 * chosen, where the fitted window would draw it smaller. (Showing the
 * sentences before in that room was tried, 2026-10-06; it is not what a
 * higher window is asked for.) Each further line is given in turn, while
 * there is room for it. Pure.
 */
export function linesFor(lanes: readonly Lane[], fontSize: number, spare: number, roomy: LaneSpacing = ROOMY): LaneLines {
  const lines: LaneLines = { source: 1, answer: roomy.answerLines, row: 1 };
  const pair = lanes.find((lane) => lane.shape === 'pair');
  const cost: LaneLines = {
    source: pair?.source ? fontSize * SOURCE_SCALE * (roomy.sourceLine + roomy.roman) : Infinity,
    answer: pair?.answer ? fontSize * roomy.answerLine : Infinity,
    row: lanes.some((lane) => lane.shape === 'row') ? fontSize * ROW_SCALE * (roomy.rowLine + roomy.roman) : Infinity,
  };
  let left = spare;
  for (let turn = 0, passed = 0; passed < LINES_ORDER.length; turn++) {
    const text = LINES_ORDER[turn % LINES_ORDER.length];
    // A hair of slack: heights added and taken away again do not come out exact.
    if (cost[text] <= left + 1e-6 && lines[text] < LINES_MOST[text]) {
      lines[text] += 1;
      left -= cost[text];
      passed = 0;
    } else {
      passed += 1;
    }
  }
  return lines;
}
