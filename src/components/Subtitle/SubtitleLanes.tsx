import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { LegName, SegmentId } from '../../lib/conversation/types';
import type { Entry } from '../../lib/projection/types';
import { fontLanguage } from '../../lib/fonts/fontCss';
import { buildLanes, lanesHeight, SOURCE_SCALE, spacingAt, squeezeOf, TIGHT, type LanePiece, type LaneText } from '../../lib/subtitle/lanes';
import type { LegFilters } from '../../lib/view/filter';
import { noticeText } from '../../lib/view/noticeText';
import { AnnotatedLines, useAnnotation } from '../Annotated/AnnotatedText';
import '../../styles/karaoke.scss';

/** Text is drawn no smaller than this much of the size chosen: under it, the oldest of it goes out of sight instead. */
const SMALLEST = 0.5;
/** Steps of the search for the largest size that fits: fine to a sixty-fourth. */
const STEPS = 6;

/**
 * Text in a box of fixed height, as large as fits and no larger than the
 * size chosen. A caption strip keeps its lines where they are whatever is
 * said: a sentence too long for its box is drawn smaller — and the window can
 * be made small under large text, which then shrinks only when it must.
 */
function FitText({ className, lang, children, fitKey }: { className: string; lang?: string; children: ReactNode; fitKey: string }) {
  const box = useRef<HTMLDivElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const fit = () => {
    const outer = box.current;
    const inner = text.current;
    if (!outer || !inner) return;
    const fits = (scale: number) => {
      inner.style.fontSize = `${scale}em`;
      return inner.scrollHeight <= outer.clientHeight + 1;
    };
    // No layout (a test's document), or it fits as it is.
    delete outer.dataset.over;
    if (outer.clientHeight === 0 || fits(1)) return;
    let low = SMALLEST;
    let high = 1;
    if (fits(low)) {
      for (let i = 0; i < STEPS; i++) {
        const middle = (low + high) / 2;
        if (fits(middle)) low = middle; else high = middle;
      }
    } else {
      // Too long even at the smallest: its end stays in sight, the newest words (the stylesheet reads this).
      outer.dataset.over = '';
    }
    inner.style.fontSize = `${low}em`;
  };
  // What is written changed, or the size chosen.
  useLayoutEffect(fit, [fitKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // The window was resized.
  useEffect(() => {
    const outer = box.current;
    if (!outer || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(fit);
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

/** A lane's text, row by row; a notice's words as they are. */
function Written({ text, lit }: { text: LaneText; lit: ReadonlyMap<SegmentId, number> }) {
  if (text.pieces.length === 0) return <>{text.text}</>;
  return <>{text.pieces.map((piece) => <Stretch key={piece.key} piece={piece} language={text.language} upTo={lit.get(piece.segmentId)} />)}</>;
}

const langOf = (text: LaneText): string | undefined => fontLanguage(text.language) || undefined;

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
  const lanes = useMemo(() => buildLanes(entries, legs, filters, (notice) => noticeText(t, notice)), [entries, legs, filters, t]);
  // The layout the window is fitted to: the size chosen and which texts there are, not what they say.
  const shape = lanes.map((lane) => `${lane.leg}:${lane.source ? 's' : ''}${lane.answer ? 'a' : ''}`).join(',');
  const [roomy, least] = useMemo(() => [lanesHeight(lanes, fontSize), lanesHeight(lanes, fontSize, TIGHT)], [shape, fontSize]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (roomy > 0) onHeight?.(roomy, least);
  }, [roomy, least]); // eslint-disable-line react-hooks/exhaustive-deps

  // A strip lower than it is laid out for gives up its air first (`spacingAt`).
  const strip = useRef<HTMLDivElement>(null);
  const [squeeze, setSqueeze] = useState(0);
  useLayoutEffect(() => {
    const element = strip.current;
    if (!element) return undefined;
    const measure = () => {
      const height = element.clientHeight;
      // No layout (a test's document): as laid out.
      const next = height === 0 ? 0 : Math.round(squeezeOf(height, roomy, least) * 50) / 50;
      setSqueeze((before) => (before === next ? before : next));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [roomy, least]);
  const spacing = spacingAt(squeeze);
  const style = {
    '--lane-pad-top': `${spacing.padTop}px`,
    '--lane-pad-bottom': `${spacing.padBottom}px`,
    '--lane-gap': `${spacing.gap}px`,
    '--lane-inner-gap': `${spacing.inner}px`,
    '--lane-source-line': String(spacing.sourceLine),
    '--lane-answer-line': String(spacing.answerLine),
    // Each text's share of the height: what it is laid out for.
    '--lane-source-share': String(SOURCE_SCALE * spacing.sourceLine),
    '--lane-answer-share': String(spacing.answerLine * spacing.answerLines),
  } as CSSProperties;

  return (
    <div ref={strip} className="subtitle-lanes" style={style}>
      {lanes.map((lane) => (
        <div key={lane.leg} className={`subtitle-lane subtitle-lane--${lane.leg}`} data-lane={lane.leg}>
          {lane.source && (
            <FitText className="subtitle-lane__source" lang={langOf(lane.source)} fitKey={`${fontSize}:${squeeze}:${lane.source.text}`}>
              <Written text={lane.source} lit={lit} />
            </FitText>
          )}
          {lane.answer && (
            <FitText
              className={`subtitle-lane__answer${lane.answer.stale ? ' subtitle-lane__answer--stale' : ''}${lane.answer.notice ? ' subtitle-lane__answer--notice' : ''}`}
              lang={langOf(lane.answer)}
              fitKey={`${fontSize}:${squeeze}:${lane.answer.text}`}
            >
              <Written text={lane.answer} lit={lit} />
            </FitText>
          )}
        </div>
      ))}
    </div>
  );
}
