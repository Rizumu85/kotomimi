/**
 * Fork: the microphone's level as its source last measured it — 0–100, the
 * scale of `levelOf` (`capture/micGate.ts`), before the activation gate —
 * and when. The meter the threshold is set by reads it (`MicGateControl`);
 * the microphone source writes it through `MicSettings.level`
 * (`appCapture.ts`), whether a run holds the microphone or the settings'
 * own test does. Not a store: it moves a dozen times a second, and a meter
 * reads it on its own frames.
 */

/** No chunk for this long: nothing is listening to the microphone, and the meter reads flat. */
export const MIC_LEVEL_STALE_MS = 400;

let level = 0;
let at = -Infinity;
const listeners = new Set<() => void>();

export const micLevel = {
  /** A chunk's level, as the microphone source measured it. */
  set(value: number, now = Date.now()): void {
    level = value;
    at = now;
    for (const listener of [...listeners]) listener();
  },
  /** The latest level, or 0 once nothing has reported for a while. */
  read(now = Date.now()): number {
    return now - at > MIC_LEVEL_STALE_MS ? 0 : level;
  },
  /** Whether a microphone has reported lately: a meter with none to read says so. */
  live(now = Date.now()): boolean {
    return now - at <= MIC_LEVEL_STALE_MS;
  },
  /** Called at every report. */
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  /** Forgets the last report: tests. */
  reset(): void {
    level = 0;
    at = -Infinity;
  },
};
