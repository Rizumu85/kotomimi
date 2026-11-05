/**
 * Fork: how a leg is heard, decided once for every place that hears it — this computer's engine, an API or a lent
 * phone or iPad (`DeviceHearing`), another Kotomimi (its transcription session). Each place used to work these out
 * on its own, and a fix made in one was missing in another for weeks (an audit, 2026-11-05):
 *
 * - where the sentences are cut: the user's own speech detection (`speechDetection`), in the shape each place takes;
 * - what a recognizer that cannot tell languages apart is told, where the leg is left to be detected (`toldLanguage`);
 * - the second language a recognizer that hears either of two is given beside the leg's own (`pairedLanguage`);
 * - how long one recognition may run on a model this app knows (`recognitionLimits`).
 *
 * `recognitionPaths.consistency.test.ts` holds that the settings these read are read here only.
 */
import type { LocalInferenceConfig } from '../localInference/config';
import { AUTO } from '../../lib/provider/languages';
import { APPLE_PREFIX, NATIVE_MODELS } from './localaiNative';
import type { NativeLimits } from './nativeAsr';

/** The settings that cut a leg into sentences. */
export interface SpeechDetectionSettings {
  vadThreshold: number;
  vadNegativeThreshold?: number;
  vadMinSilenceDuration: number;
  vadMinSpeechDuration: number;
  vadMaxSpeechDuration: number;
}

/**
 * The user's speech detection, as this computer's detector takes it (`vad`: this computer cuts the sentences, for
 * its own engine, an API or a lent device) and as another Kotomimi's does (`turnDetection`: it cuts them there,
 * with the same threshold and pause, not Realtime's semantic default).
 */
export function speechDetection(s: SpeechDetectionSettings): {
  vad: LocalInferenceConfig['vad'];
  turnDetection: { type: 'server_vad'; threshold: number; prefixPaddingMs: number; silenceDurationMs: number };
} {
  return {
    vad: {
      threshold: s.vadThreshold,
      minSilenceDuration: s.vadMinSilenceDuration,
      minSpeechDuration: s.vadMinSpeechDuration,
      maxSpeechDuration: s.vadMaxSpeechDuration,
      ...(s.vadNegativeThreshold ? { negativeThreshold: s.vadNegativeThreshold } : {}),
    },
    turnDetection: { type: 'server_vad', threshold: s.vadThreshold, prefixPaddingMs: 300, silenceDurationMs: Math.round(s.vadMinSilenceDuration * 1000) },
  };
}

/**
 * What a recognizer is told a leg is in. `heard`: the leg's language, or `AUTO` where it is left to be detected (the
 * other side's, or a speaker who speaks both). A recognizer that tells languages apart (`detects`) is told `AUTO`;
 * one that cannot is told the leg's own (`nominal`), and the sentence's writing names the rest (`identify.ts`).
 */
export function toldLanguage(heard: string, nominal: string, detects: boolean): string {
  return heard === AUTO && !detects ? nominal : heard;
}

const baseOf = (code: string): string => code.trim().toLowerCase().split(/[-_]/)[0];

/** The other of a pair's two languages, from the side of `told` (by base: `zh-CN` is `zh`). */
export function otherOfPair(told: string, pair: { source: string; target: string }): string {
  return baseOf(told) === baseOf(pair.source) ? pair.target : pair.source;
}

/**
 * The second language a recognizer that hears either of two is given beside `told`: the pair's other, where it has
 * both (`has`, by base code), as the Mac's recognition is given it — a sentence in the other is then known for what
 * it is, not guessed from its writing. Undefined where it lacks one, or the pair is one language. Its base code.
 */
export function pairedLanguage(told: string, pair: { source: string; target: string }, has: (language: string) => boolean): string | undefined {
  const own = baseOf(told);
  const other = baseOf(otherOfPair(told, pair));
  if (!own || own === 'auto' || !other || other === 'auto' || own === other) return undefined;
  return has(own) && has(other) ? other : undefined;
}

/**
 * How long one recognition may run on a model this app knows, wherever it runs: by its id, and — the system's own
 * recognition, which a computer names by language (`apple-speech:ja`) and a device by itself (`apple-speech`) — by
 * the language it hears. Undefined for a model this app does not know.
 */
export function recognitionLimits(model: string, language?: string): Partial<NativeLimits> | undefined {
  const named = NATIVE_MODELS.find((m) => m.id === model);
  if (named) return named.limits;
  if ((model === 'apple-speech' || model.startsWith(APPLE_PREFIX)) && language) return NATIVE_MODELS.find((m) => m.id === `${APPLE_PREFIX}${baseOf(language)}`)?.limits;
  return undefined;
}
