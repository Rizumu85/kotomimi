/**
 * Fork: what the stages this computer runs itself share with Local
 * Inference (`src/providers/localInference`) — this provider's settings
 * under the names Local Inference's views read, the slots a run would
 * actually load, and its turn detection. The models themselves are chosen
 * and downloaded in the stage's own card (`LocalAIAssist`).
 */
import { useCallback, useMemo } from 'react';
import type { LegName } from '../../lib/conversation/types';
import type { LanguagePair, SettingsProps } from '../../lib/provider/types';
import { LocalInferenceTurnDetectionControls, LocalInferenceTurnDetectionHelp, LocalInferenceTurnDetectionSummary } from '../localInference/LocalInferenceTurnDetection';
import { LOCAL_INFERENCE_DEFAULTS, type LocalInferenceSettings } from '../localInference/settings';
// Type only: `localai.ts` imports these views, and a value import back would close a cycle.
import type { LocalAISettings as S } from './localai';
import { deviceChoices, deviceLanguage, deviceNeeds, type DeviceNeed } from './localaiDevice';
import { RealtimeTurnDetectionControls, RealtimeTurnDetectionHelp, RealtimeTurnDetectionSummary } from './RealtimeTurnDetection';

const FALLBACK_PAIR: LanguagePair = { source: 'ja', target: 'en' };

/** The fields of this provider's settings that are Local Inference's own, under the same names. */
const OWN_FIELDS = ['selections', 'vadThreshold', 'vadNegativeThreshold', 'vadMinSilenceDuration', 'vadMinSpeechDuration', 'vadMaxSpeechDuration'] as const;

/**
 * This provider's settings as Local Inference's views read them, and a
 * writer that takes back only the fields that are this provider's too. The
 * settings object keeps its identity while those fields do: the engine
 * adapter underneath is memoized on it.
 */
export function useDeviceSettings(settings: S, update: (patch: Partial<S>) => void): { settings: LocalInferenceSettings; update(patch: Partial<LocalInferenceSettings>): void } {
  const { selections, vadThreshold, vadNegativeThreshold, vadMinSilenceDuration, vadMinSpeechDuration, vadMaxSpeechDuration } = settings;
  const projected = useMemo<LocalInferenceSettings>(
    () => ({ ...LOCAL_INFERENCE_DEFAULTS, selections, vadThreshold, vadNegativeThreshold, vadMinSilenceDuration, vadMinSpeechDuration, vadMaxSpeechDuration }),
    [selections, vadThreshold, vadNegativeThreshold, vadMinSilenceDuration, vadMinSpeechDuration, vadMaxSpeechDuration],
  );
  const write = useCallback((patch: Partial<LocalInferenceSettings>) => {
    const own: Partial<S> = {};
    for (const field of OWN_FIELDS) if (patch[field] !== undefined) (own as Record<string, unknown>)[field] = patch[field];
    if (Object.keys(own).length > 0) update(own);
  }, [update]);
  return { settings: projected, update: write };
}

/** The slots a run would load on this computer, each once: both legs' recognizers may be the same slot. */
export function useDeviceSlots(settings: S, pair: LanguagePair, legs: readonly LegName[]): DeviceNeed[] {
  const { asrVia, translateAt, coach, coachAt, selections } = settings;
  const { source, target } = pair;
  return useMemo(() => {
    const seen = new Set<string>();
    return deviceNeeds(deviceChoices({ asrVia, translateAt, coach, coachAt, selections }), { source, target }, legs)
      .filter((need) => !seen.has(`${need.dir}|${need.stage}`) && Boolean(seen.add(`${need.dir}|${need.stage}`)));
  }, [asrVia, translateAt, coach, coachAt, selections, source, target, legs]);
}

/** Local Inference's turn-detection views over this provider's settings: the knobs of the recognizer the speaker's leg loads. */
function useDeviceTurnProps(props: SettingsProps<S>): SettingsProps<LocalInferenceSettings> {
  const device = useDeviceSettings(props.settings, props.update);
  const pair = props.pair ?? FALLBACK_PAIR;
  // A coached speaker speaks the target language: their recognizer is that direction's.
  const heard = deviceLanguage(props.settings.coach ? pair.target : pair.source);
  const other = deviceLanguage(props.settings.coach ? pair.source : pair.target);
  const devicePair = useMemo(() => ({ source: heard, target: other }), [heard, other]);
  return { settings: device.settings, update: device.update, disabled: props.disabled, pair: devicePair };
}

function DeviceTurnSummary(props: SettingsProps<S>) {
  return <LocalInferenceTurnDetectionSummary {...useDeviceTurnProps(props)} />;
}
function DeviceTurnControls(props: SettingsProps<S>) {
  return <LocalInferenceTurnDetectionControls {...useDeviceTurnProps(props)} />;
}
function DeviceTurnHelp(props: SettingsProps<S>) {
  return <LocalInferenceTurnDetectionHelp {...useDeviceTurnProps(props)} />;
}

/** Turn detection is whoever hears: this computer's own knobs, or the Realtime server's. */
export function LocalAITurnDetectionSummary(props: SettingsProps<S>) {
  return props.settings.asrVia !== 'server' ? <DeviceTurnSummary {...props} /> : <RealtimeTurnDetectionSummary {...props} />;
}
export function LocalAITurnDetectionControls(props: SettingsProps<S>) {
  return props.settings.asrVia !== 'server' ? <DeviceTurnControls {...props} /> : <RealtimeTurnDetectionControls {...props} />;
}
export function LocalAITurnDetectionHelp(props: SettingsProps<S>) {
  return props.settings.asrVia !== 'server' ? <DeviceTurnHelp {...props} /> : <RealtimeTurnDetectionHelp {...props} />;
}
