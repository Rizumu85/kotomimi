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
import type { SegmentPurpose } from '../contract/adapter';
import type { LegName, SegmentId } from '../conversation/types';
import type { Entry, Row } from '../projection/types';
import { showsSide, type LegFilters, type NoticeEntry } from '../view/filter';
import { answersItself, captionRows } from './dwell';

/** A stretch of a lane's text: a row of the conversation, with where it begins in its segment — what karaoke lights it by. */
export interface LanePiece {
  key: string;
  text: string;
  segmentId: SegmentId;
  start: number;
  /** Fork: its sentence is still being heard (the row is not final): its last word's reading waits (`useAnnotation`). */
  growing?: boolean;
  /** Fork: its sentence's language, in a text that runs on from one sentence to the next. Absent: the text's. */
  language?: string;
}

export interface LaneText {
  text: string;
  /** The same text, row by row: joined they are `text`. None for a notice's words, or nothing said. */
  pieces: LanePiece[];
  /** The language it is written in: what the provider detected, else the pair's. */
  language?: string;
  /** The first segment it is cut from, for a key that changes with the sentence. */
  segmentId?: SegmentId;
  purpose?: SegmentPurpose;
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
  /**
   * Fork: the sentence's further translations, each on a line of its own after `answer`: with a second language of
   * theirs lit, a sentence of the user's is answered in each of the run's languages. As many as the lane is laid out
   * for (`buildLanes`' `also`), written in or not: the frame holds still. In a row each is a box under the row's own,
   * with as many lines, so that a long one rolls by itself (in one box with the row, the last translation was all that
   * showed of a long sentence); in a pair they follow the answer in its box, which has a line more for each.
   */
  more?: LaneText[];
  /**
   * Feedback on one exchange, with its own source: the sentence it is on may no longer be the one the lane shows.
   * Fork: the one its clock holds (`fed`), else the shown sentence's own, else the newest of those before it: it
   * stays until the next has come (and, by the clock, been read). Feedback that came after the user had gone on was
   * never shown (the user, 2026-11-18: keep it).
   */
  feedback?: LaneText & { said: LaneText; origin: string };
  /** A sentence newer than the one answered is waiting for its answer (a pair), or the one shown is (a row). */
  pending: boolean;
  /** Fork: a row shows a sentence before the newest, its answer being read (`rowTurn`): what was said since waits its turn. */
  behind?: true;
  /**
   * Fork: `answer` is what was said, there being nothing to translate: a run in one language — `source` is then gone,
   * and the lane has the one text — or a sentence in the language of the answers (`answersItself`), where `source` is
   * what was said since.
   */
  said?: true;
  /**
   * Fork: the sentence the answer answers, alone — a pair's source line may run on into what was said since. What a
   * correction is laid over (`src/lib/feedback/correction.ts`).
   */
  answers?: string;
}

type Exchange = Extract<Entry, { kind: 'exchange' }>;

/** The other side first: theirs is what a caption strip is read for. */
const ORDER: readonly LegName[] = ['participant', 'speaker'];

/** The legs that have a lane, in order: heard, and with a side shown. */
const lanesOf = (legs: readonly LegName[], filters: LegFilters): LegName[] =>
  ORDER.filter((leg) => legs.includes(leg) && (showsSide(filters[leg], 'source') || showsSide(filters[leg], 'translation')));

/** Fork: the leg drawn as a row whose sentences are taken in turn (`rowTurn`): the user's, under the other side's, where what answers them is shown. */
export function rowLegOf(legs: readonly LegName[], filters: LegFilters): LegName | undefined {
  return lanesOf(legs, filters).length > 1 && showsSide(filters.speaker, 'translation') ? 'speaker' : undefined;
}

/** Rows as the pieces of one text: joined as written, the whole's outer whitespace gone, rows left blank by that gone with it. */
function piecesOf(rows: readonly Row[], language?: string): LanePiece[] {
  const whole = rows.map((row) => row.text).join('');
  const from = whole.length - whole.trimStart().length;
  const to = whole.trimEnd().length;
  const pieces: LanePiece[] = [];
  let at = 0;
  for (const row of rows) {
    const start = Math.max(from, at);
    const end = Math.min(to, at + row.text.length);
    if (end > start) pieces.push({ key: row.key, text: row.text.slice(start - at, end - at), segmentId: row.segmentId, start: row.start + (start - at), ...(row.final ? {} : { growing: true }), ...(row.language || language ? { language: row.language || language } : {}) });
    at += row.text.length;
  }
  return pieces;
}

const joined = (rows: readonly Row[]): string => rows.map((row) => row.text).join('').trim();

const baseOf = (language: string | undefined): string => (language ?? '').toLowerCase().split(/[-_]/)[0];

/**
 * Fork: a sentence's translations, each in its place among the run's languages — the speaker's own, the other side's
 * main one, any other, as the conversation lists them (`byLanguage`) — the one it was said in left out. A place is
 * the language's, whichever answer came first: a sentence said in their second language is answered in their main
 * one before it is in the speaker's own, and that answer does not move down a line when the other comes. `sparse`:
 * a place not answered yet is left empty; else the answers close up.
 */
function placed(said: Exchange, sparse: boolean): Row[][] {
  const [own, main] = [baseOf(said.languages.source), baseOf(said.languages.target)];
  const rank = (language: string) => (baseOf(language) === own ? 0 : baseOf(language) === main ? 1 : 2);
  const spoken = rank(said.source[0]?.language || said.languages.source);
  const answers: Array<{ rank: number; rows: Row[] }> = [];
  for (const row of said.translation) {
    const last = answers[answers.length - 1];
    if (last && last.rows[0].segmentId === row.segmentId) last.rows.push(row);
    else answers.push({ rank: rank(row.language || said.languages.target), rows: [row] });
  }
  // Array.prototype.sort is stable: two answers of one rank stay as they came.
  answers.sort((a, b) => a.rank - b.rank);
  if (!sparse) return answers.map((answer) => answer.rows);
  const places: Row[][] = [];
  for (const answer of answers) {
    let at = Math.max(0, answer.rank - (answer.rank > spoken ? 1 : 0));
    while (places[at]) at += 1;
    places[at] = answer.rows;
  }
  return Array.from(places, (rows) => rows ?? []);
}

/**
 * Fork: how many translations beyond the first the user's latest sentences have: what a strip that was not told the
 * run's languages keeps lines for, once seen (`SubtitleLanes`).
 */
export function furtherIn(entries: readonly Entry[]): number {
  let most = 0;
  for (let i = entries.length - 1, seen = 0; i >= 0 && seen < 3; i--) {
    const entry = entries[i];
    if (entry.kind !== 'exchange' || entry.leg !== 'speaker' || !joined(entry.translation)) continue;
    seen += 1;
    most = Math.max(most, new Set(entry.translation.map((row) => row.segmentId)).size - 1);
  }
  return most;
}

/**
 * Fork: the lanes with the feedback's line kept in the user's own, written in or not: under grammar feedback
 * (`coached`), where what answers the user is shown. The line came with a sentence's feedback and went with the next
 * sentence, and the window with it, a line up and a line down for every sentence said (seen 2026-11-18): the frame has
 * to hold still.
 */
export function withFeedbackRoom(lanes: readonly Lane[], coached: boolean): Lane[] {
  return lanes.map((lane) => (coached && lane.leg === 'speaker' && lane.answer && !lane.feedback
    ? { ...lane, feedback: { text: '', pieces: [], origin: '', said: { text: '', pieces: [] } } }
    : lane));
}

/** A pair's small line holds no more sentences than this: the one answered, and the newest said since. */
export const STREAM_MOST = 5;
/** Written without spaces between sentences (Han, kana, full-width marks): nothing is put between two of them. Hangul is written with them. */
const DENSE_END = /[\u2e80-\u9fff\uff00-\uffef]$/;

/** Sentences as one text, each after the other: a space between two where the first does not end in a script written without. */
function streamOf(sentences: readonly Exchange[]): { text: string; pieces: LanePiece[] } {
  const pieces: LanePiece[] = [];
  for (const sentence of sentences) {
    const next = piecesOf(sentence.source, sentence.languages.source);
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
  /**
   * Of a pair: the answered sentence it is to show for now, by its entry's id, where a newer one is to wait its turn
   * (`dwell.ts`). Fork: of a row, the sentence it is to show, answered or not (`rowTurn`). Absent: the newest.
   */
  held: Partial<Record<LegName, string>> = {},
  /** Fork: the translations a sentence of the user's has beyond the first (`Lane.more`): the other side's languages lit beside their main one. */
  also = 0,
  /** Fork: the sentence whose grammar feedback the user's lane shows, by its entry's id (`answerTurn`). Absent: see `Lane.feedback`. */
  fed?: string,
): Lane[] {
  const shown = lanesOf(legs, filters);
  return shown.map((leg): Lane => {
    const showsSource = showsSide(filters[leg], 'source');
    const showsAnswer = showsSide(filters[leg], 'translation');
    // Under the other side's lane, the user's own is a row.
    const shape = leg === 'speaker' && shown.length > 1 ? 'row' : 'pair';
    // Fork: of the notices, the strip says an error, and one that goes by itself (a new microphone, #481). A warning
    // that stays took the place of the last sentence's translation until the side spoke again, for something already
    // taken care of (the app's capture falling back to the whole system's sound; the user, 2026-10-28). The
    // conversation still lists every notice.
    const mine = entries.filter((entry) => entry.leg === leg && (entry.kind !== 'notice' || entry.severity === 'error' || entry.lifetime === 'transient'));
    const lane: Lane = { leg, shape, pending: false };
    if (showsSource) lane.source = { text: '', pieces: [] };
    if (showsAnswer) lane.answer = { text: '', pieces: [] };
    if (showsAnswer && leg === 'speaker' && also > 0) lane.more = Array.from({ length: also }, () => ({ text: '', pieces: [] }));

    // The newest sentence of this side with anything written, and the newest that has been answered.
    const written = (i: number, side: 'source' | 'answer'): string => {
      const entry = mine[i];
      return entry?.kind === 'exchange' ? joined(side === 'source' ? entry.source : captionRows(entry)) : '';
    };
    let newest = -1;
    let answered = -1;
    for (let i = mine.length - 1; i >= 0 && (newest < 0 || answered < 0); i--) {
      if (newest < 0 && (written(i, 'source') || written(i, 'answer'))) newest = i;
      if (answered < 0 && written(i, 'answer')) answered = i;
    }
    // A pair holds the answer it shows until that has been read: a newer one waits its turn.
    if (shape === 'pair' && held[leg] !== undefined) {
      const at = mine.findIndex((entry) => entry.id === held[leg]);
      if (at >= 0 && at < answered && written(at, 'answer')) answered = at;
    }
    // A notice after the newest sentence is what the side has to say now, where its answers are shown.
    const last = mine[mine.length - 1];
    const notice = last?.kind === 'notice' && mine.length - 1 > newest ? last : undefined;
    // Which sentence the lane shows: the newest — or, of a pair whose newest has no answer yet, the one before that has.
    const waits = newest >= 0 && answered !== newest && showsAnswer && !notice;
    // Fork: a row takes its sentences in turn: the one before the newest stays while its answer is read.
    const turn = shape === 'row' && showsAnswer && !notice && held[leg] !== undefined ? mine.findIndex((entry) => entry.id === held[leg]) : -1;
    const earlier = turn >= 0 && turn < newest && (written(turn, 'source') !== '' || written(turn, 'answer') !== '');
    const at = shape === 'pair' && waits && answered >= 0 ? answered : earlier ? turn : newest;
    // Said only of a side that has been answered before: a run that answers nothing (it only transcribes) has nothing on its way.
    // Fork: nor of a mishearing, which nothing will answer: it shows as heard, and is waited on for nothing.
    const newestSaid = mine[newest];
    const misheard = newestSaid?.kind === 'exchange' && newestSaid.source.length > 0 && newestSaid.source.every((row) => row.misheard);
    lane.pending = waits && answered >= 0 && written(newest, 'source') !== '' && !misheard;
    if (earlier) {
      // The sentence shown is its own matter: waited on while it has no answer, and what was said since is behind it.
      lane.pending = written(at, 'answer') === '';
      lane.behind = true;
    }
    const said = at >= 0 ? mine[at] : undefined;
    if (said?.kind === 'exchange') {
      // Fork: a sentence in the language of the answers is its own, and what was said since runs on over it.
      const own = showsAnswer && !notice && answersItself(said);
      // Fork: a run in one language translates nothing: what is said is what the strip is read for, whichever sides
      // are shown, at an answer's size.
      const oneLanguage = shape === 'pair' && !notice && !joined(said.translation) && said.languages.source.toLowerCase() === said.languages.target.toLowerCase();
      const runsOn = shape === 'pair' && waits;
      // A pair whose newest has no answer yet: the sentence shown, then all said since — or, before anything was
      // answered, the last few said. Its end is what is being heard now.
      const from = own ? at + 1 : runsOn ? Math.max(answered >= 0 ? answered : 0, newest - STREAM_MOST + 1) : at;
      const sentences = mine.slice(from, (runsOn ? newest : at) + 1).flatMap((entry) => (entry.kind === 'exchange' ? [entry] : []));
      const row = sentences[0]?.source[0];
      const heard: LaneText = { ...streamOf(sentences), language: row?.language || said.languages.source, ...(row ? { segmentId: row.segmentId } : {}) };
      if (lane.source) lane.source = heard;
      if (lane.source && lane.answer && joined(said.source)) lane.answers = joined(said.source);
      // Fork: with a second language of theirs lit, a sentence of the user's has a translation in each: the first
      // is the answer, the others the lines after it (`more`), each language in its place.
      const answers = placed(said, lane.more !== undefined);
      const textOf = (rows: readonly Row[]): LaneText => {
        const row = rows[0];
        return { text: joined(rows), pieces: piecesOf(rows), language: row?.language || said.languages.target, ...(row ? { segmentId: row.segmentId } : {}), ...(row?.purpose ? { purpose: row.purpose } : {}) };
      };
      const first = answers[0] ?? [];
      if (lane.answer && joined(first)) lane.answer = textOf(first);
      if (lane.more) lane.more = lane.more.map((empty, i) => (joined(answers[i + 1] ?? []) ? textOf(answers[i + 1]) : empty));
      if (own) {
        const first = said.source[0];
        lane.answer = { text: joined(said.source), pieces: piecesOf(said.source), language: first.language, segmentId: first.segmentId };
        lane.said = true;
      }
      if (oneLanguage && heard.text) {
        lane.answer = heard;
        lane.said = true;
        lane.pending = false;
        delete lane.source;
      }
    }
    if (lane.answer && notice) lane.answer = { text: words(notice), pieces: [], notice };
    if (showsAnswer) {
      // Of the sentence shown or one before it: feedback on a sentence still waiting its turn waits with it.
      const upTo = mine.slice(0, at + 1);
      const has = (entry: Entry | undefined): entry is Exchange => entry?.kind === 'exchange' && !!entry.feedback?.length && joined(entry.feedback) !== '';
      const held = fed === undefined ? undefined : upTo.find((entry) => entry.id === fed);
      const from = has(held) ? held : has(said) ? said : [...upTo].reverse().find(has);
      if (from) {
        const row = from.feedback![0];
        lane.feedback = {
          text: joined(from.feedback!), pieces: piecesOf(from.feedback!), language: row.language || from.languages.source,
          segmentId: row.segmentId, purpose: 'feedback', origin: from.id,
          said: { text: joined(from.source), pieces: piecesOf(from.source), language: from.source[0]?.language || from.languages.source },
        };
      }
    }
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
  /** The lines a pair's answer has room for, and a line's height in ems: the answer's (`READ_LINE` where readings are written above it), the source's (taller: they may be), and a row's. */
  answerLines: number;
  answerLine: number;
  sourceLine: number;
  rowLine: number;
  /**
   * Fork: the lines grammar feedback has. A correction is the sentence marked and its reason: on one line, three in
   * ten of a week's corrections showed the end of the reason alone (2026-11-27). Two hold nearly all of them; squeezed,
   * one, and the reason gives way first (`Slot`).
   */
  feedbackLines: number;
  /** What a pair's small line has under it for its romanization, in ems of the small text: none, or `ROMAN_LINE`. */
  roman: number;
  /** Fork: and the user's own row, apart: room kept under a line that has none showed half of the line before (2026-10-28). */
  rowRoman: number;
  /** Fork: what a line of the answer has under it for its romanization, in ems of the answer. */
  answerRoman: number;
}

/** A line of romanization: its size (0.72 of the small text) by its line height (1.3), and a hair. */
export const ROMAN_LINE = 0.95;
/** A spacing whose small lines each have a line of romanization under them: a pair's, and the row's where `row`. */
export const withRoman = (spacing: LaneSpacing, pair = true, row = pair): LaneSpacing => ({ ...spacing, roman: pair ? ROMAN_LINE : 0, rowRoman: row ? ROMAN_LINE : 0 });

/**
 * Fork: a small line with readings above it and a romanization under it keeps its roomy height however the strip is
 * squeezed (a pair's where `pair`, the row's where `row`). A tight line lends a reading its own leading, above and
 * below; with a romanization under it there is none below to lend, and a line of pinyin beside a Japanese answer with
 * both aids came out six pixels higher than its box: the tone marks were cut off (2026-11-18).
 */
export const withSmallReads = (spacing: LaneSpacing, pair: boolean, row: boolean): LaneSpacing => ({
  ...spacing,
  sourceLine: pair ? Math.max(spacing.sourceLine, ROOMY.sourceLine) : spacing.sourceLine,
  rowLine: row ? Math.max(spacing.rowLine, ROOMY.rowLine) : spacing.rowLine,
});

/**
 * A line of the answer with readings written above it: what they take in the app's fonts. Less, and the line comes out
 * higher than it is laid out for, and a rolled line lost the top of its pinyin, tone marks and all (seen 2026-10-31).
 */
export const READ_LINE = 2.12;
/**
 * Fork: a spacing whose answer's lines have readings above them, or a romanization under them. Laid out for a bare
 * line, a second line of Chinese lost the pinyin of its first, and a squeezed strip showed a Korean answer's
 * romanization and not the answer (2026-10-31).
 */
export const withAnswerAids = (spacing: LaneSpacing, reads: boolean, roman: boolean): LaneSpacing => ({ ...spacing, answerLine: reads ? READ_LINE : spacing.answerLine, answerRoman: roman ? ROMAN_LINE : 0 });

export const ROOMY: LaneSpacing = { padTop: 10, padBottom: 12, gap: 17, inner: 2, answerLines: 2, answerLine: 1.4, sourceLine: 2.15, rowLine: 2.15, feedbackLines: 2, roman: 0, rowRoman: 0, answerRoman: 0 };
export const TIGHT: LaneSpacing = { padTop: 4, padBottom: 5, gap: 7, inner: 0, answerLines: 1, answerLine: 1.22, sourceLine: 1.9, rowLine: 1.9, feedbackLines: 1, roman: 0, rowRoman: 0, answerRoman: 0 };

/** The spacing a share of the way from roomy (0) to tight (1). */
export function spacingAt(squeeze: number, roomy: LaneSpacing = ROOMY, tight: LaneSpacing = TIGHT): LaneSpacing {
  const t = Math.min(1, Math.max(0, squeeze));
  const mix = (key: keyof LaneSpacing) => roomy[key] + (tight[key] - roomy[key]) * t;
  return {
    padTop: mix('padTop'), padBottom: mix('padBottom'), gap: mix('gap'), inner: mix('inner'),
    answerLines: mix('answerLines'), answerLine: mix('answerLine'), sourceLine: mix('sourceLine'), rowLine: mix('rowLine'), feedbackLines: mix('feedbackLines'), roman: mix('roman'), rowRoman: mix('rowRoman'), answerRoman: mix('answerRoman'),
  };
}

/** The height one lane takes at a font size, spaced so: in ems of that size, for its share of the strip. */
export function laneEms(lane: Lane, spacing: LaneSpacing): number {
  const feedback = lane.feedback ? ROW_SCALE * spacing.rowLine * spacing.feedbackLines : 0;
  // Each further translation (`more`) has a line, however the strip is squeezed.
  const more = lane.more?.length ?? 0;
  if (lane.shape === 'row') return ROW_SCALE * (spacing.rowLine + spacing.rowRoman) * (1 + more) + feedback;
  return (lane.source ? SOURCE_SCALE * (spacing.sourceLine + spacing.roman) : 0) + (lane.answer ? (spacing.answerLine + spacing.answerRoman) * (spacing.answerLines + more) : 0) + feedback;
}

/** The height a strip of these lanes takes at a font size, spaced so. */
export function lanesHeight(lanes: readonly Lane[], fontSize: number, spacing: LaneSpacing = ROOMY): number {
  if (lanes.length === 0) return 0;
  let height = spacing.padTop + spacing.padBottom + spacing.gap * (lanes.length - 1);
  for (const lane of lanes) {
    height += fontSize * laneEms(lane, spacing);
    const texts = (lane.shape === 'row' ? 1 + (lane.more?.length ?? 0) : Number(!!lane.source) + Number(!!lane.answer)) + Number(!!lane.feedback);
    height += Math.max(0, texts - 1) * spacing.inner;
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
 * chosen, where the fitted window would roll its oldest away. (Showing the
 * sentences before in that room was tried, 2026-10-06; it is not what a
 * higher window is asked for.) Each further line is given in turn, while
 * there is room for it. Pure.
 */
export function linesFor(lanes: readonly Lane[], fontSize: number, spare: number, roomy: LaneSpacing = ROOMY): LaneLines {
  const pair = lanes.find((lane) => lane.shape === 'pair');
  // A pair's further translations are written in the answer's box: their lines are its from the start, and none of
  // the most it is given. A row's are boxes of their own, each with the row's lines: a further line is one for each.
  const more = { answer: pair?.more?.length ?? 0, row: 0, source: 0 };
  const rows = 1 + (lanes.find((lane) => lane.shape === 'row')?.more?.length ?? 0);
  const lines: LaneLines = { source: 1, answer: roomy.answerLines + more.answer, row: 1 };
  const cost: LaneLines = {
    source: pair?.source ? fontSize * SOURCE_SCALE * (roomy.sourceLine + roomy.roman) : Infinity,
    answer: pair?.answer ? fontSize * (roomy.answerLine + roomy.answerRoman) : Infinity,
    row: lanes.some((lane) => lane.shape === 'row') ? fontSize * ROW_SCALE * (roomy.rowLine + roomy.rowRoman) * rows : Infinity,
  };
  let left = spare;
  for (let turn = 0, passed = 0; passed < LINES_ORDER.length; turn++) {
    const text = LINES_ORDER[turn % LINES_ORDER.length];
    // A hair of slack: heights added and taken away again do not come out exact.
    if (cost[text] <= left + 1e-6 && lines[text] < LINES_MOST[text] + more[text]) {
      lines[text] += 1;
      left -= cost[text];
      passed = 0;
    } else {
      passed += 1;
    }
  }
  return lines;
}
