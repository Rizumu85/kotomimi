/**
 * Fork: conversation text with its reading aids — `<ruby>` over kanji, and a
 * romanization line under each line. `useAnnotation` answers null when there
 * is nothing to add (both switches off, a language with no aid, the Japanese
 * dictionary not loaded yet), and the caller then draws the text exactly as
 * it always did.
 */
import { Fragment, useEffect, useMemo, useSyncExternalStore } from 'react';
import { annotateText, needsJapanese } from '../../lib/annotate/annotate';
import { japaneseTokenizer, loadJapanese, subscribeJapanese } from '../../lib/annotate/japaneseStore';
import { annotatedLanguage } from '../../lib/annotate/script';
import type { AnnotatedLine } from '../../lib/annotate/types';
import { useAnnotationStore } from '../../stores/annotationStore';
import './AnnotatedText.scss';

/**
 * `text` as annotated lines, or null when it would be drawn no differently.
 * `language` is the row's (the leg's pair, or what the provider detected): it
 * decides only how a line of Han characters alone is read.
 */
export function useAnnotation(text: string, language: string | null | undefined): AnnotatedLine[] | null {
  const furigana = useAnnotationStore((s) => s.furigana);
  const roman = useAnnotationStore((s) => s.romanization);
  const hint = annotatedLanguage(language);
  const wantsJapanese = needsJapanese(text, { furigana, roman, language: hint });
  // The snapshot is the tokenizer alone: a load that fails changes nothing a row draws, so it re-renders none.
  const japanese = useSyncExternalStore(subscribeJapanese, japaneseTokenizer, japaneseTokenizer);
  useEffect(() => {
    if (wantsJapanese) loadJapanese();
  }, [wantsJapanese]);
  return useMemo(() => {
    if (!furigana && !roman) return null;
    const lines = annotateText(text, { furigana, roman, language: hint, japanese });
    return lines.some((line) => line.roman !== undefined || line.parts.some((part) => part.ruby !== undefined)) ? lines : null;
  }, [text, furigana, roman, hint, japanese]);
}

export interface AnnotatedLinesProps {
  lines: readonly AnnotatedLine[];
  /** Inside flowing text (the subtitle's bands): the block sits in the line instead of breaking it. */
  inline?: boolean;
  className?: string;
}

export function AnnotatedLines({ lines, inline = false, className }: AnnotatedLinesProps) {
  return (
    <span className={`annot${inline ? ' annot--inline' : ''}${className ? ` ${className}` : ''}`}>
      {lines.map((line, i) => (
        <span className="annot-line" key={i}>
          <span className="annot-text">
            {line.parts.map((part, j) => (part.ruby === undefined
              ? <Fragment key={j}>{part.text}</Fragment>
              : <ruby key={j}>{part.text}<rt>{part.ruby}</rt></ruby>))}
          </span>
          {line.roman !== undefined && line.roman !== '' && <span className="annot-roman">{line.roman}</span>}
        </span>
      ))}
    </span>
  );
}
