import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { ArrowRight, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { LegName, SegmentId } from '../../lib/conversation/types';
import type { Entry } from '../../lib/projection/types';
import { fontLanguage } from '../../lib/fonts/fontCss';
import { romanStretches } from '../../lib/annotate/annotate';
import { japaneseTokenizer, subscribeJapanese } from '../../lib/annotate/japaneseStore';
import { annotatedLanguage, isChinese, romanizedText } from '../../lib/annotate/script';
import type { JapaneseTokenizer } from '../../lib/annotate/types';
import { answeredOf, answerTurn, fedOf, holdMs, nextShown, rowSentences, rowTurn, type RowShown, type TurnShown } from '../../lib/subtitle/dwell';
import { buildLanes, furtherIn, lanesHeight, linesFor, rowLegOf, ROOMY, ROW_SCALE, spacingAt, squeezeOf, TIGHT, withAnswerAids, withFeedbackRoom, withRoman, withSmallReads, type Lane, type LanePiece, type LaneSpacing, type LaneText } from '../../lib/subtitle/lanes';
import { useAnnotationStore } from '../../stores/annotationStore';
import type { LegFilters } from '../../lib/view/filter';
import type { Beside } from '../../lib/subtitle/session';
import { noticeText } from '../../lib/view/noticeText';
import { AnnotatedLines, useAnnotation } from '../Annotated/AnnotatedText';
import { Correction } from '../Feedback/Correction';
import { useCoached } from '../Feedback/useCoached';
import { fixOf } from '../../lib/feedback/correction';
import { observeSize } from './surfaces/childDocument';
import '../../styles/karaoke.scss';
import { useSubtitleCaptureLanes } from './captureLaneState';

/**
 * Where the lines of a rolled text begin to show whole: pixels down from its top. Its lines are not of one height —
 * one with a romanization under it is half as high again — so the box's edge falls through a line, not between two:
 * over a line without one it left the romanization of the line before, alone (seen 2026-10-31). The lowest line stays,
 * whatever it takes.
 */
function wholeLinesFrom(box: HTMLElement, text: HTMLElement, line: number): number {
  const range = text.ownerDocument.createRange();
  range.selectNodeContents(text);
  const runs = Array.from(range.getClientRects()).sort((a, b) => a.top - b.top);
  // A stretch and its romanization go together, as the block they are.
  const blocks = Array.from(text.querySelectorAll('.annot-line--roman')).map((block) => block.getBoundingClientRect());
  const { top, bottom } = box.getBoundingClientRect();
  let edge = top;
  for (const rect of [...runs, ...blocks].sort((a, b) => a.top - b.top)) {
    // A reading over the top line reaches past the box by a pixel or two, and stays.
    const cut = edge - rect.top > Math.min(rect.height / 2, line / 4);
    if (cut && rect.bottom > edge && rect.bottom < bottom - line / 2) edge = rect.bottom;
  }
  // Down to the first run that shows, or a little past the edge where that begins over it (a font's box is taller than
  // a tight line): the feet of the line before reach a little past their own box.
  const first = runs.find((rect) => (rect.top + rect.bottom) / 2 > edge);
  // A reading that begins at the edge has no feet above it to hide, and those two pixels were its tone marks.
  const reads = Array.from(text.querySelectorAll('rt')).some((rt) => { const box = rt.getBoundingClientRect(); return box.top <= edge && box.bottom > edge + 2; });
  const from = first && first.top - 1 >= edge ? first.top - 1 : reads ? edge : edge + 2;
  return Math.max(0, from - text.getBoundingClientRect().top);
}

/**
 * Fork: whether a text's last line has no romanization under it: none of its romanized stretches ends on that line
 * (`foot`: where the text ends; `line`: a line's height; all in pixels down the page). Where a line of romanization is
 * kept under a small line, such a text stands above that line, as one that has a romanization does (`data-bare`, the
 * stylesheet): on the box's foot, the user's own sentence went up a line when its answer came with a romanization,
 * and a Japanese sentence stood a line lower than the Korean one before it (2026-11-18).
 */
export function lastLineBare(foot: number, line: number, romanBottoms: readonly number[]): boolean {
  return !romanBottoms.some((bottom) => bottom > foot - line / 2);
}

/**
 * Text in a box of fixed height, at the size chosen — always. A caption is
 * read while it changes, out of the corner of an eye: the frame has to hold
 * still, and only the words move. So nothing here is ever drawn smaller to
 * make it fit. (It was, at first: over 56 seconds of two people talking the
 * other side's sentence changed size eleven times, between 17 and 11 pixels,
 * and the lanes moved nine — the user, 2026-10-06: "the size goes up and
 * down and the structure keeps changing".) What is too long for its box
 * loses its oldest line, a whole line at a time: the stylesheet holds the
 * text's end in sight where this says it is over (`data-over`), and what the
 * box's edge would cut is not drawn (`wholeLinesFrom`).
 *
 * Fork: the user's own row gives up the sentence before it gives up any of the answer (`data-tight`): a row is the
 * sentence, an arrow and its translation on the lines it has, and rolled as one text a long one showed the last
 * words of the translation and nothing else (a narrow window, or a sentence of some sixty characters; 2026-11-18).
 * What the user said they know; what was made of it is what the row is read for. Only what is still too long then
 * loses its oldest line.
 */
function Slot({ className, lang, children, fitKey }: { className: string; lang?: string; children: ReactNode; fitKey: string }) {
  const box = useRef<HTMLDivElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const measure = () => {
    const outer = box.current;
    const inner = text.current;
    if (!outer || !inner) return;
    // Over by a line, not by the pixels a reading above a word can add to one: by half a line it was left to the box's
    // edge, and two plain lines in the room of one and its romanization showed half of the first. No layout (a test's
    // document): as written.
    const line = parseFloat(getComputedStyle(inner).lineHeight) || 0;
    const { paddingTop, paddingBottom } = getComputedStyle(outer);
    const room = outer.clientHeight - (parseFloat(paddingTop) || 0) - (parseFloat(paddingBottom) || 0);
    const tooLong = () => {
      // Said first: it changes where the text stands, which is what is measured next. No layout: left as it is.
      if (outer.clientHeight > 0) {
        const foot = inner.getBoundingClientRect().bottom - (parseFloat(getComputedStyle(inner).paddingBottom) || 0);
        const bare = !!inner.textContent && lastLineBare(foot, line, Array.from(inner.querySelectorAll('.annot-line--roman'), (block) => (block as HTMLElement).offsetParent === null ? -Infinity : block.getBoundingClientRect().bottom));
        if (bare) inner.dataset.bare = '';
        else delete inner.dataset.bare;
      }
      return outer.clientHeight > 0 && inner.scrollHeight > room + Math.max(1, line / 4);
    };
    // Measured whole each time: what was tight may fit again.
    delete outer.dataset.tight;
    let over = tooLong();
    if (over && inner.querySelector('.subtitle-lane__said:not(.subtitle-lane__said--fixed)') && inner.querySelector('.subtitle-lane__reply')) {
      outer.dataset.tight = '';
      over = tooLong();
    }
    if (over) outer.dataset.over = '';
    else delete outer.dataset.over;
    inner.style.clipPath = over ? `inset(${wholeLinesFrom(outer, inner, line)}px -1em -1em)` : '';
  };
  // What is written changed, or the lines it has.
  useLayoutEffect(measure, [fitKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // The window was resized, or the text changed height with nothing new to read: its readings have come (the dictionary), or its font.
  useEffect(() => {
    if (!box.current || !text.current) return undefined;
    const stopBox = observeSize(box.current, measure);
    const stopText = observeSize(text.current, measure);
    return () => { stopBox(); stopText(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div ref={box} className={className}>
      <div ref={text} className="subtitle-lane__text" data-kt-text="" lang={lang}>{children}</div>
    </div>
  );
}

/**
 * A row of a lane's text: with its reading aids, where its language has any, and lit as far as its clip has played
 * (a provider that speaks; the aids' text is lit whole, once it has all been spoken).
 */
function Stretch({ piece, language, upTo, readingsOnly = false }: { piece: LanePiece; language?: string; upTo: number | undefined; readingsOnly?: boolean }) {
  const annotated = useAnnotation(piece.text, language, readingsOnly ? 'readings' : undefined, piece.growing === true);
  const played = upTo === undefined ? 0 : Math.min(piece.text.length, Math.max(0, upTo - piece.start));
  if (annotated) return <AnnotatedLines lines={annotated} inline className={played > 0 && played >= piece.text.length ? 'karaoke-played' : undefined} />;
  if (played <= 0) return <span>{piece.text}</span>;
  if (played >= piece.text.length) return <span className="karaoke-played">{piece.text}</span>;
  return (
    <>
      <span className="karaoke-played">{piece.text.slice(0, played)}</span>
      <span>{piece.text.slice(played)}</span>
    </>
  );
}

/** A piece as the stretches a romanization is written under, each lit from where it begins; the last is what is still being heard. */
function stretchesOf(piece: LanePiece, language: string | undefined, japanese: JapaneseTokenizer | undefined): LanePiece[] {
  const stretches = romanStretches(piece.text, { language: annotatedLanguage(language), chinese: isChinese(language), japanese });
  let at = 0;
  return stretches.map((text, i) => {
    const stretch: LanePiece = { key: `${piece.key}:${at}`, text, segmentId: piece.segmentId, start: piece.start + at, ...(piece.growing && i === stretches.length - 1 ? { growing: true } : {}) };
    at += text.length;
    return stretch;
  });
}

/**
 * A lane's text, row by row; a notice's words as they are. Each piece is read in its own language: a pair's small
 * line runs on from one sentence to the next, and a side left to be detected may change language between them. Where
 * a romanization is written under the text, stretch by stretch (`romanStretches`). `readingsOnly`: none under it,
 * whatever the switch (the user's own row under grammar feedback: `rowRoman`).
 */
function Written({ text, lit, readingsOnly = false }: { text: LaneText; lit: ReadonlyMap<SegmentId, number>; readingsOnly?: boolean }) {
  const romanization = useAnnotationStore((s) => s.romanization);
  const romanOff = useAnnotationStore((s) => s.romanizationOff);
  const japanese = useSyncExternalStore(subscribeJapanese, japaneseTokenizer, japaneseTokenizer);
  if (text.pieces.length === 0) return <>{text.text}</>;
  return <>{text.pieces.map((piece) => {
    const language = piece.language ?? text.language;
    const stretches = !readingsOnly && romanization && romanizedText(piece.text, language, romanOff) ? stretchesOf(piece, language, japanese) : [piece];
    const drawn = stretches.map((stretch) => <Stretch key={stretch.key} piece={stretch} language={language} upTo={lit.get(stretch.segmentId)} readingsOnly={readingsOnly} />);
    // The font and the glyphs of a language are the box's (`Slot`): a sentence in another marks its own.
    return language === text.language ? drawn : <span key={piece.key} lang={fontLanguage(language) || undefined} data-kt-text="">{drawn}</span>;
  })}</>;
}

const langOf = (text: LaneText): string | undefined => fontLanguage(text.language) || undefined;

const LEGS: readonly LegName[] = ['participant', 'speaker'];

/**
 * Whether a kind of line has room for a reading aid: `on` is the switch; `asked`, what is on screen has the aid. Kept
 * once asked for: a side left to be detected changes language from sentence to sentence, and the window with it.
 * `planned`: the run's languages say it will be asked for (`plannedRoom`), and the room is there from the start, so
 * that the window is not made higher at the first word. For as long as they say so, not only until something is
 * said: the user's own row lost its line between their first word and its answer, which is what has the aid, and the
 * window went a line down and up.
 */
function useRoom(on: boolean, asked: boolean, planned = false): boolean {
  const kept = useRef(false);
  kept.current = on && (kept.current || asked);
  return kept.current || (on && planned);
}

/** The reading aids' switches. */
export interface ReadingAids { romanization: boolean; romanOff: readonly string[]; furigana: boolean; pinyin: boolean; jyutping?: boolean }

/** Whether a language has its readings drawn above it: kana over kanji, pinyin over Chinese, Jyutping over Cantonese. */
const readsAbove = (code: string | undefined, aids: Pick<ReadingAids, 'furigana' | 'pinyin' | 'jyutping'>): boolean => {
  const read = annotatedLanguage(code);
  return read === 'zh' ? aids.pinyin : read === 'yue' ? !!aids.jyutping : read === 'ja' && aids.furigana;
};
/** The run's two languages: what the user speaks, and what the other side does. */
export interface LanePair { source: string; target: string }

/**
 * The aids a strip will need before anything is said, from what the run's languages say will be: the other side speaks
 * the target, or the language of theirs lit beside it, and is answered in the source; the user speaks the source, or
 * another of their own in use, and is answered in each of the other side's — and in their own, where they spoke
 * another (`beside`). Only for the texts a lane shows. Without them the window was made higher at the first answer
 * with readings, and again at the first one in a second language: it has to hold still. A side left to be detected
 * may turn out to need the romanization.
 */
function plannedRoom(lanes: readonly Lane[], aids: ReadingAids, pair: LanePair | undefined, beside?: Beside) {
  const mine = [pair?.source, ...(beside?.mine ?? [])];
  const theirs = [pair?.target, ...(beside?.theirs ?? [])];
  const written = (lane: Lane, side: 'source' | 'answer'): ReadonlyArray<string | undefined> => {
    if (lane.leg === 'participant') return side === 'source' ? theirs : [pair?.source];
    return side === 'source' ? mine : [...theirs, ...(mine.length > 1 ? [pair?.source] : [])];
  };
  const known = (code: string | undefined) => !!code && code !== 'auto';
  const roman = (code: string | undefined) => aids.romanization && (!known(code) || romanizedText('', code, aids.romanOff));
  const reads = (code: string | undefined) => readsAbove(code, aids);
  const pairs = lanes.filter((lane) => lane.shape === 'pair');
  const oneLanguage = pair?.source.toLowerCase() === pair?.target.toLowerCase();
  return {
    pairRoman: pairs.some((lane) => lane.source && written(lane, 'source').some(roman)),
    rowRoman: lanes.some((lane) => lane.shape === 'row' && ((!!lane.source && written(lane, 'source').some(roman)) || (!!lane.answer && written(lane, 'answer').some(roman)))),
    answerReads: pairs.some((lane) => lane.answer && written(lane, 'answer').some(reads)),
    answerRoman: pairs.some((lane) => !!lane.answer && written(lane, 'answer').some((code) => known(code) && roman(code) && !(oneLanguage && reads(code)))),
  };
}

/**
 * The height the lanes of these legs take before anything is said, and the least they can be squeezed into: what a
 * strip with no run on is held at, so that its frame is the size of the strip to come — "set the window's place and
 * size before you start" was not true of a window that took a height of its own the moment it started, and whose
 * frame could meanwhile be pressed flat (the user, 2026-10-06). Null: no lanes.
 */
export function restingHeights(legs: readonly LegName[], filters: LegFilters, fontSize: number, aids: ReadingAids, pair?: LanePair, also = 0, beside?: Beside, coached = false): { height: number; least: number } | null {
  const lanes = withFeedbackRoom(buildLanes([], legs, filters, () => '', {}, also), coached);
  if (lanes.length === 0) return null;
  const planned = plannedRoom(lanes, aids, pair, beside);
  const readings = aids.furigana || aids.pinyin || !!aids.jyutping;
  const aided = (spacing: LaneSpacing) => withAnswerAids(withSmallReads(withRoman(spacing, planned.pairRoman, planned.rowRoman), readings && planned.pairRoman, readings && planned.rowRoman), planned.answerReads, planned.answerRoman);
  return { height: lanesHeight(lanes, fontSize, aided(ROOMY)) + addedBefore(), least: lanesHeight(lanes, fontSize, aided(TIGHT)) };
}

/**
 * Which answered sentence each side's pair shows, by its entry: the newest — once the one before it has been on
 * the screen long enough to be read (`dwell.ts`). The clock is kept here; what is shown by it is `buildLanes`'.
 * Fork: and which sentence the user's own row shows (`row`, `rowTurn`): its sentences in turn, each until read.
 */
function useHeld(entries: readonly Entry[], enabled = true, row?: LegName): Partial<Record<LegName, string>> {
  const shown = useRef<Partial<Record<LegName, { id: string; since: number }>>>({});
  const rowShown = useRef<RowShown | undefined>(undefined);
  const [held, setHeld] = useState<Partial<Record<LegName, string>>>({});
  const [turn, setTurn] = useState(0);
  // Before the frame is drawn: decided a frame late, a row showed the sentence it had just left for one more frame,
  // with the mark of something waiting behind it.
  useLayoutEffect(() => {
    if (!enabled) return;
    const now = Date.now();
    let soonest = Infinity;
    const next: Partial<Record<LegName, string>> = {};
    if (!row) rowShown.current = undefined;
    for (const leg of LEGS) {
      if (leg === row) {
        // The clock it had as a pair is not kept: back as a pair, it would bring an answer long read up again.
        delete shown.current[leg];
        const took = rowTurn(rowSentences(entries, leg), rowShown.current, now);
        rowShown.current = took.shown;
        soonest = Math.min(soonest, took.due);
        if (took.shown) next[leg] = took.shown.id;
        continue;
      }
      const answered = answeredOf(entries, leg);
      const last = answered.length - 1;
      if (last < 0) { delete shown.current[leg]; continue; }
      let at = answered.findIndex((answer) => answer.id === shown.current[leg]?.id);
      // Nothing shown yet, or what was shown is gone (the conversation was cleared): the newest, at once.
      if (at < 0) { at = last; shown.current[leg] = { id: answered[last].id, since: now }; }
      while (at < last) {
        const due = shown.current[leg]!.since + holdMs(answered[at].text, answered[at].language, last - at);
        if (due > now) { soonest = Math.min(soonest, due); break; }
        at = nextShown(at, last);
        shown.current[leg] = { id: answered[at].id, since: now };
      }
      next[leg] = answered[at].id;
    }
    setHeld((before) => (LEGS.every((leg) => before[leg] === next[leg]) ? before : next));
    if (soonest === Infinity) return undefined;
    const timer = setTimeout(() => setTurn((n) => n + 1), Math.max(0, soonest - now) + 10);
    return () => clearTimeout(timer);
  }, [entries, turn, enabled, row]);
  return held;
}

/** Fork: whose grammar feedback the user's lane shows: the newest, once the one before it has been read (`answerTurn`). */
function useFed(entries: readonly Entry[], enabled: boolean): string | undefined {
  const shown = useRef<TurnShown | undefined>(undefined);
  const [fed, setFed] = useState<string | undefined>(undefined);
  const [turn, setTurn] = useState(0);
  useLayoutEffect(() => {
    if (!enabled) return undefined;
    const now = Date.now();
    const took = answerTurn(fedOf(entries, 'speaker'), shown.current, now);
    shown.current = took.shown;
    setFed(took.shown?.id);
    if (took.due === Infinity) return undefined;
    const timer = setTimeout(() => setTurn((n) => n + 1), Math.max(0, took.due - now) + 10);
    return () => clearTimeout(timer);
  }, [entries, turn, enabled]);
  return fed;
}

/**
 * The height the user gave the strip over what its lanes are laid out for, kept on this computer: the room the
 * earlier sentences show in. A window made higher stays so the next time the view opens.
 */
const ADDED_KEY = 'kotomimi.subtitle.addedHeight';
const ADDED_MOST = 2000;
const ADDED_SLACK = 3;
const ADDED_LEAST = 8;
const KEEP_AFTER_MS = 800;
function addedBefore(): number {
  try {
    const kept = Number(window.localStorage.getItem(ADDED_KEY));
    return Number.isFinite(kept) && kept > 0 ? Math.min(kept, ADDED_MOST) : 0;
  } catch {
    return 0;
  }
}
function keepAdded(added: number): void {
  try {
    window.localStorage.setItem(ADDED_KEY, String(Math.round(added)));
  } catch {
    // Not kept: the window opens fitted next time.
  }
}

export interface SubtitleLanesProps {
  /** The run's languages: the room for reading aids is laid out from them before anything is said. */
  pair?: LanePair;
  entries: readonly Entry[];
  /** Characters spoken so far, per segment. */
  lit: ReadonlyMap<SegmentId, number>;
  /** The legs this run hears: each has its lane from the start, said in or not. */
  legs: readonly LegName[];
  filters: LegFilters;
  fontSize: number;
  /**
   * Told the height the lanes are laid out for, and the least they can be
   * squeezed into, whenever either changes — the size chosen, or which lanes
   * there are — so the window can be fitted to the one and held above the other.
   */
  onHeight?(height: number, least: number): void;
  /** A captured dwell choice for deterministic development replay. */
  held?: Partial<Record<LegName, string>>;
  /**
   * Fork: the translations a sentence of the user's has beyond the first — the other side's languages lit beside their
   * main one — where the host knows the run's languages: the strip has their lines from the start. Else it has them
   * from the first such sentence on.
   */
  also?: number;
  /** Fork: the languages each side may speak beside the pair's (`SubtitleSession.beside`): the room for their reading aids is laid out with the pair's. */
  beside?: Beside;
}

/**
 * Fork: the subtitle view (`src/lib/subtitle/lanes.ts`) — the other side's
 * newest sentence and its translation, and under it the user's own with what
 * answers it. Each text keeps its place, its size and its number of lines;
 * what does not fit loses its oldest line (`Slot`).
 */
export function SubtitleLanes({ entries, lit, legs, filters, fontSize, onHeight, pair, held: replayHeld, also: told = 0, beside }: SubtitleLanesProps) {
  const { t } = useTranslation();
  const coached = useCoached();
  const liveHeld = useHeld(entries, replayHeld === undefined, rowLegOf(legs, filters));
  const held = replayHeld ?? liveHeld;
  const fed = useFed(entries, coached && replayHeld === undefined);
  // Lines once given to a second translation stay: a strip that had them for one sentence and not the next would
  // change height between the two.
  const seen = useRef({ told, most: 0 });
  if (seen.current.told !== told) seen.current = { told, most: 0 };
  seen.current.most = Math.max(seen.current.most, furtherIn(entries));
  const also = Math.max(told, seen.current.most);
  const lanes = useMemo(() => withFeedbackRoom(buildLanes(entries, legs, filters, (notice) => noticeText(t, notice), held, also, fed), coached), [entries, legs, filters, t, held, also, coached, fed]);
  // The layout the window is fitted to: the size chosen and which texts there are, not what they say.
  const shape = lanes.map((lane) => `${lane.leg}:${lane.source ? 's' : ''}${lane.answer ? 'a' : ''}${lane.more?.length ?? ''}${lane.feedback ? 'f' : ''}`).join(',');
  // A romanization under the small lines has a line of its own there: while the switch is on and what is said is
  // in a language that has one — or the run's languages say one will be, so that the window is not made higher at the first word.
  const romanization = useAnnotationStore((s) => s.romanization);
  const romanOff = useAnnotationStore((s) => s.romanizationOff);
  const furigana = useAnnotationStore((s) => s.furigana);
  const pinyin = useAnnotationStore((s) => s.pinyin);
  const jyutping = useAnnotationStore((s) => s.jyutping);
  // Fork: under grammar feedback the user's own row has none: the correction drawn there has no room for one, and a
  // row that had one only while no correction stood in it would change the window's height from sentence to sentence.
  const rowRoman = !coached;
  // Each kind of line for itself: a pair's small line, and the user's own row. (Not for Chinese: its pinyin is above
  // the line, and room kept under it showed half of the line before, 2026-10-28.)
  const romanized = (text: LaneText | undefined) => !!text?.pieces.some((piece) => romanizedText(piece.text, piece.language ?? text.language, romanOff));
  const pairTexts = lanes.filter((lane) => lane.shape === 'pair').map((lane) => lane.source);
  const rowTexts = lanes.filter((lane) => lane.shape === 'row').flatMap((lane) => [lane.source, lane.answer, ...(lane.more ?? [])]);
  const planned = plannedRoom(lanes, { romanization, romanOff, furigana, pinyin, jyutping }, pair, beside);
  const pairRoman = useRoom(romanization, pairTexts.some(romanized), planned.pairRoman);
  const rowNeeds = useRoom(romanization && rowRoman, rowTexts.some(romanized), planned.rowRoman);
  // And the answer's own: its readings go above it, on taller lines, and its romanization under it. What was said gives
  // the romanization up to the readings, where it has any: at its size, both are more than a line can carry.
  const reads = (text: LaneText | undefined) => readsAbove(text?.language, { furigana, pinyin, jyutping });
  const answering = lanes.filter((lane) => lane.shape === 'pair');
  const answerReads = useRoom(furigana || pinyin || jyutping, answering.some((lane) => reads(lane.answer) || lane.more?.some(reads)), planned.answerReads);
  const answerRoman = useRoom(romanization, answering.some((lane) => (romanized(lane.answer) && !(lane.said && reads(lane.answer))) || lane.more?.some(romanized)), planned.answerRoman);
  const roman = `${pairRoman}:${rowNeeds}:${answerReads}:${answerRoman}:${furigana || pinyin || jyutping}`;
  const readings = furigana || pinyin || jyutping;
  const aided = (spacing: LaneSpacing) => withAnswerAids(withSmallReads(withRoman(spacing, pairRoman, rowNeeds), readings && pairRoman, readings && rowNeeds), answerReads, answerRoman);
  const [roomySpacing, tightSpacing] = [aided(ROOMY), aided(TIGHT)];
  const [roomy, least] = useMemo(() => [lanesHeight(lanes, fontSize, roomySpacing), lanesHeight(lanes, fontSize, tightSpacing)], [shape, fontSize, roman]); // eslint-disable-line react-hooks/exhaustive-deps
  const strip = useRef<HTMLDivElement>(null);
  useSubtitleCaptureLanes(strip, entries, held);
  // The window is fitted to the lanes. A window the user made higher than that keeps what they added — the room a
  // long sentence is written out in — through a change of size or of lanes, and for the next time the view opens.
  const fitted = useRef(0);
  /** What was last asked for over the fitted height: a window comes out a pixel or two off what it was asked (the screen's scale). */
  const asked = useRef(0);
  useEffect(() => {
    if (roomy <= 0) return;
    // As the view opens the window is still whatever it was — the main window, on its way to a strip — so what the
    // user had added is read from where it was kept, not measured.
    const added = fitted.current > 0 ? Math.max(0, (strip.current?.clientHeight ?? 0) - fitted.current) : addedBefore();
    fitted.current = roomy;
    asked.current = added;
    onHeight?.(roomy + added, least);
  }, [roomy, least]); // eslint-disable-line react-hooks/exhaustive-deps

  // A strip lower than it is laid out for gives up its air first (`spacingAt`); a higher one has lines to give (`linesFor`).
  const [squeeze, setSqueeze] = useState(0);
  const [spare, setSpare] = useState(0);
  useLayoutEffect(() => {
    const element = strip.current;
    if (!element) return undefined;
    const measure = () => {
      const height = element.clientHeight;
      // No layout (a test's document): as laid out.
      const next = height === 0 ? 0 : Math.round(squeezeOf(height, roomy, least) * 50) / 50;
      setSqueeze((before) => (before === next ? before : next));
      const room = Math.max(0, height - roomy);
      setSpare((before) => (before === room ? before : room));
      // Kept for the next time the view opens — once the window has been fitted and has come to rest: on its way
      // into a strip it passes through heights nobody chose.
      if (height > 0 && fitted.current > 0) {
        clearTimeout(keeping);
        // A pixel or two off what was asked is what was asked; a few pixels over the fitted height are nothing added.
        const settled = Math.abs(room - asked.current) <= ADDED_SLACK ? asked.current : room;
        keeping = setTimeout(() => keepAdded(settled < ADDED_LEAST ? 0 : settled), KEEP_AFTER_MS);
      }
    };
    let keeping: ReturnType<typeof setTimeout> | undefined;
    measure();
    const stop = observeSize(element, measure);
    return () => { stop(); clearTimeout(keeping); };
  }, [roomy, least]);
  const spacing = spacingAt(squeeze, roomySpacing, tightSpacing);
  const lines = useMemo(() => linesFor(lanes, fontSize, spare, roomySpacing), [shape, fontSize, spare, roman]); // eslint-disable-line react-hooks/exhaustive-deps
  // Squeezed, the answer has what the spacing leaves it; fitted or higher, what the window affords.
  const answerLines = squeeze > 0 ? spacing.answerLines + (lanes.find((lane) => lane.shape === 'pair')?.more?.length ?? 0) : lines.answer;
  const style = {
    '--lane-pad-top': `${spacing.padTop}px`,
    '--lane-pad-bottom': `${spacing.padBottom}px`,
    '--lane-gap': `${spacing.gap}px`,
    '--lane-inner-gap': `${spacing.inner}px`,
    '--lane-source-line': String(spacing.sourceLine),
    '--lane-answer-line': String(spacing.answerLine),
    '--lane-answer-roman': String(spacing.answerRoman),
    '--lane-row-line': String(spacing.rowLine),
    '--lane-roman': String(spacing.roman),
    '--lane-row-roman': String(spacing.rowRoman),
    // The user's own row is as high as its lines; everything else is the pair's.
    '--lane-row-lines': String(lines.row),
    '--lane-row-height': `${fontSize * ROW_SCALE * (spacing.rowLine + spacing.rowRoman) * lines.row}px`,
    '--lane-feedback-height': `${fontSize * ROW_SCALE * spacing.rowLine}px`,
    '--lane-source-lines': String(lines.source),
    // A pair's two texts share its height by what each is laid out for.
    // A pair's answer has this many lines, written in or not.
    '--lane-answer-lines': String(answerLines),
  } as CSSProperties;
  const who = (leg: LegName) => (leg === 'speaker' ? t('modePicker.modeYou', 'Me') : t('modePicker.modeParticipants', 'Other'));
  // A lane nobody has spoken in yet says nothing — not even whose it is: a tag alone on the screen, waiting, is noise.
  // It keeps its room, so that nothing moves when somebody does speak.
  const silent = (lane: Lane) => !lane.source?.text && !lane.answer?.text && !lane.feedback?.text && !lane.more?.some((text) => text.text);
  // The further translations, as what is written: a change in any is a change of the box they are in.
  const moreKey = (lane: Lane) => (lane.more ?? []).map((text) => text.text).join('\u0001');
  // Fork: the user's own row, and under it a box as high for each further translation: after an arrow of its own.
  const rowsOf = (lane: Lane, row: ReactNode) => (lane.more ? (
    <div className="subtitle-lane__rows">
      {row}
      {lane.more.map((text, i) => (
        <Slot key={i} className="subtitle-lane__row subtitle-lane__row--also" fitKey={`${fontSize}:${squeeze}:${lines.row}:${text.text}`}>
          {text.text !== '' && (<>
            {/* An arrow from the sentence, where that is shown: with the translations alone, each is a line like the first. */}
            {lane.source && <ArrowRight className="subtitle-lane__arrow" aria-hidden="true" strokeWidth={2.5} />}
            <span className="subtitle-lane__reply" lang={langOf(text)} data-kt-text=""><Written text={text} lit={lit} readingsOnly={!rowRoman} /></span>
          </>)}
        </Slot>
      ))}
    </div>
  ) : row);
  // Whose lane it is, is a bar of the lane's colour down its left edge; the word is there for a screen reader.
  const tag = (lane: Lane) => (silent(lane) ? null : <span className={`subtitle-lane__tag subtitle-lane__tag--${lane.leg}`}><span className="subtitle-lane__who">{who(lane.leg)}</span></span>);
  // Feedback that only approves is a bare tick (`tidyAnswer`): drawn as the app's own icon, in the user's colour. As
  // a character it came from whatever font had one, and sat beside the sentence like something from another page.
  const approves = (answer: LaneText | undefined) => answer?.purpose !== 'translation' && answer?.text.trim() === '✓';
  const tick = <Check className="subtitle-lane__ok" role="img" aria-label="✓" strokeWidth={3} />;
  // Grammar feedback that changes something: the sentence said, marked — what goes struck, what comes written in —
  // in place of the sentence, an arrow and the corrected one, which had to be read side by side (2026-10-23).
  const fixFor = (lane: Lane) => {
    if (!coached || lane.leg !== 'speaker' || !lane.source || !lane.answer || lane.answer.notice || lane.answer.purpose !== undefined) return null;
    // The held answer may belong to an older entry: use its configured pair, not the newest sentence's language.
    const entry = entries.find((e) => e.kind === 'exchange' && e.source.some((row) => row.segmentId === lane.source?.segmentId));
    return fixOf(lane.answers ?? lane.source.text, lane.source.language, lane.answer.text, entry?.kind === 'exchange' ? entry.languages.target : undefined);
  };
  const feedbackFor = (lane: Lane) => {
    const feedback = lane.feedback;
    if (!feedback) return null;
    // Its line, kept while there is none to write in it (`withFeedbackRoom`).
    if (!feedback.text) return <div className="subtitle-lane__feedback" />;
    const fix = fixOf(feedback.said.text, feedback.said.language, feedback.text);
    return (
      <Slot className="subtitle-lane__feedback" lang={langOf(feedback.said)} fitKey={`${fontSize}:${squeeze}:${feedback.origin}:${feedback.said.text}:${feedback.text}`}>
        {fix ? <Correction correction={fix} language={feedback.said.language} layout="row" /> : (<>
          <Written text={feedback.said} lit={lit} readingsOnly />
          {approves(feedback) ? tick : (<>
            {feedback.said.text && <ArrowRight className="subtitle-lane__arrow" aria-hidden="true" strokeWidth={2.5} />}
            <Written text={feedback} lit={lit} readingsOnly />
          </>)}
        </>)}
      </Slot>
    );
  };
  // A newer sentence is waiting for its answer: said quietly, after what is shown.
  const pending = <span className="subtitle-lane__pending" aria-hidden="true">…</span>;

  // Whether its first line is the small one (the sentence) or the large (the answer, where the sentence is not shown):
  // the tag sits level with it.
  const large = (lane: Lane) => lane.shape === 'pair' && !lane.source;

  return (
    <div ref={strip} className="subtitle-lanes" style={style}>
      {lanes.length > 0 && lanes.every(silent) && (
        // Nobody has spoken yet. A strip with no panel is then nothing at all on the screen, and cannot be found:
        // a quiet mark says where it is, and that it is listening.
        <div className="subtitle-lanes__waiting" aria-hidden="true">· · ·</div>
      )}
      {lanes.map((lane) => (
        // Whose lane it is, in a column of its own at the left: in its place whatever the text beside it says, and
        // wherever that text sits. Written into the text, it moved with every sentence of a centred strip.
        <div key={lane.leg} className={`subtitle-lane subtitle-lane--${lane.shape} subtitle-lane--${lane.leg}${silent(lane) ? ' is-silent' : ''}${large(lane) ? ' subtitle-lane--large' : ''}${lane.feedback ? ' has-feedback' : ''}`} data-lane={lane.leg} style={lane.shape === 'row' && lane.more ? ({ '--lane-more': String(lane.more.length) } as CSSProperties) : undefined}>
          {tag(lane)}
          {lane.shape === 'row' ? rowsOf(lane,
            // The user's own, under the other side's: what they said and what answers it, on one small line.
            <Slot className="subtitle-lane__row" fitKey={`${fontSize}:${squeeze}:${lines.row}:${lane.source?.text ?? ''}:${lane.answer?.text ?? ''}`}>
              {fixFor(lane) ? (
                <span className="subtitle-lane__said subtitle-lane__said--fixed" lang={langOf(lane.source!)} data-kt-text=""><Correction correction={fixFor(lane)!} language={lane.source!.language} layout="row" /></span>
              ) : (<>
              {lane.source && <span className="subtitle-lane__said" lang={langOf(lane.source)} data-kt-text=""><Written text={lane.source} lit={lit} readingsOnly={!rowRoman} /></span>}
              {lane.source && lane.answer && lane.source.text !== '' && (lane.answer.text !== '' || lane.pending) && !approves(lane.answer) && <ArrowRight className="subtitle-lane__arrow" aria-hidden="true" strokeWidth={2.5} />}
              {lane.answer && lane.answer.text !== '' && (approves(lane.answer) ? tick : <span className="subtitle-lane__reply" lang={langOf(lane.answer)} data-kt-text=""><Written text={lane.answer} lit={lit} readingsOnly={!rowRoman} /></span>)}
              {lane.answer && lane.answer.text === '' && lane.pending && pending}
              </>)}
              {/* Fork: the user has gone on: what they said since is next (`Lane.behind`). */}
              {lane.behind && !(lane.answer && lane.answer.text === '' && lane.pending) && <span className="subtitle-lane__pending subtitle-lane__pending--behind" aria-hidden="true">…</span>}
            </Slot>,
          ) : (
            <div className="subtitle-lane__texts">
              {lane.source && (
                <Slot className="subtitle-lane__source" lang={langOf(lane.source)} fitKey={`${fontSize}:${squeeze}:${lines.source}:${lane.source.text}`}>
                  <Written text={lane.source} lit={lit} />
                </Slot>
              )}
              {lane.answer && (
                <Slot
                  className={`subtitle-lane__answer${lane.answer.notice ? ' subtitle-lane__answer--notice' : ''}`}
                  lang={langOf(lane.answer)}
                  fitKey={`${fontSize}:${squeeze}:${answerLines}:${lane.answer.text}:${moreKey(lane)}`}
                >
                  {approves(lane.answer) ? tick : fixFor(lane) ? <Correction correction={fixFor(lane)!} language={lane.source!.language} layout={answerLines < 2 ? 'row' : 'block'} /> : <Written text={lane.answer} lit={lit} readingsOnly={lane.said && !!reads(lane.answer)} />}
                  {!lane.source && lane.pending && pending}
                  {/* Fork: its translation into their other language, on the line under. */}
                  {lane.more?.map((text, i) => text.text !== '' && (
                    <span key={i} className="subtitle-lane__also" lang={langOf(text)} data-kt-text=""><Written text={text} lit={lit} /></span>
                  ))}
                </Slot>
              )}
            </div>
          )}
          {feedbackFor(lane)}
        </div>
      ))}
    </div>
  );
}
