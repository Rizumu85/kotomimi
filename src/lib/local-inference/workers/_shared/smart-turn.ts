/**
 * Fork: what Smart Turn (pipecat-ai/smart-turn-v3) is given — the last eight seconds of sound at 16 kHz as Whisper's
 * log-mel features, 80 bands by 800 frames — and how its answer is read. The model hears whether a speaker has
 * finished, by the voice and not by the words: a recognizer that writes no closing word is no hindrance to it.
 *
 * The features are Whisper's own, as its reference extractor computes them (a periodic Hann window of 400 samples
 * every 160, the power spectrum through Slaney's mel bands, log10, floored eight below the peak, scaled), over sound
 * brought to zero mean and unit variance: the model was trained on exactly that.
 */

export const TURN_RATE = 16000;
export const TURN_SECONDS = 8;
export const TURN_SAMPLES = TURN_RATE * TURN_SECONDS;
export const TURN_BANDS = 80;
export const TURN_FRAMES = TURN_SAMPLES / 160;

const WINDOW = 400;
const HOP = 160;
const BINS = WINDOW / 2 + 1;

const hann = Float32Array.from({ length: WINDOW }, (_, n) => 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / WINDOW));
const cosines = Float32Array.from({ length: WINDOW }, (_, n) => Math.cos((2 * Math.PI * n) / WINDOW));
const sines = Float32Array.from({ length: WINDOW }, (_, n) => Math.sin((2 * Math.PI * n) / WINDOW));

/**
 * The spectrum of one window, by its factors (400 = 2·2·2·2·5·5): the transform of every `p`-th sample, `p` times
 * over, then put together. A sum over all 400 samples for each of 201 bins took most of the time a check has.
 */
function spectrum(n: number, from: Float32Array, at: number, step: number, re: Float32Array, im: Float32Array, to: number): void {
  if (n === 1) {
    re[to] = from[at];
    im[to] = 0;
    return;
  }
  const p = n % 2 === 0 ? 2 : 5;
  const m = n / p;
  for (let q = 0; q < p; q += 1) spectrum(m, from, at + q * step, step * p, re, im, to + q * m);
  const turn = WINDOW / n;
  const around = WINDOW / p;
  for (let k = 0; k < m; k += 1) {
    for (let q = 0; q < p; q += 1) {
      const angle = (q * k * turn) % WINDOW;
      const [a, b] = [re[to + q * m + k], im[to + q * m + k]];
      partRe[q] = a * cosines[angle] + b * sines[angle];
      partIm[q] = b * cosines[angle] - a * sines[angle];
    }
    for (let r = 0; r < p; r += 1) {
      let sumRe = 0;
      let sumIm = 0;
      for (let q = 0; q < p; q += 1) {
        const angle = (q * r * around) % WINDOW;
        sumRe += partRe[q] * cosines[angle] + partIm[q] * sines[angle];
        sumIm += partIm[q] * cosines[angle] - partRe[q] * sines[angle];
      }
      re[to + r * m + k] = sumRe;
      im[to + r * m + k] = sumIm;
    }
  }
}
const partRe = new Float64Array(5);
const partIm = new Float64Array(5);

/** Slaney's mel scale: linear below 1 kHz, logarithmic above. */
const hzToMel = (hz: number) => (hz < 1000 ? (3 * hz) / 200 : 15 + Math.log(hz / 1000) / (Math.log(6.4) / 27));
const melToHz = (mel: number) => (mel < 15 ? (200 * mel) / 3 : 1000 * Math.exp((Math.log(6.4) / 27) * (mel - 15)));

/** Each band's weights over the spectrum's bins, as (first bin, weights): triangles of equal area. */
const bands: { from: number; weights: Float32Array }[] = (() => {
  const top = hzToMel(TURN_RATE / 2);
  const edges = Array.from({ length: TURN_BANDS + 2 }, (_, i) => melToHz((top * i) / (TURN_BANDS + 1)));
  return Array.from({ length: TURN_BANDS }, (_, band) => {
    const [low, mid, high] = [edges[band], edges[band + 1], edges[band + 2]];
    const all = Array.from({ length: BINS }, (_, bin) => {
      const hz = (bin * TURN_RATE) / WINDOW;
      return (Math.max(0, Math.min((hz - low) / (mid - low), (high - hz) / (high - mid))) * 2) / (high - low);
    });
    const from = all.findIndex((weight) => weight > 0);
    const to = all.length - [...all].reverse().findIndex((weight) => weight > 0);
    return from < 0 ? { from: 0, weights: new Float32Array(0) } : { from, weights: Float32Array.from(all.slice(from, to)) };
  });
})();

/** The model's input for the end of `audio` (16 kHz): its last eight seconds, silence before a shorter one. */
export function turnFeatures(audio: Float32Array): Float32Array {
  const sound = new Float32Array(TURN_SAMPLES);
  const kept = audio.length > TURN_SAMPLES ? audio.subarray(audio.length - TURN_SAMPLES) : audio;
  sound.set(kept, TURN_SAMPLES - kept.length);
  let mean = 0;
  for (let i = 0; i < TURN_SAMPLES; i += 1) mean += sound[i];
  mean /= TURN_SAMPLES;
  let variance = 0;
  for (let i = 0; i < TURN_SAMPLES; i += 1) variance += (sound[i] - mean) ** 2;
  const scale = 1 / Math.sqrt(variance / TURN_SAMPLES + 1e-7);
  for (let i = 0; i < TURN_SAMPLES; i += 1) sound[i] = (sound[i] - mean) * scale;

  const features = new Float32Array(TURN_BANDS * TURN_FRAMES);
  const frame = new Float32Array(WINDOW);
  const power = new Float32Array(BINS);
  const re = new Float32Array(WINDOW);
  const im = new Float32Array(WINDOW);
  let peak = -Infinity;
  // The frames that lie wholly in the silence before a shorter sound are one and the same: computed once.
  const pad = TURN_SAMPLES - kept.length;
  const same = pad >= WINDOW / 2 ? Math.floor((pad - WINDOW / 2) / HOP) + 1 : 0;
  for (let t = 0; t < TURN_FRAMES; t += 1) {
    if (t > 0 && t < same) {
      for (let band = 0; band < TURN_BANDS; band += 1) features[band * TURN_FRAMES + t] = features[band * TURN_FRAMES];
      continue;
    }
    // Centred on the frame's first sample, the sound mirrored past either end.
    for (let n = 0; n < WINDOW; n += 1) {
      let at = t * HOP + n - WINDOW / 2;
      if (at < 0) at = -at;
      else if (at >= TURN_SAMPLES) at = 2 * (TURN_SAMPLES - 1) - at;
      frame[n] = sound[at] * hann[n];
    }
    spectrum(WINDOW, frame, 0, 1, re, im, 0);
    for (let k = 0; k < BINS; k += 1) power[k] = re[k] * re[k] + im[k] * im[k];
    for (let band = 0; band < TURN_BANDS; band += 1) {
      const { from, weights } = bands[band];
      let energy = 0;
      for (let i = 0; i < weights.length; i += 1) energy += weights[i] * power[from + i];
      const log = Math.log10(Math.max(energy, 1e-10));
      features[band * TURN_FRAMES + t] = log;
      if (log > peak) peak = log;
    }
  }
  for (let i = 0; i < features.length; i += 1) features[i] = (Math.max(features[i], peak - 8) + 4) / 4;
  return features;
}

/** The model says so at this and above. Its own default is 0.5; a sentence cut in two costs more than one ended late. */
export const TURN_THRESHOLD = 0.6;
