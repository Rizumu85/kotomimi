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
 *
 * A model in `unoffered` is not offered for the language at all, though its
 * catalog entry lists it: the two SenseVoice builds that run in the page write
 * Japanese without its kana — 「今日は天気がいいので、公園に行きましょう」 came
 * out as 「日天気公演行」 (2026-10-03) — which nobody can read; and a computer
 * that had downloaded one of them for its Chinese, and nothing else, heard
 * Japanese by it without being asked. So it is never the automatic choice
 * for that language, is in no menu and no library for it, and is not said to
 * hear it to a device this computer shares with. Only a choice of it made
 * before stands — the model that hears is never another than the one a
 * person chose — and is shown, with what was found of it, until they choose
 * again. The languages it reads well are untouched. (SenseVoice-Small in the
 * native engine is another build of the model, and writes Japanese whole:
 * `localaiNative.ts`.)
 */
import type { Candidate } from './types';

interface MeasuredOrder { first: readonly string[]; last: readonly string[]; unoffered?: readonly string[] }

export const MEASURED_ASR_ORDER: Readonly<Record<string, MeasuredOrder>> = {
  ja: {
    first: ['qwen3-asr-1.7b-webgpu', 'whisper-large-v3-turbo-webgpu', 'voxtral-mini-4b-webgpu'],
    last: ['granite-speech-4.1-2b'],
    unoffered: ['sensevoice-int8', 'sensevoice-nano-int8'],
  },
};

/** Before every catalog rank, and after every one: the catalog's own are small non-negative numbers. */
const FIRST = -1000;
const LAST = 1000;

/** Whether a recognizer is offered for speech in `language`: every one is, but the ones found unusable for it. */
export const offeredFor = (id: string, language: string): boolean => !MEASURED_ASR_ORDER[language]?.unoffered?.includes(id);

/** The languages a recognizer is said to hear, of the ones its catalog entry lists. */
export const offeredLanguages = (id: string, languages: readonly string[]): string[] => languages.filter((language) => offeredFor(id, language));

/** A recognizer's candidate, ranked as measured for speech in `language`. */
export function measuredAsr(candidate: Candidate, language: string): Candidate {
  const order = MEASURED_ASR_ORDER[language];
  if (!order) return candidate;
  // Still a candidate, so that a choice of it made before resolves to it; never one the automatic choice may take.
  if (!offeredFor(candidate.id, language)) return { ...candidate, recommended: false, sortOrder: LAST + order.last.length, autoEligible: false };
  const lead = order.first.indexOf(candidate.id);
  if (lead >= 0) return { ...candidate, recommended: true, sortOrder: FIRST + lead };
  const trail = order.last.indexOf(candidate.id);
  if (trail >= 0) return { ...candidate, recommended: false, sortOrder: LAST + trail };
  return { ...candidate, recommended: false };
}

/**
 * A catalog's recognizers as the library lists them for speech in `language`: ranked as measured, the rest in the
 * order given. One not offered for the language is left out — unless it is `chosen`, the one that hears it now.
 */
export function measuredEntries<T extends { id: string; recommended?: boolean; sortOrder?: number }>(all: readonly T[], language: string, chosen = ''): T[] {
  const order = MEASURED_ASR_ORDER[language];
  if (!order) return [...all];
  const models = all.filter((model) => model.id === chosen || offeredFor(model.id, language));
  const ranked = models.map((model, at) => {
    const lead = order.first.indexOf(model.id);
    const trail = offeredFor(model.id, language) ? order.last.indexOf(model.id) : order.last.length;
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
    'sensevoice-nano-int8': 'noteSenseVoice',
  },
};

export const measuredNote = (id: string, language: string): string | undefined => MEASURED_NOTES[language]?.[id];
