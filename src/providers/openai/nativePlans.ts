import type { LanguagePair } from '../../lib/provider/types';
import type { LocalAISettings } from './localai';
import { alsoSpoken, alsoInto, backInto, crossings, theirLitLanguages, theyLitOf } from './localaiDevice';
import { isApple, NATIVE_MODELS, nativeEngineOf } from './localaiNative';
import { NATIVE_TRANSLATORS, nativeTranslates } from './nativeTranslators';

export type NativePlanId = 'light' | 'balanced' | 'accurate';
export type NativeSide = 'speaker' | 'participant';
export type NativeStage = NativeSide | 'translation';
export type NativePlatform = 'darwin' | 'win32' | 'linux';
export interface PlanRecognition {
  model: string | null;
  /** All assets required, including each Apple Speech language. */
  models: string[];
  /** null means the other side may speak an unknown language. */
  languages: string[] | null;
}
export interface NativePlan {
  id: NativePlanId;
  speaker: PlanRecognition;
  participant: PlanRecognition;
  translation: string | null;
  vramMB: number;
  downloadBytes: number;
  recommended: boolean;
}
export interface NativePlanInputs {
  settings: LocalAISettings;
  pair: LanguagePair;
  platform: NativePlatform;
  memoryMB: number | null | undefined;
  lending: boolean;
  downloaded: readonly string[];
}
const base = (code: string) => code.trim().toLowerCase().split(/[-_]/)[0];
const unique = (codes: readonly string[]) => [...new Set(codes.map(base))];

/** Languages in use, independent of the capabilities of the current recognizer. */
export function nativeSideLanguages(s: LocalAISettings, pair: LanguagePair, side: NativeSide): string[] | null {
  if (side === 'speaker') return unique([pair.source, ...alsoSpoken(s, pair)]);
  return theyLitOf(s, pair.target) === 'auto' || base(pair.target) === 'auto' ? null : unique(theirLitLanguages(s, pair));
}

export function recommendedNativePlan(memoryMB: number | null | undefined, lending: boolean): NativePlanId {
  return lending || (memoryMB != null && memoryMB >= 15360) ? 'accurate'
    : memoryMB != null && memoryMB < 7680 ? 'light' : 'balanced';
}

/** One side's choice before the shared-engine constraint. */
export function planRecognizer(plan: NativePlanId, languages: readonly string[] | null, platform: NativePlatform): string | null {
  const codes = languages?.length ? unique(languages) : null;
  if (platform === 'darwin' && codes?.every((code) => NATIVE_MODELS.some((m) => m.id === `apple-speech:${code}`))) return `apple-speech:${codes[0]}`;
  const hears = (id: string) => codes !== null && codes.every((code) => NATIVE_MODELS.find((m) => m.id === id)!.languages.includes(code));
  const id = plan === 'accurate' ? 'qwen3-asr-1.7b-q8'
    : hears('x-asr-zh-en') ? 'x-asr-zh-en'
      : plan === 'light' && hears('sensevoice-small-q8') ? 'sensevoice-small-q8' : 'qwen3-asr-0.6b-q8';
  return codes === null || hears(id) ? id : NATIVE_MODELS.find((m) => !isApple(m.id) && codes.every((code) => m.languages.includes(code)))?.id ?? null;
}

export function planTranslator(plan: NativePlanId, directions: readonly LanguagePair[]): string | null {
  const serves = (id: string) => NATIVE_TRANSLATORS.find((m) => m.id === id && directions.every((d) => nativeTranslates(m, d.source, d.target)));
  return (plan === 'light' && serves('plamo-3-translate-0.8b') || serves('index-translate-2b')
    || NATIVE_TRANSLATORS.find((m) => !m.retired && directions.every((d) => nativeTranslates(m, d.source, d.target))))?.id ?? null;
}

/** Settings' explicitly selected stages, including remote stages (null). No downloaded fallback hides an unusable choice. */
export function currentNativeModels(s: LocalAISettings, pair: LanguagePair): Record<NativeStage, string | null> {
  const forSide = (side: NativeSide) => {
    if (s.asrVia !== 'device') return null;
    const language = side === 'speaker' ? pair.source : s.asrDetectOther ? 'auto' : pair.target;
    return s.asrNativeByLanguage[base(language)] ?? s.asrNativeModel;
  };
  return { speaker: forSide('speaker'), participant: forSide('participant'), translation: s.translateAt === 'device' ? s.translateNativeModel : null };
}

export function nativePlans(input: NativePlanInputs): { plans: NativePlan[]; recommended: NativePlanId; current: NativePlanId | null } {
  const { settings: s, pair, platform, downloaded } = input;
  const recommended = recommendedNativePlan(input.memoryMB, input.lending);
  const directions: LanguagePair[] = [pair, { source: s.asrDetectOther ? 'auto' : pair.target, target: pair.source },
    ...backInto(s, pair).map((source) => ({ source, target: pair.source })), ...crossings(s, pair)];
  const into = alsoInto(s, pair);
  if (into) directions.push({ source: pair.source, target: into });
  const plans = (['light', 'balanced', 'accurate'] as const).map((id): NativePlan => {
    const recognition = (side: NativeSide): PlanRecognition => {
      const languages = nativeSideLanguages(s, pair, side);
      return { model: planRecognizer(id, languages, platform), languages, models: [] };
    };
    const speaker = recognition('speaker');
    const participant = recognition('participant');
    if (speaker.model && participant.model && nativeEngineOf(speaker.model) === 'audio.cpp' && nativeEngineOf(participant.model) === 'audio.cpp') {
      const languages = speaker.languages && participant.languages ? unique([...speaker.languages, ...participant.languages]) : null;
      const known = unique([...(speaker.languages ?? []), ...(participant.languages ?? [])]);
      const candidates = [speaker.model, participant.model].sort((a, b) => NATIVE_MODELS.find((m) => m.id === b)!.bytes - NATIVE_MODELS.find((m) => m.id === a)!.bytes);
      const shared = candidates.find((candidate) => {
        const m = NATIVE_MODELS.find((m) => m.id === candidate)!;
        return known.every((code) => m.languages.includes(code)) && (languages !== null || m.detects && m.languages.length > 5);
      }) ?? NATIVE_MODELS.find((m) => !isApple(m.id) && known.every((code) => m.languages.includes(code)) && (languages !== null || m.detects && m.languages.length > 5))?.id ?? null;
      speaker.model = participant.model = shared;
    }
    for (const side of [speaker, participant]) side.models = !side.model ? [] : isApple(side.model) ? side.languages!.map((code) => `apple-speech:${code}`) : [side.model];
    const translation = planTranslator(id, directions);
    const assets = [...new Set([...speaker.models, ...participant.models, ...(translation ? [translation] : [])])];
    const catalog = [...NATIVE_MODELS, ...NATIVE_TRANSLATORS];
    return { id, speaker, participant, translation, recommended: id === recommended,
      vramMB: assets.reduce((sum, id) => sum + (catalog.find((m) => m.id === id)?.vramMB ?? 0), 0),
      downloadBytes: assets.filter((id) => !downloaded.includes(id)).reduce((sum, id) => sum + (catalog.find((m) => m.id === id)?.bytes ?? 0), 0) };
  });
  const current = currentNativeModels(s, pair);
  const matches = plans.filter((p) => p.speaker.model === current.speaker && p.participant.model === current.participant && p.translation === current.translation
    && current.speaker !== null && current.participant !== null && current.translation !== null);
  return { plans, recommended, current: matches.find((p) => p.id === recommended)?.id ?? matches[0]?.id ?? null };
}

/** Known languages the chosen model cannot hear, and a complete on-computer replacement. */
export function nativeLanguageGap(input: NativePlanInputs, side: NativeSide): { unsupported: string[]; replacement: PlanRecognition | null } {
  const languages = nativeSideLanguages(input.settings, input.pair, side);
  const id = currentNativeModels(input.settings, input.pair)[side];
  const model = NATIVE_MODELS.find((m) => m.id === id);
  if (!model) return { unsupported: [], replacement: null };
  const known = languages ?? unique(theirLitLanguages(input.settings, input.pair)).filter((code) => code !== 'auto');
  const unsupported = known.filter((code) => isApple(model.id)
    ? !NATIVE_MODELS.some((m) => m.id === `apple-speech:${code}`) || (model.id !== `apple-speech:${code}` && !input.downloaded.includes(`apple-speech:${code}`))
    : !model.languages.includes(code));
  if (languages === null && (!model.detects || model.languages.length <= 5)) unsupported.push('auto');
  const result = nativePlans(input);
  const replacement = result.plans.find((p) => p.recommended)![side];
  return { unsupported, replacement: unsupported.length && replacement.model ? replacement : null };
}

export interface NativeFit { fit: 'smooth' | 'maybe-slow' | 'cannot' | 'cpu' | null; needMB: number | null; leftMB: number | null }
export function nativeModelFit(id: string, stage: NativeStage, current: Partial<Record<NativeStage, string | null>>, memoryMB: number | null | undefined, fallingBehind: readonly string[] = []): NativeFit {
  const model = [...NATIVE_MODELS, ...NATIVE_TRANSLATORS].find((m) => m.id === id);
  const needMB = model?.vramMB ?? null;
  const others = [...new Set(Object.entries(current).filter(([key, value]) => key !== stage && value && value !== id).map(([, value]) => value!))];
  const known = memoryMB != null && Number.isFinite(memoryMB) && memoryMB >= 0;
  const sizes = others.map((id) => [...NATIVE_MODELS, ...NATIVE_TRANSLATORS].find((m) => m.id === id)?.vramMB);
  const leftMB = known && sizes.every((size) => size !== undefined) ? memoryMB! - sizes.reduce<number>((sum, size) => sum + size!, 0) : null;
  const fit = model && 'usesGpu' in model && model.usesGpu === false ? 'cpu' : isApple(id) || leftMB === null || needMB === null ? null
    : needMB > leftMB ? 'cannot' : needMB > leftMB - 6144 || fallingBehind.includes(id) ? 'maybe-slow' : 'smooth';
  return { fit, needMB, leftMB };
}
