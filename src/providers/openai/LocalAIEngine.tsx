// Fork: native stage rows and turn detection, independent of the browser model catalog.
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleHelp } from 'lucide-react';
import { VadControl } from '../../components/Settings/sections/LocalSettingsControls';
import Tooltip from '../../components/Tooltip/Tooltip';
import type { LegName } from '../../lib/conversation/types';
import type { LanguagePair, SettingsProps } from '../../lib/provider/types';
import type { LocalAISettings as S } from './localai';
import type { LocalAIModel } from './localaiModels';
import { cutsSentencesHere, deviceNeeds, type DeviceNeed } from './localaiDevice';
import { RealtimeTurnDetectionControls, RealtimeTurnDetectionHelp, RealtimeTurnDetectionSummary } from './RealtimeTurnDetection';

/** One row per stage and language direction, regardless of the installed models. */
export function useNativeStageSlots(settings: S, pair: LanguagePair, legs: readonly LegName[], models: readonly LocalAIModel[]): DeviceNeed[] {
  return useMemo(() => {
    const seen = new Set<string>();
    return deviceNeeds(settings, pair, legs, models)
      .filter((need) => !seen.has(`${need.dir}|${need.stage}`) && Boolean(seen.add(`${need.dir}|${need.stage}`)));
  }, [settings, pair, legs, models]);
}

function NativeTurnSummary({ settings }: SettingsProps<S>) {
  const { t } = useTranslation();
  return <>{`${t('settings.vadSettings', 'VAD Settings')} · ${t('settings.vadMinSilenceDuration', 'Min Silence Duration')}: ${settings.vadMinSilenceDuration.toFixed(2)}s`}</>;
}

function NativeTurnHelp() {
  const { t } = useTranslation();
  return (
    <Tooltip content={t('settings.vadSettingsTooltip')} position="top">
      <CircleHelp className="tooltip-trigger" size={14} />
    </Tooltip>
  );
}

function NativeTurnControls({ settings, update, disabled = false }: SettingsProps<S>) {
  return <VadControl values={{
    vadThreshold: settings.vadThreshold,
    vadNegativeThreshold: settings.vadNegativeThreshold,
    vadMinSilenceDuration: settings.vadMinSilenceDuration,
    vadMinSpeechDuration: settings.vadMinSpeechDuration,
    vadMaxSpeechDuration: settings.vadMaxSpeechDuration,
  }} onChange={update} disabled={disabled} />;
}

export function LocalAITurnDetectionSummary(props: SettingsProps<S>) {
  return cutsSentencesHere(props.settings) ? <NativeTurnSummary {...props} /> : <RealtimeTurnDetectionSummary {...props} />;
}
export function LocalAITurnDetectionControls(props: SettingsProps<S>) {
  return cutsSentencesHere(props.settings) ? <NativeTurnControls {...props} /> : <RealtimeTurnDetectionControls {...props} />;
}
export function LocalAITurnDetectionHelp(props: SettingsProps<S>) {
  return cutsSentencesHere(props.settings) ? <NativeTurnHelp /> : <RealtimeTurnDetectionHelp {...props} />;
}
