/**
 * Fork: the other side's sound, split by where it comes from (VRChat, `src/app/vrchat.ts`).
 *
 * A game's world places its players: each voice comes from a side, louder in
 * one ear, a little later in the other. A world's video player, measured on
 * 2026-10-26, does not: its sound is the same in both channels to the last
 * bit. So the difference of the two channels holds the players and none of
 * the video (43–86 dB lower), and what the two share holds the video.
 *
 * - **The mix.** As usual, the leg hears the average of the two channels.
 * - **People.** While a video plays, the leg hears left minus right: the
 *   video gone, a voice from the side as loud as ever, a voice from straight
 *   ahead 11.5 dB lower and recognised a little worse — so only then.
 * - **Shared.** What the two channels have in common, for a lane of its own
 *   (the video's words): each frequency kept as far as the two agree on it.
 *   A voice from straight ahead is partly in it as well.
 * - **Hearing.** Every half second, how loud the two's average, their
 *   difference and what they share are: what tells whether a video can be
 *   taken out (`createVideoJudge`).
 *
 * One for the page (`participantSplit`): the participant's system audio
 * passes through it (`systemAudio.ts`), and the VRChat controller sets it.
 * A chunk with one channel passes as it is.
 */
import { SAMPLE_RATE } from '../../contract/adapter';

export type SplitMode = 'mix' | 'people';

/** One half second of two-channel sound, in dB of full scale (power): the average, the difference, what they share. */
export interface Hearing {
  mid: number;
  side: number;
  shared: number;
}

export interface StereoChunk {
  mono: Int16Array;
  left?: Int16Array;
  right?: Int16Array;
}

export interface ParticipantSplit {
  /** One chunk as captured: what the leg hears of it. */
  take(chunk: StereoChunk): Int16Array;
  setMode(mode: SplitMode): void;
  mode(): SplitMode;
  /** Each half second of two-channel sound. */
  onHearing(listener: (hearing: Hearing) => void): () => void;
  /** What the two channels share, as it comes, while someone listens. */
  onShared(listener: (pcm: Int16Array) => void): () => void;
  /** Whether sound with a direction has been heard since the page began: the sound is in stereo at all. */
  spatialSeen(): boolean;
}

/** The silence below which a power counts as none: −120 dB. */
const FLOOR = 1e-12;
const dB = (power: number) => 10 * Math.log10(Math.max(power, FLOOR));

/** Sound with a direction: loud enough, and its difference not far below its average (a voice straight ahead: 11.5 dB). */
const SPATIAL_MID_DB = -45;
const SPATIAL_SIDE_DB = 15;

const clamp16 = (v: number) => (v > 32767 ? 32767 : v < -32768 ? -32768 : v);

export function createParticipantSplit(rate = SAMPLE_RATE): ParticipantSplit {
  let mode: SplitMode = 'mix';
  let spatial = false;
  const hearingListeners = new Set<(hearing: Hearing) => void>();
  const sharedListeners = new Set<(pcm: Int16Array) => void>();
  const windowLength = Math.round(rate / 2);
  let ll = 0, rr = 0, lr = 0, n = 0;
  let shared: SharedFilter | null = null;

  const closeWindow = () => {
    const scale = 1 / (n * 32768 * 32768);
    const hearing: Hearing = {
      mid: dB((ll + rr + 2 * lr) * scale / 4),
      side: dB((ll + rr - 2 * lr) * scale / 4),
      shared: dB(lr * scale),
    };
    ll = rr = lr = n = 0;
    if (hearing.mid > SPATIAL_MID_DB && hearing.side > hearing.mid - SPATIAL_SIDE_DB) spatial = true;
    for (const listener of hearingListeners) listener(hearing);
  };

  return {
    take(chunk) {
      const { left, right } = chunk;
      if (!left || !right || left.length !== right.length) return chunk.mono;
      for (let i = 0; i < left.length; i++) {
        const a = left[i], b = right[i];
        ll += a * a; rr += b * b; lr += a * b;
        if (++n === windowLength) closeWindow();
      }
      if (sharedListeners.size > 0) {
        shared ??= createSharedFilter();
        const pcm = shared.push(left, right);
        if (pcm.length > 0) for (const listener of sharedListeners) listener(pcm);
      }
      if (mode === 'mix') return chunk.mono;
      const out = new Int16Array(left.length);
      for (let i = 0; i < left.length; i++) out[i] = clamp16(left[i] - right[i]);
      return out;
    },
    setMode(next) {
      mode = next;
    },
    mode: () => mode,
    onHearing(listener) {
      hearingListeners.add(listener);
      return () => { hearingListeners.delete(listener); };
    },
    onShared(listener) {
      sharedListeners.add(listener);
      return () => {
        sharedListeners.delete(listener);
        // Begun again from silence when next asked: what it held is from another stretch.
        if (sharedListeners.size === 0) shared = null;
      };
    },
    spatialSeen: () => spatial,
  };
}

/** The page's one split of the participant's sound. */
export const participantSplit = createParticipantSplit();

// ── What the two channels share ─────────────────────────────────────────────

/**
 * Frames of 512 samples (21 ms) every 256, square-root Hann windows in and out, which overlap-add back to the sound.
 * In each frequency the average is kept by how little the difference holds of it: all of it where the two are the
 * same, none where the sound is in one channel only.
 */
const FRAME = 512;
const HOP = FRAME / 2;
/** How hard a difference takes a frequency out: kept is 1 − STRENGTH·|difference|²/|average|². */
const STRENGTH = 3;

interface SharedFilter {
  push(left: Int16Array, right: Int16Array): Int16Array;
}

function createSharedFilter(): SharedFilter {
  const window = new Float64Array(FRAME);
  for (let i = 0; i < FRAME; i++) window[i] = Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME));
  const fft = createFft(FRAME);
  const inL = new Float64Array(FRAME);
  const inR = new Float64Array(FRAME);
  /** How many samples of the current frame are in. The first frame starts half filled with silence. */
  let filled = HOP;
  const overlap = new Float64Array(HOP);
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  const yRe = new Float64Array(FRAME);
  const yIm = new Float64Array(FRAME);

  const frame = (out: number[]) => {
    // Both channels in one transform: left as the real part, right as the imaginary.
    for (let i = 0; i < FRAME; i++) { re[i] = inL[i] * window[i]; im[i] = inR[i] * window[i]; }
    fft(re, im, false);
    for (let k = 0; k < FRAME; k++) {
      const j = (FRAME - k) % FRAME;
      // L_k = (X_k + conj X_{N−k}) / 2, R_k = (X_k − conj X_{N−k}) / 2i.
      const lRe = (re[k] + re[j]) / 2, lIm = (im[k] - im[j]) / 2;
      const rRe = (im[k] + im[j]) / 2, rIm = (re[j] - re[k]) / 2;
      const mRe = (lRe + rRe) / 2, mIm = (lIm + rIm) / 2;
      const sRe = (lRe - rRe) / 2, sIm = (lIm - rIm) / 2;
      const m2 = mRe * mRe + mIm * mIm;
      const keep = m2 > 0 ? Math.max(0, 1 - (STRENGTH * (sRe * sRe + sIm * sIm)) / m2) : 0;
      yRe[k] = mRe * keep;
      yIm[k] = mIm * keep;
    }
    fft(yRe, yIm, true);
    for (let i = 0; i < HOP; i++) out.push(clamp16(Math.round(overlap[i] + yRe[i] * window[i])));
    for (let i = 0; i < HOP; i++) overlap[i] = yRe[HOP + i] * window[HOP + i];
    inL.copyWithin(0, HOP);
    inR.copyWithin(0, HOP);
    filled = HOP;
  };

  return {
    push(left, right) {
      const out: number[] = [];
      for (let i = 0; i < left.length; i++) {
        inL[filled] = left[i];
        inR[filled] = right[i];
        if (++filled === FRAME) frame(out);
      }
      return Int16Array.from(out);
    },
  };
}

/** An in-place radix-2 transform of `size` points; `inverse` divides by the size. */
function createFft(size: number): (re: Float64Array, im: Float64Array, inverse: boolean) => void {
  const bits = Math.log2(size);
  const reversed = new Uint32Array(size);
  for (let i = 0; i < size; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    reversed[i] = r;
  }
  const cos = new Float64Array(size / 2);
  const sin = new Float64Array(size / 2);
  for (let i = 0; i < size / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / size); sin[i] = Math.sin((2 * Math.PI * i) / size); }
  return (re, im, inverse) => {
    for (let i = 0; i < size; i++) {
      const j = reversed[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const sign = inverse ? 1 : -1;
    for (let len = 2; len <= size; len *= 2) {
      const step = size / len;
      for (let start = 0; start < size; start += len) {
        for (let k = 0; k < len / 2; k++) {
          const wRe = cos[k * step], wIm = sign * sin[k * step];
          const a = start + k, b = a + len / 2;
          const tRe = re[b] * wRe - im[b] * wIm;
          const tIm = re[b] * wIm + im[b] * wRe;
          re[b] = re[a] - tRe; im[b] = im[a] - tIm;
          re[a] += tRe; im[a] += tIm;
        }
      }
    }
    if (inverse) for (let i = 0; i < size; i++) { re[i] /= size; im[i] /= size; }
  };
}

// ── Whether a video can be taken out ────────────────────────────────────────

/**
 * A half second the video's sound is alone: heard, and the same in both channels to the last bit — its difference
 * under one step of the samples (−97 dB). Windows adds its own noise to each channel as it writes them at 16 bits, so
 * a video's difference is about −99 dB there, not none. A voice from straight ahead comes close (measured
 * 2026-10-26: mostly −70 to −90 dB, at least −94), not that close; nor a voice over the video, nor a world's own
 * sound with a place in it.
 */
const ALONE_MID_DB = -60;
const ALONE_SIDE_DB = -97;
/** That many such half seconds within the last 30 s, and the sound is in stereo at all: the video can be taken out. */
const ALONE_NEEDED = 6;
const ALONE_WITHIN = 60;
/** Once taken out, the video is over: not alone for 10 s and what the two share quiet all that while, or not alone for 30 s. */
const QUIET_SHARED_DB = -55;
const QUIET_FOR = 20;
const NOT_ALONE_FOR = 60;

export type Judgement = 'apart' | 'over' | null;

export interface VideoJudge {
  /** One half second: `apart` the first time the video can be taken out; then `over` the first time it has stopped. */
  hear(hearing: Hearing, spatialSeen: boolean): Judgement;
}

export function createVideoJudge(): VideoJudge {
  const recent: boolean[] = [];
  let apart = false;
  let over = false;
  let quiet = 0;
  let notAlone = 0;
  return {
    hear(h, spatialSeen) {
      if (over) return null;
      const alone = h.mid > ALONE_MID_DB && h.side < ALONE_SIDE_DB;
      if (!apart) {
        recent.push(alone);
        if (recent.length > ALONE_WITHIN) recent.shift();
        if (!spatialSeen || recent.filter(Boolean).length < ALONE_NEEDED) return null;
        apart = true;
        return 'apart';
      }
      notAlone = alone ? 0 : notAlone + 1;
      quiet = !alone && h.shared < QUIET_SHARED_DB ? quiet + 1 : 0;
      if (quiet < QUIET_FOR && notAlone < NOT_ALONE_FOR) return null;
      over = true;
      return 'over';
    },
  };
}
