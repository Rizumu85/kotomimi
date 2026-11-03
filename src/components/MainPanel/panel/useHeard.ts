import { useEffect, useState } from 'react';
import type { LegName } from '../../../lib/conversation/types';
import type { LevelMeter } from '../../../lib/audio/levelMeter';

/** Each captured leg: heard now, or not. A leg not captured has no entry. */
export type Heard = Partial<Record<LegName, boolean>>;

/** How often the legs are asked: the dots follow speech within a fifth of a second. */
export const HEARD_LOOK_MS = 200;

/**
 * Fork: whether the legs `captured` hear sound, for the dots on the footer's buttons, while `on` (a run). Asked a few
 * times a second, and a change of state is the only render: a sentence lights its dot once and puts it out once.
 */
export function useHeard(levels: Readonly<Record<LegName, LevelMeter>> | null, captured: readonly LegName[], on: boolean): Heard | null {
  const [heard, setHeard] = useState<Heard | null>(null);
  const legs = captured.join(',');
  useEffect(() => {
    if (!on || !levels) {
      setHeard(null);
      return;
    }
    const look = () => {
      const now: Heard = {};
      for (const leg of legs.split(',').filter(Boolean) as LegName[]) now[leg] = levels[leg].heard();
      setHeard((was) => (was && Object.keys(now).length === Object.keys(was).length && Object.entries(now).every(([leg, v]) => was[leg as LegName] === v) ? was : now));
    };
    look();
    const timer = window.setInterval(look, HEARD_LOOK_MS);
    return () => window.clearInterval(timer);
  }, [levels, legs, on]);
  return heard;
}
