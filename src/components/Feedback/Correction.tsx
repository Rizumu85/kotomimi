import { AnnotatedLines, useAnnotation } from '../Annotated/AnnotatedText';
import type { Correction as CorrectionData } from '../../lib/feedback/correction';
import './Correction.scss';

/**
 * A piece of the sentence, with the readings above its words where its language has any and they are switched on —
 * readings only: they sit in the line, so every piece keeps the one baseline. (With its own romanization each piece
 * was a block of its own, and a piece of kana alone stood higher than one with readings: the user, 2026-10-23.)
 */
function Read({ text, language }: { text: string; language?: string }) {
  const annotated = useAnnotation(text, language, 'readings');
  return annotated ? <AnnotatedLines lines={annotated} inline /> : <>{text}</>;
}

/** The corrected sentence's romanization, whole, under the marked one: what to say, not what was said. */
function Roman({ text, language }: { text: string; language?: string }) {
  const annotated = useAnnotation(text, language, 'roman');
  const roman = annotated?.map((line) => line.roman).filter(Boolean).join(' ');
  return roman ? <span className="kt-fix__roman">{roman}</span> : null;
}

/**
 * Fork: grammar feedback drawn as a marked sentence (`src/lib/feedback/correction.ts`): what goes struck through in
 * red, what comes written in in red, the rest as said — and the reason after it, quieter. `layout`: `row` keeps it
 * on one flowing line, the reason after the sentence (the strip's own row); `block` puts the reason under it.
 */
export function Correction({ correction, language, layout = 'block', className }: { correction: CorrectionData; language?: string; layout?: 'row' | 'block'; className?: string }) {
  return (
    <span className={`kt-fix kt-fix--${layout}${className ? ` ${className}` : ''}`}>
      <span className="kt-fix__sentence">
        {correction.parts.map((part, i) => {
          if (part.kind === 'gone') return <del key={i} className="kt-fix__gone"><Read text={part.text} language={language} /></del>;
          if (part.kind === 'added') return <ins key={i} className="kt-fix__added"><Read text={part.text} language={language} /></ins>;
          return <Read key={i} text={part.text} language={language} />;
        })}
      </span>
      <Roman text={correction.parts.filter((part) => part.kind !== 'gone').map((part) => part.text).join('')} language={language} />
      {correction.why && <span className="kt-fix__why">{correction.why}</span>}
    </span>
  );
}
