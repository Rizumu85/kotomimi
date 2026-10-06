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
 * The newest sentence is often still being said, and has no answer yet. The
 * reader of a translation would then have nothing to read from the moment
 * the other side opens their mouth, so the lane keeps the last answer there
 * is — marked stale, to be drawn dimmed — until the new one comes. Pure.
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
  /** What this side said last. Absent: the side's source is not shown. Empty text: nothing said yet. */
  source?: LaneText;
  /** What answers it. Absent: not shown. `stale`: it answers the sentence before, the newest having none yet. */
  answer?: LaneText & { stale: boolean; notice?: NoticeEntry };
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
  const lanes: Lane[] = [];
  for (const leg of ORDER) {
    if (!legs.includes(leg)) continue;
    const showsSource = showsSide(filters[leg], 'source');
    const showsAnswer = showsSide(filters[leg], 'translation');
    if (!showsSource && !showsAnswer) continue;
    const mine = entries.filter((entry) => entry.leg === leg);
    const lane: Lane = { leg };
    if (showsSource) lane.source = { text: '', pieces: [] };
    if (showsAnswer) lane.answer = { text: '', pieces: [], stale: false };

    // The newest sentence of this side with anything written.
    let newest = -1;
    for (let i = mine.length - 1; i >= 0 && newest < 0; i--) {
      const entry = mine[i];
      if (entry.kind === 'exchange' && (joined(entry.source) || joined(entry.translation))) newest = i;
    }
    const said = newest >= 0 ? mine[newest] : undefined;
    if (said?.kind === 'exchange' && lane.source) {
      const row = said.source[0];
      lane.source = { text: joined(said.source), pieces: piecesOf(said.source), language: row?.language || said.languages.source, ...(row ? { segmentId: row.segmentId } : {}) };
    }
    if (lane.answer) {
      // A notice after the newest sentence is what the side has to say now.
      const last = mine[mine.length - 1];
      if (last?.kind === 'notice' && mine.length - 1 > newest) {
        lane.answer = { text: words(last), pieces: [], stale: false, notice: last };
      } else {
        for (let i = newest; i >= 0; i--) {
          const entry = mine[i];
          if (entry.kind !== 'exchange') continue;
          const text = joined(entry.translation);
          if (!text) continue;
          const row = entry.translation[0];
          lane.answer = { text, pieces: piecesOf(entry.translation), stale: i !== newest, language: row?.language || entry.languages.target, ...(row ? { segmentId: row.segmentId } : {}) };
          break;
        }
      }
    }
    lanes.push(lane);
  }
  return lanes;
}

/** The source is drawn at this much of the size chosen. */
export const SOURCE_SCALE = 0.62;

/**
 * How a strip is spaced. A strip is laid out roomy — the answer has two
 * lines, and air around everything — and its window is fitted to that. A
 * window the user then makes smaller is paid for with the air first: the
 * spacing goes towards tight, where each text has one line at the size chosen
 * and the gaps are as small as still reads well. The window goes no smaller
 * than that; in between, a sentence too long for its box is drawn smaller.
 */
export interface LaneSpacing {
  /** The strip's padding above and below, the space between two lanes, and inside one between its two texts: pixels. */
  padTop: number;
  padBottom: number;
  gap: number;
  inner: number;
  /** The lines the answer has room for, and a line's height in ems: the answer's, and the source's (taller: readings are written above it). */
  answerLines: number;
  answerLine: number;
  sourceLine: number;
}

export const ROOMY: LaneSpacing = { padTop: 8, padBottom: 10, gap: 10, inner: 2, answerLines: 2, answerLine: 1.4, sourceLine: 1.9 };
export const TIGHT: LaneSpacing = { padTop: 4, padBottom: 5, gap: 4, inner: 0, answerLines: 1, answerLine: 1.22, sourceLine: 1.6 };

/** The spacing a share of the way from roomy (0) to tight (1). */
export function spacingAt(squeeze: number): LaneSpacing {
  const t = Math.min(1, Math.max(0, squeeze));
  const mix = (key: keyof LaneSpacing) => ROOMY[key] + (TIGHT[key] - ROOMY[key]) * t;
  return { padTop: mix('padTop'), padBottom: mix('padBottom'), gap: mix('gap'), inner: mix('inner'), answerLines: mix('answerLines'), answerLine: mix('answerLine'), sourceLine: mix('sourceLine') };
}

/** The height a strip of these lanes takes at a font size, spaced so. */
export function lanesHeight(lanes: readonly Lane[], fontSize: number, spacing: LaneSpacing = ROOMY): number {
  if (lanes.length === 0) return 0;
  let height = spacing.padTop + spacing.padBottom + spacing.gap * (lanes.length - 1);
  for (const lane of lanes) {
    if (lane.source) height += fontSize * SOURCE_SCALE * spacing.sourceLine;
    if (lane.answer) height += fontSize * spacing.answerLine * spacing.answerLines;
    if (lane.source && lane.answer) height += spacing.inner;
  }
  return Math.ceil(height);
}

/** How far a strip of this height is from roomy towards tight: 0 at its roomy height or more, 1 at its tight height or less. */
export function squeezeOf(height: number, roomy: number, tight: number): number {
  if (!(roomy > tight) || height >= roomy) return 0;
  return Math.min(1, (roomy - height) / (roomy - tight));
}
