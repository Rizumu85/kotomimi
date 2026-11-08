// src/vr/Strip.tsx
/**
 * Fork: the caption strip under the line of sight, which is the computer's subtitle drawn in the headset
 * (`SubtitleBody`, compact): each side's newest sentence with its translation and, where grammar feedback is on, the
 * feedback, held as long as the subtitle holds them; or, while a change restarts the run, what it changes to; or that
 * recognition stopped. Nothing while nothing has been said, so an empty panel is not in the way.
 *
 * The page is a window of its own: the few app stores the subtitle reads — whether answers are feedback, the reading
 * aids — and the app's language are set here from what came with the state (`VrCaptions`).
 */
import { useEffect } from 'react';
import i18n from '../locales';
import { SubtitleBody } from '../components/Subtitle/SubtitleBands';
import { useAnnotationStore } from '../stores/annotationStore';
import { useCoachingStore } from '../stores/coachingStore';
import type { RomanizedLanguage } from '../lib/annotate/types';
import type { SegmentId } from '../lib/conversation/types';
import { fill } from './bridge';
import type { VrState } from './types';

/** The size the strip's text is drawn at: the page is 800 px wide, drawn twice that, and read 1.4 m away. */
export const STRIP_FONT_SIZE = 30;
const NOTHING_LIT: ReadonlyMap<SegmentId, number> = new Map();

export default function Strip({ state }: { state: VrState }) {
  const { words, captions } = state;
  useEffect(() => { if (captions.language && i18n.language !== captions.language) void i18n.changeLanguage(captions.language); }, [captions.language]);
  useEffect(() => { useCoachingStore.setState({ coached: captions.coached }); }, [captions.coached]);
  const { furigana, romanization, romanizationOff, pinyin, jyutping, sourceItalic } = captions.aids;
  useEffect(() => {
    useAnnotationStore.setState({ furigana, romanization, romanizationOff: romanizationOff as RomanizedLanguage[], pinyin, jyutping, sourceItalic });
  }, [furigana, romanization, romanizationOff, pinyin, jyutping, sourceItalic]);

  if (!state.strip) return null;
  if (state.switching) {
    return <div className="strip strip--quiet"><div className="strip__answer">{fill(words.switching, { name: state.switching.label })}</div></div>;
  }
  if (state.failed && state.phase === 'idle') {
    return <div className="strip strip--quiet strip--error"><div className="strip__answer">{words.stopped}</div></div>;
  }
  if (!captions.entries.some((entry) => entry.kind === 'exchange')) return null;
  return (
    <div className="strip strip--lanes">
      <SubtitleBody
        entries={captions.entries}
        lit={NOTHING_LIT}
        compact
        fontSize={STRIP_FONT_SIZE}
        filters={captions.filters}
        legs={captions.legs}
        newItemHighlightEnabled={false}
        {...(captions.pair ? { pair: captions.pair } : {})}
      />
    </div>
  );
}
