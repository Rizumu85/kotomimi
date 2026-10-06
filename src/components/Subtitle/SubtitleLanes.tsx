import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ArrowRight, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { LegName, SegmentId } from '../../lib/conversation/types';
import type { Entry } from '../../lib/projection/types';
import { fontLanguage } from '../../lib/fonts/fontCss';
import { annotatedLanguage } from '../../lib/annotate/script';
import { answeredOf, holdMs, nextShown } from '../../lib/subtitle/dwell';
import { buildLanes, lanesHeight, linesFor, ROOMY, ROW_SCALE, spacingAt, squeezeOf, TIGHT, withRoman, type Lane, type LanePiece, type LaneText } from '../../lib/subtitle/lanes';
import { useAnnotationStore } from '../../stores/annotationStore';
import type { LegFilters } from '../../lib/view/filter';
import { noticeText } from '../../lib/view/noticeText';
import { AnnotatedLines, useAnnotation } from '../Annotated/AnnotatedText';
import '../../styles/karaoke.scss';

/**
 * Text in a box of fixed height, at the size chosen — always. A caption is
 * read while it changes, out of the corner of an eye: the frame has to hold
 * still, and only the words move. So nothing here is ever drawn smaller to
 * make it fit. (It was, at first: over 56 seconds of two people talking the
 * other side's sentence changed size eleven times, between 17 and 11 pixels,
 * and the lanes moved nine — the user, 2026-10-06: "the size goes up and
 * down and the structure keeps changing".) What is too long for its box
 * loses its oldest line, a whole line at a time: the stylesheet holds the
 * text's end in sight where this says it is over (`data-over`).
 */
function Slot({ className, lang, children, fitKey }: { className: string; lang?: string; children: ReactNode; fitKey: string }) {
  const box = useRef<HTMLDivElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const measure = () => {
    const outer = box.current;
    const inner = text.current;
    if (!outer || !inner) return;
    // Over by a line, not by the pixels a reading above a word can add to one. No layout (a test's document): as written.
    const line = parseFloat(getComputedStyle(inner).lineHeight) || 0;
    if (outer.clientHeight > 0 && inner.scrollHeight > outer.clientHeight + Math.max(1, line / 2)) outer.dataset.over = '';
    else delete outer.dataset.over;
  };
  // What is written changed, or the lines it has.
  useLayoutEffect(measure, [fitKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // The window was resized.
  useEffect(() => {
    const outer = box.current;
    if (!outer || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(outer);
    return () => observer.disconnect();
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
function Stretch({ piece, language, upTo }: { piece: LanePiece; language?: string; upTo: number | undefined }) {
  const annotated = useAnnotation(piece.text, language);
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

/** A clause with the marks that close it: a romanization is written under each, so that it stays under its own words where the text wraps. */
const CLAUSE = /[^。．！？!?、，,;；:：]+[。．！？!?、，,;；:：」』）)\s]*|[。．！？!?、，,;；:：」』）)\s]+/g;

/** A piece as its clauses, each lit from where it begins. */
function clausesOf(piece: LanePiece): LanePiece[] {
  const out: LanePiece[] = [];
  for (const match of piece.text.matchAll(CLAUSE)) out.push({ key: `${piece.key}:${match.index}`, text: match[0], segmentId: piece.segmentId, start: piece.start + (match.index ?? 0) });
  return out.length > 1 ? out : [piece];
}

/**
 * A lane's text, row by row; a notice's words as they are. Where a romanization is written under the text, clause by
 * clause: under a whole sentence it is one block, which wraps as text first and romanization after — and a strip
 * that shows one line of it showed the romanization alone (seen 2026-10-06).
 */
function Written({ text, lit }: { text: LaneText; lit: ReadonlyMap<SegmentId, number> }) {
  const roman = useAnnotationStore((s) => s.romanization) && annotatedLanguage(text.language) !== null;
  if (text.pieces.length === 0) return <>{text.text}</>;
  const pieces = roman ? text.pieces.flatMap(clausesOf) : text.pieces;
  return <>{pieces.map((piece) => <Stretch key={piece.key} piece={piece} language={text.language} upTo={lit.get(piece.segmentId)} />)}</>;
}

const langOf = (text: LaneText): string | undefined => fontLanguage(text.language) || undefined;

const LEGS: readonly LegName[] = ['participant', 'speaker'];

/**
 * The height the lanes of these legs take before anything is said, and the least they can be squeezed into: what a
 * strip with no run on is held at, so that its frame is the size of the strip to come — "set the window's place and
 * size before you start" was not true of a window that took a height of its own the moment it started, and whose
 * frame could meanwhile be pressed flat (the user, 2026-10-06). Null: no lanes.
 */
export function restingHeights(legs: readonly LegName[], filters: LegFilters, fontSize: number, romanization: boolean): { height: number; least: number } | null {
  const lanes = buildLanes([], legs, filters, () => '');
  if (lanes.length === 0) return null;
  const [roomy, tight] = romanization ? [withRoman(ROOMY), withRoman(TIGHT)] : [ROOMY, TIGHT];
  return { height: lanesHeight(lanes, fontSize, roomy) + addedBefore(), least: lanesHeight(lanes, fontSize, tight) };
}

/**
 * Which answered sentence each side's pair shows, by its entry: the newest — once the one before it has been on
 * the screen long enough to be read (`dwell.ts`). The clock is kept here; what is shown by it is `buildLanes`'.
 */
function useHeld(entries: readonly Entry[]): Partial<Record<LegName, string>> {
  const shown = useRef<Partial<Record<LegName, { id: string; since: number }>>>({});
  const [held, setHeld] = useState<Partial<Record<LegName, string>>>({});
  const [turn, setTurn] = useState(0);
  useEffect(() => {
    const now = Date.now();
    let soonest = Infinity;
    const next: Partial<Record<LegName, string>> = {};
    for (const leg of LEGS) {
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
  }, [entries, turn]);
  return held;
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
}

/**
 * Fork: the subtitle view (`src/lib/subtitle/lanes.ts`) — the other side's
 * newest sentence and its translation, and under it the user's own with what
 * answers it. Each text keeps its place and its number of lines; what does
 * not fit is drawn smaller.
 */
export function SubtitleLanes({ entries, lit, legs, filters, fontSize, onHeight }: SubtitleLanesProps) {
  const { t } = useTranslation();
  const held = useHeld(entries);
  const lanes = useMemo(() => buildLanes(entries, legs, filters, (notice) => noticeText(t, notice), held), [entries, legs, filters, t, held]);
  // The layout the window is fitted to: the size chosen and which texts there are, not what they say.
  const shape = lanes.map((lane) => `${lane.leg}:${lane.source ? 's' : ''}${lane.answer ? 'a' : ''}`).join(',');
  // A romanization under the small lines has a line of its own there: while the switch is on and what is said is
  // in a language that has one — or nothing is said yet, so that the window is not made higher at the first word.
  const romanization = useAnnotationStore((s) => s.romanization);
  const small = lanes.flatMap((lane) => [lane.source?.language, lane.shape === 'row' ? lane.answer?.language : undefined]).filter((language): language is string => !!language);
  const roman = romanization && (small.length === 0 || small.some((language) => annotatedLanguage(language) !== null));
  const [roomySpacing, tightSpacing] = roman ? [withRoman(ROOMY), withRoman(TIGHT)] : [ROOMY, TIGHT];
  const [roomy, least] = useMemo(() => [lanesHeight(lanes, fontSize, roomySpacing), lanesHeight(lanes, fontSize, tightSpacing)], [shape, fontSize, roman]); // eslint-disable-line react-hooks/exhaustive-deps
  const strip = useRef<HTMLDivElement>(null);
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
    if (typeof ResizeObserver === 'undefined') return () => clearTimeout(keeping);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => { observer.disconnect(); clearTimeout(keeping); };
  }, [roomy, least]);
  const spacing = spacingAt(squeeze, roomySpacing, tightSpacing);
  const lines = useMemo(() => linesFor(lanes, fontSize, spare, roomySpacing), [shape, fontSize, spare, roman]); // eslint-disable-line react-hooks/exhaustive-deps
  // Squeezed, the answer has what the spacing leaves it; fitted or higher, what the window affords.
  const answerLines = squeeze > 0 ? spacing.answerLines : lines.answer;
  const style = {
    '--lane-pad-top': `${spacing.padTop}px`,
    '--lane-pad-bottom': `${spacing.padBottom}px`,
    '--lane-gap': `${spacing.gap}px`,
    '--lane-inner-gap': `${spacing.inner}px`,
    '--lane-source-line': String(spacing.sourceLine),
    '--lane-answer-line': String(spacing.answerLine),
    '--lane-row-line': String(spacing.rowLine),
    '--lane-roman': String(spacing.roman),
    // The user's own row is as high as its lines; everything else is the pair's.
    '--lane-row-lines': String(lines.row),
    '--lane-row-height': `${fontSize * ROW_SCALE * (spacing.rowLine + spacing.roman) * lines.row}px`,
    '--lane-source-lines': String(lines.source),
    // A pair's two texts share its height by what each is laid out for.
    // A pair's answer has this many lines, written in or not.
    '--lane-answer-lines': String(answerLines),
  } as CSSProperties;
  const who = (leg: LegName) => (leg === 'speaker' ? t('modePicker.modeYou', 'Me') : t('modePicker.modeParticipants', 'Other'));
  // A lane nobody has spoken in yet says nothing — not even whose it is: a tag alone on the screen, waiting, is noise.
  // It keeps its room, so that nothing moves when somebody does speak.
  const silent = (lane: Lane) => !lane.source?.text && !lane.answer?.text;
  // Whose lane it is, is a bar of the lane's colour down its left edge; the word is there for a screen reader.
  const tag = (lane: Lane) => (silent(lane) ? null : <span className={`subtitle-lane__tag subtitle-lane__tag--${lane.leg}`}><span className="subtitle-lane__who">{who(lane.leg)}</span></span>);
  // Feedback that only approves is a bare tick (`tidyAnswer`): drawn as the app's own icon, in the user's colour. As
  // a character it came from whatever font had one, and sat beside the sentence like something from another page.
  const approves = (answer: LaneText | undefined) => answer?.text.trim() === '✓';
  const tick = <Check className="subtitle-lane__ok" role="img" aria-label="✓" strokeWidth={3} />;
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
        <div key={lane.leg} className={`subtitle-lane subtitle-lane--${lane.shape} subtitle-lane--${lane.leg}${silent(lane) ? ' is-silent' : ''}${large(lane) ? ' subtitle-lane--large' : ''}`} data-lane={lane.leg}>
          {tag(lane)}
          {lane.shape === 'row' ? (
            // The user's own, under the other side's: what they said and what answers it, on one small line.
            <Slot className="subtitle-lane__row" fitKey={`${fontSize}:${squeeze}:${lines.row}:${lane.source?.text ?? ''}:${lane.answer?.text ?? ''}`}>
              {lane.source && <span className="subtitle-lane__said" lang={langOf(lane.source)}><Written text={lane.source} lit={lit} /></span>}
              {lane.source && lane.answer && lane.source.text !== '' && (lane.answer.text !== '' || lane.pending) && !approves(lane.answer) && <ArrowRight className="subtitle-lane__arrow" aria-hidden="true" strokeWidth={2.5} />}
              {lane.answer && lane.answer.text !== '' && (approves(lane.answer) ? tick : <span className="subtitle-lane__reply" lang={langOf(lane.answer)}><Written text={lane.answer} lit={lit} /></span>)}
              {lane.answer && lane.answer.text === '' && lane.pending && pending}
            </Slot>
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
                  fitKey={`${fontSize}:${squeeze}:${answerLines}:${lane.answer.text}`}
                >
                  {approves(lane.answer) ? tick : <Written text={lane.answer} lit={lit} />}
                  {!lane.source && lane.pending && pending}
                </Slot>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
