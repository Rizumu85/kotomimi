// src/vr/Strip.tsx
/**
 * Fork: the caption strip under the line of sight: the other side's latest
 * sentence, its translation large; or, while a change restarts the run, what
 * it changes to; or that recognition stopped. Empty a while after the last
 * sentence, so a strip with nothing new is not in the way.
 */
import { useEffect, useState } from 'react';
import { fill } from './bridge';
import type { VrState } from './types';

/** How long a sentence stays once nothing newer has come. */
export const STRIP_HOLD_MS = 9000;

export default function Strip({ state }: { state: VrState }) {
  const { words } = state;
  const latest = [...state.lines].reverse().find((line) => line.leg === 'participant' && (line.translation || line.source));
  const key = latest ? `${latest.id}:${latest.source}:${latest.translation}` : '';
  const [shownKey, setShownKey] = useState('');
  useEffect(() => {
    if (!key) return;
    setShownKey(key);
    const timer = window.setTimeout(() => setShownKey(''), STRIP_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [key]);

  if (!state.strip) return null;
  if (state.switching) {
    return <div className="strip strip--quiet"><div className="strip__answer">{fill(words.switching, { name: state.switching.label })}</div></div>;
  }
  if (state.failed && state.phase === 'idle') {
    return <div className="strip strip--quiet strip--error"><div className="strip__answer">{words.stopped}</div></div>;
  }
  if (!latest || shownKey !== key) return null;
  return (
    <div className="strip">
      {latest.translation && latest.source ? <div className="strip__source">{latest.source}</div> : null}
      <div className="strip__answer">{latest.translation || latest.source}</div>
    </div>
  );
}
