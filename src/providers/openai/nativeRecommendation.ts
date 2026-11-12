import { planRecognizer, planTranslator, recommendedNativePlan, type NativePlan, type NativeStage } from './nativePlans';

export interface NativeRecommendation {
  id: string | null;
  reason: 'lending' | 'big' | 'small' | 'default';
}

/** Advice from the plan rules. Pass the recommended plan and row stage to include cross-side engine constraints. */
export function recommendNativeModel(
  kind: 'asr' | 'translation', offered: readonly string[], memoryMB: number | null,
  lending: boolean, languages: readonly string[], context?: { plan: NativePlan; stage: NativeStage },
): NativeRecommendation {
  const plan = context?.plan.id ?? recommendedNativePlan(memoryMB, lending);
  const id = context
    ? context.stage === 'translation' ? context.plan.translation : context.plan[context.stage].model
    : kind === 'translation' ? planTranslator(plan, [])
      : planRecognizer(plan, languages.includes('auto') ? null : languages, offered.some((id) => id.startsWith('apple-speech:')) ? 'darwin' : 'win32');
  let reason: NativeRecommendation['reason'] = 'default';
  if (kind === 'asr' && plan === 'accurate') reason = lending ? 'lending' : 'big';
  if (plan === 'light' && (kind === 'translation' || id === 'sensevoice-small-q8' || id === 'x-asr-zh-en')) reason = 'small';
  return id && offered.includes(id) ? { id, reason } : { id: context ? null : offered[0] ?? null, reason: 'default' };
}
