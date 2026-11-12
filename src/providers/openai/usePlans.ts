/**
 * Fork: the plans for this computer (`nativePlans.ts`) as a view reads them: from the provider's settings and pair,
 * this computer's memory and lending (`useNativeRecommendationInputs`), what is downloaded, and the platform. One
 * place for every view that shows the plans, a model's fit or a side's gap, so they agree.
 */
import { useMemo } from 'react';
import type { LanguagePair } from '../../lib/provider/types';
import { isMacOS, isWindows } from '../../utils/environment';
import { useNativeEngineStore, useNativeTranslatorStore } from '../../stores/nativeEngineStore';
import { LOCALAI_DEFAULTS, type LocalAISettings } from './localai';
import { NATIVE_MODELS, nativeDownloaded } from './localaiNative';
import { NATIVE_TRANSLATORS } from './nativeTranslators';
import { currentNativeModels, nativeLanguageGap, nativePlans, type NativePlan, type NativePlanId, type NativePlanInputs, type NativePlatform, type NativeSide, type PlanRecognition } from './nativePlans';
import { useNativeRecommendationInputs } from './useNativeRecommendationInputs';

const CATALOG = [...NATIVE_MODELS, ...NATIVE_TRANSLATORS];
/** A model's name as the plans and notes say it: its catalog name, without the file format. */
export const nativeName = (id: string | null): string => (id ? (CATALOG.find((m) => m.id === id)?.name ?? id).replace(/ GGUF$/, '') : '—');

const platformNow = (): NativePlatform => (isMacOS() ? 'darwin' : isWindows() ? 'win32' : 'linux');

/** The inputs of the plans, as they stand. `memoryMB` undefined: not answered yet. */
export function usePlanInputs(settings: LocalAISettings, pair: LanguagePair): NativePlanInputs {
  const { memoryMB, lending } = useNativeRecommendationInputs();
  const heard = useNativeEngineStore((s) => s.status);
  const translated = useNativeTranslatorStore((s) => s.status);
  const downloaded = useMemo(() => [
    ...NATIVE_MODELS.filter((m) => nativeDownloaded(heard, m.id)).map((m) => m.id),
    ...NATIVE_TRANSLATORS.filter((m) => nativeDownloaded(translated, m.id)).map((m) => m.id),
  ], [heard, translated]);
  return useMemo(() => ({ settings, pair, platform: platformNow(), memoryMB, lending, downloaded }), [settings, pair, memoryMB, lending, downloaded]);
}

/** The three plans, the recommended one and the one the settings match (null: custom). */
export function usePlans(settings: LocalAISettings, pair: LanguagePair) {
  const inputs = usePlanInputs(settings, pair);
  const result = useMemo(() => nativePlans(inputs), [inputs]);
  return { ...result, inputs };
}

const NO_PAIR: LanguagePair = { source: 'en', target: 'en' };

/**
 * Each side's languages its recognizer on this computer does not hear, with what hears it now and the model that would
 * hear them all (`nativeLanguageGap`). Null for a provider other than Kotomimi's, or a side with nothing missing.
 */
export function useHearingGaps(settings: LocalAISettings | null, pair: LanguagePair | null): Record<'speaker' | 'participant', HearingGapOf | null> {
  const inputs = usePlanInputs(settings ?? LOCALAI_DEFAULTS, pair ?? NO_PAIR);
  return useMemo(() => {
    if (!settings || !pair) return { speaker: null, participant: null };
    const current = currentNativeModels(settings, pair);
    const of = (side: NativeSide): HearingGapOf | null => {
      const { unsupported, replacement } = nativeLanguageGap(inputs, side);
      return unsupported.length && replacement?.model && current[side] ? { codes: unsupported, by: current[side]!, to: replacement.model, replacement } : null;
    };
    return { speaker: of('speaker'), participant: of('participant') };
  }, [inputs, settings, pair]);
}

export interface HearingGapOf { codes: string[]; by: string; to: string; replacement: PlanRecognition }

/**
 * The plan named (null: the recommended one) for the provider's settings as stored, outside React: what the setup's
 * Finish puts to use once it has written them.
 */
export async function planFromStores(id: NativePlanId | null): Promise<NativePlan | null> {
  const { useProviderStore } = await import('../../stores/providerStore');
  const { useLanStore } = await import('../../stores/lanStore');
  const entry = useProviderStore.getState().entries.localai;
  if (!entry) return null;
  const api = (window as unknown as { electron?: { invoke(channel: string): Promise<unknown> } }).electron;
  const memory = await api?.invoke('model-memory:get').catch(() => null);
  const heard = useNativeEngineStore.getState().status;
  const translated = useNativeTranslatorStore.getState().status;
  const downloaded = [...NATIVE_MODELS.filter((m) => nativeDownloaded(heard, m.id)).map((m) => m.id), ...NATIVE_TRANSLATORS.filter((m) => nativeDownloaded(translated, m.id)).map((m) => m.id)];
  const result = nativePlans({ settings: entry.settings as unknown as LocalAISettings, pair: entry.pair, platform: platformNow(), memoryMB: typeof memory === 'number' ? memory : null, lending: useLanStore.getState().enabled, downloaded });
  return result.plans.find((p) => p.id === (id ?? result.recommended)) ?? null;
}
