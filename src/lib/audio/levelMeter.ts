/**
 * Fork: whether one leg is hearing sound now, for the dot on its footer button — not a picture of it. Each delivered
 * chunk's loudness (its RMS) is taken as it lands; a chunk as loud as quiet speech marks the leg heard, for a moment
 * after, so the dot does not blink between words. Nothing is computed when nobody asks, and nothing is drawn.
 *
 * It was a spectrum for three waveform strips drawn on every frame, which held the GPU process at about a tenth of a
 * core while anyone spoke (2026-11-02). Whether the voice gets in is what the user looks for, and a dot says it.
 */
import { realClock, type Clock } from '../contract/clock';

/** Quiet speech, close to the microphone: -50 dBFS RMS. A quiet room under noise suppression is far below. */
export const HEARD_RMS = 32768 * 10 ** (-50 / 20);
/** How long a loud chunk keeps the leg heard: longer than the gaps between words, shorter than between sentences. */
export const HEARD_HOLD_MS = 400;

export interface LevelMeter {
  /** A delivered chunk. */
  push(pcm: Int16Array): void;
  /** A chunk as loud as speech landed within `HEARD_HOLD_MS`. */
  heard(): boolean;
  reset(): void;
}

/** A chunk's RMS, in Int16 units. */
export function rmsOf(pcm: Int16Array): number {
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
  return Math.sqrt(sum / pcm.length);
}

export function createLevelMeter(clock: Pick<Clock, 'now'> = realClock): LevelMeter {
  let heardAt = -Infinity;
  return {
    push(pcm) {
      if (rmsOf(pcm) >= HEARD_RMS) heardAt = clock.now();
    },
    heard() {
      return clock.now() - heardAt <= HEARD_HOLD_MS;
    },
    reset() {
      heardAt = -Infinity;
    },
  };
}
