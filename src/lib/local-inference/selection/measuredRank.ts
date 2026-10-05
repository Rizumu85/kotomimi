/**
 * Fork: the order this computer's recognizers are tried in, for a language
 * where they were measured on what the app is used for.
 *
 * The catalog ranks its models once for every language (`recommended`,
 * `sortOrder`), from its authors' benchmarks. For Japanese that order put
 * Cohere Transcribe first, and on real conversation it is not the best by
 * far. Measured 2026-10-05 on seven one-minute clips of Japanese VRChat talk
 * (two people at speed, a group, a voice changer), character error rate on
 * the kana reading against a reference merged from four transcripts:
 *
 *   Qwen3-ASR 1.7B 18.7 % · Whisper Large V3 Turbo 20.8 % ·
 *   Voxtral Mini 4B Realtime 27.4 % (the quickest: text 2.6 s behind the
 *   voice, where the others are 10 s behind) · Cohere Transcribe 33.1 %
 *   (a quarter of what was said left out) · Qwen3-ASR 0.6B 35.1 % ·
 *   Granite Speech 4.1 92 % (loops) · SenseVoice int8 writes no kana.
 *
 * So for the languages listed here the automatic choice follows the
 * measurement: the ones in `first` in that order, then the catalog's own
 * order, then the ones in `last` — still there to be picked by hand, and
 * still the automatic choice when nothing else is downloaded. The
 * "recommended" mark is the measurement's too: only the ones in `first`
 * carry it. A language not listed keeps the catalog's order untouched.
 *
 * The library shows the same order (`measuredEntries`), and each measured
 * model's card says what was found of it (`measuredNote`): a sentence for a
 * person choosing, not a benchmark.
 */
import type { Candidate } from './types';

interface MeasuredOrder { first: readonly string[]; last: readonly string[] }

export const MEASURED_ASR_ORDER: Readonly<Record<string, MeasuredOrder>> = {
  ja: {
    first: ['qwen3-asr-1.7b-webgpu', 'whisper-large-v3-turbo-webgpu', 'voxtral-mini-4b-webgpu'],
    last: ['granite-speech-4.1-2b', 'sensevoice-int8'],
  },
};

/** Before every catalog rank, and after every one: the catalog's own are small non-negative numbers. */
const FIRST = -1000;
const LAST = 1000;

/** A recognizer's candidate, ranked as measured for speech in `language`. */
export function measuredAsr(candidate: Candidate, language: string): Candidate {
  const order = MEASURED_ASR_ORDER[language];
  if (!order) return candidate;
  const lead = order.first.indexOf(candidate.id);
  if (lead >= 0) return { ...candidate, recommended: true, sortOrder: FIRST + lead };
  const trail = order.last.indexOf(candidate.id);
  if (trail >= 0) return { ...candidate, recommended: false, sortOrder: LAST + trail };
  return { ...candidate, recommended: false };
}

/** A catalog's recognizers as the library lists them for speech in `language`: ranked as measured, the rest in the order given. */
export function measuredEntries<T extends { id: string; recommended?: boolean; sortOrder?: number }>(models: readonly T[], language: string): T[] {
  const order = MEASURED_ASR_ORDER[language];
  if (!order) return [...models];
  const ranked = models.map((model, at) => {
    const lead = order.first.indexOf(model.id);
    const trail = order.last.indexOf(model.id);
    return { model: { ...model, recommended: lead >= 0 }, rank: lead >= 0 ? FIRST + lead : trail >= 0 ? LAST + trail : 0, at };
  });
  return ranked.sort((a, b) => a.rank - b.rank || a.at - b.at).map((r) => r.model);
}

/**
 * What was found of a model on speech in a language, as the key of a sentence
 * under `providers.localai`. Japanese: the seven clips above, 2026-10-05.
 */
export const MEASURED_NOTES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  ja: {
    'qwen3-asr-1.7b-webgpu': 'noteQwen17',
    'whisper-large-v3-turbo-webgpu': 'noteWhisperTurbo',
    'voxtral-mini-4b-webgpu': 'noteVoxtral4b',
    'cohere-transcribe-webgpu': 'noteCohere',
    'whisper-medium-webgpu': 'noteWhisperMedium',
    'qwen3-asr-0.6b-webgpu': 'noteQwen06',
    'moonshine-base-ja-quant': 'noteMoonshineJa',
    'granite-speech-4.1-2b': 'noteGranite41',
    'sensevoice-int8': 'noteSenseVoice',
  },
};

export const measuredNote = (id: string, language: string): string | undefined => MEASURED_NOTES[language]?.[id];
