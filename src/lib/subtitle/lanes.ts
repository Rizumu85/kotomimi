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
 * pair is read as one thing — a sentence and its translation — so it stays
 * whole: the sentence before, with its own answer, until the newest has one,
 * and then both change together (`pending` says a newer one is on its way).
 * Drawn the other way, the newest sentence over the last one's answer, the
 * two lines never belonged together while anyone was talking. A row is the
 * user's own sentence: it shows the newest at once, so that they see they
 * were heard, and its answer when it comes. Pure.
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
  /** A sentence newer than the one shown is waiting for its answer (a pair), or the one shown is (a row). */
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
        lane.source = { text: joined(said.source), pieces: piecesOf(said.source), language: row?.language || said.languages.source, ...(row ? { segmentId: row.segmentId } : {}) };
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
 * than that; in between, a sentence too long for its box is drawn smaller.
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
}

export const ROOMY: LaneSpacing = { padTop: 10, padBottom: 12, gap: 17, inner: 2, answerLines: 2, answerLine: 1.4, sourceLine: 1.9, rowLine: 1.9 };
export const TIGHT: LaneSpacing = { padTop: 4, padBottom: 5, gap: 7, inner: 0, answerLines: 1, answerLine: 1.22, sourceLine: 1.6, rowLine: 1.6 };

/** The spacing a share of the way from roomy (0) to tight (1). */
export function spacingAt(squeeze: number): LaneSpacing {
  const t = Math.min(1, Math.max(0, squeeze));
  const mix = (key: keyof LaneSpacing) => ROOMY[key] + (TIGHT[key] - ROOMY[key]) * t;
  return {
    padTop: mix('padTop'), padBottom: mix('padBottom'), gap: mix('gap'), inner: mix('inner'),
    answerLines: mix('answerLines'), answerLine: mix('answerLine'), sourceLine: mix('sourceLine'), rowLine: mix('rowLine'),
  };
}

/** The height one lane takes at a font size, spaced so: in ems of that size, for its share of the strip. */
export function laneEms(lane: Lane, spacing: LaneSpacing): number {
  if (lane.shape === 'row') return ROW_SCALE * spacing.rowLine;
  return (lane.source ? SOURCE_SCALE * spacing.sourceLine : 0) + (lane.answer ? spacing.answerLine * spacing.answerLines : 0);
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
