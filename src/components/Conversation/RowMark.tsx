import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Flag } from 'lucide-react';
import type { LegName } from '../../lib/conversation/types';
import type { ExchangeEntry } from '../../app/sessionRecording';

/**
 * Fork: "this line went wrong", on a line of a recorded session (Help → Record sessions). The recording keeps the
 * sound; the mark tells which moment to look at. A row knows its leg and time; the exchange behind it is found by both.
 */
export function RowMark({ leg, t }: { leg: LegName; t: number }) {
  const { t: tr } = useTranslation();
  const [state, setState] = useState<'idle' | 'marked' | 'missing'>('idle');
  const label = state === 'marked'
    ? tr('fork.recording.marked', 'Marked')
    : state === 'missing'
      ? tr('fork.recording.notRecorded', 'This line was not recorded')
      : tr('fork.recording.mark', 'Mark this line as wrong');
  const mark = async () => {
    // Loaded on the press: the list is drawn in places (previews, tests) that never build the app session.
    const [{ getAppSession }, { markSessionLine }] = await Promise.all([import('../../app/session'), import('../../app/sessionRecording')]);
    const entry = getAppSession().view.get().entries.find((e): e is ExchangeEntry => e.kind === 'exchange' && e.leg === leg && e.t === t);
    if (!entry) { setState('missing'); return; }
    const result = await markSessionLine(entry);
    setState(result.ok ? 'marked' : 'missing');
  };
  return (
    <button
      type="button"
      className={`row-mark-btn is-${state}`}
      onClick={state === 'marked' ? undefined : () => { void mark(); }}
      aria-label={label}
      title={label}
    >
      <Flag size={10} fill={state === 'marked' ? 'currentColor' : 'none'} />
    </button>
  );
}
