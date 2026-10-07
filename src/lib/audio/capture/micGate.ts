/**
 * Fork: the microphone's activation threshold — a gate on its level, as
 * VRChat has one. Below the threshold the microphone is heard as silence;
 * at or above it, it is heard as it is.
 *
 * Why: with loudspeakers near the microphone the other side's voice comes
 * back through it, quieter than the user's own but clear enough to be
 * written down — and, under grammar feedback, taken for a sentence of the
 * user's (the user, 2026-10-06: "turn the speakers up a little and it all
 * goes back into the feedback"). Comparing the two legs' writing
 * (`pipeline.ts`, `heardLately`) only helps while both are heard. The
 * difference that always holds is loudness: a mouth at the microphone is
 * louder than a loudspeaker across the desk. So the user sets a level, with
 * a meter to set it by, and what is quieter is not heard at all.
 *
 * How, in three rules:
 * - **Silence, not nothing.** A chunk below the threshold is delivered as
 *   zeros of its length, never dropped: the recognizers' VAD counts its
 *   pause in frames it is given (`native-vad.worker.ts`, `redemptionMs`),
 *   a stream that stops arriving never ends a sentence, and every other
 *   listener (the echo monitor, the meters, the passthrough) keeps its clock.
 * - **A little lookahead.** The gate decides each chunk only after the next
 *   `GATE_LOOKAHEAD_MS` have arrived, so the quiet onset of a word — the
 *   breath before it, a soft consonant — is delivered whole once the word
 *   proves loud enough. The microphone is heard that much later; nothing
 *   else is.
 * - **A hold.** Once open the gate stays open `GATE_HOLD_MS` past the last
 *   loud chunk: the dip between two words, a trailing consonant, are not cut.
 *   Longer would let more of the other side's voice through after the user
 *   stops; shorter would chop their own.
 *
 * The edges are faded over a few milliseconds, so that neither the gate's
 * opening nor its closing clicks in the passthrough or the recording. Pure:
 * clock-free, in samples; the recorder's chunks are what it counts by.
 */
import { SAMPLE_RATE } from '../../contract/adapter';

/** How long a chunk waits for what follows it before the gate decides it. */
export const GATE_LOOKAHEAD_MS = 170;
/** How long the gate stays open after the last chunk at or over the threshold. */
export const GATE_HOLD_MS = 400;
/** The quietest level the meter and the threshold tell apart from silence, in dBFS. */
export const GATE_FLOOR_DB = -60;
/** The ramp at an edge, in samples: 4 ms at 24 kHz. */
const FADE_SAMPLES = 96;

/**
 * A chunk's level, 0–100: its RMS in dBFS, spread so that `GATE_FLOOR_DB` is
 * 0 and full scale is 100 — a scale a slider can be set on. (Linear
 * amplitude put every voice between 1 and 10 of 100: speech at a sensible
 * distance is around −25 dBFS, a loudspeaker's leak around −45.)
 */
export function levelOf(pcm: Int16Array): number {
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) {
    const s = pcm[i] / 32768;
    sum += s * s;
  }
  const rms = Math.sqrt(sum / pcm.length);
  if (rms <= 0) return 0;
  const db = 20 * Math.log10(rms);
  return Math.max(0, Math.min(100, ((db - GATE_FLOOR_DB) / -GATE_FLOOR_DB) * 100));
}

export interface MicGateOptions {
  /** Read on every chunk: 0–100, and 0 is off — everything is delivered, at once. */
  threshold(): number;
  deliver(pcm: Int16Array): void;
  /** Told every chunk's level before the gate, for the meter the threshold is set by. */
  onLevel?(level: number): void;
  sampleRate?: number;
  lookaheadMs?: number;
  holdMs?: number;
}

export interface MicGate {
  /** A chunk from the recorder: delivered now (gate off), or after the lookahead, as it is or as silence. */
  push(pcm: Int16Array): void;
  /** Forgets what is queued and closes the gate: a device switch, the end. Nothing is delivered. */
  reset(): void;
  /** Whether the last chunk delivered was heard (true) or silenced (false). */
  readonly open: boolean;
}

interface Queued {
  pcm: Int16Array;
  /** Where the chunk begins, in samples from the first one pushed. */
  at: number;
}

export function createMicGate(options: MicGateOptions): MicGate {
  const rate = options.sampleRate ?? SAMPLE_RATE;
  const lookahead = Math.round(((options.lookaheadMs ?? GATE_LOOKAHEAD_MS) * rate) / 1000);
  const hold = Math.round(((options.holdMs ?? GATE_HOLD_MS) * rate) / 1000);
  const queue: Queued[] = [];
  /** Samples queued, all chunks together. */
  let queued = 0;
  /** Samples pushed so far: the position the next chunk begins at. */
  let position = 0;
  /** The position the gate is held open up to: the end of the last loud chunk, plus the hold. */
  let openUntil = 0;
  /** Whether the chunk last delivered was heard: the next edge is faded from it. */
  let wasOpen = false;

  const fadeIn = (pcm: Int16Array): Int16Array => {
    const out = pcm.slice();
    const n = Math.min(FADE_SAMPLES, out.length);
    for (let i = 0; i < n; i++) out[i] = Math.round((out[i] * i) / n);
    return out;
  };

  const fadeOut = (pcm: Int16Array): Int16Array => {
    const out = new Int16Array(pcm.length);
    const n = Math.min(FADE_SAMPLES, pcm.length);
    for (let i = 0; i < n; i++) out[i] = Math.round((pcm[i] * (n - i)) / n);
    return out;
  };

  /** Hands a chunk on, heard or silenced, with its edge faded where the gate just moved. */
  const emit = (pcm: Int16Array, heard: boolean) => {
    const out = heard ? (wasOpen ? pcm : fadeIn(pcm)) : wasOpen ? fadeOut(pcm) : new Int16Array(pcm.length);
    wasOpen = heard;
    options.deliver(out);
  };

  /** The gate was switched off: what waited for its lookahead is heard, as it is. */
  const flush = () => {
    for (const item of queue.splice(0)) emit(item.pcm, true);
    queued = 0;
  };

  return {
    push(pcm) {
      const threshold = options.threshold();
      const level = levelOf(pcm);
      options.onLevel?.(level);
      // Off: the microphone as it is, untouched — only what waited on the gate is faded in, where it had been silenced.
      if (!(threshold > 0)) {
        flush();
        position += pcm.length;
        wasOpen = true;
        options.deliver(pcm);
        return;
      }
      const at = position;
      position += pcm.length;
      if (level >= threshold) openUntil = Math.max(openUntil, position + hold);
      queue.push({ pcm, at });
      queued += pcm.length;
      // A chunk is decided once the lookahead after it has arrived: a loud chunk within it has already set `openUntil`.
      while (queue.length > 0 && queued - queue[0].pcm.length >= lookahead) {
        const head = queue.shift()!;
        queued -= head.pcm.length;
        emit(head.pcm, head.at < openUntil);
      }
    },

    reset() {
      queue.length = 0;
      queued = 0;
      openUntil = 0;
      wasOpen = false;
    },

    get open() {
      return wasOpen;
    },
  };
}
