/**
 * Fork: the views of the stages this computer runs itself — its model
 * management, the summary under the picker, and its turn detection. They are
 * Local Inference's own (`src/providers/localInference`), handed this
 * provider's settings under the names they read, and narrowed to the slots a
 * run would actually load: a recognizer where this computer hears, a
 * translation model where it translates, and never a voice.
 *
 * Each draws nothing while no stage is here, so a setup with every stage on
 * a server looks as it always did.
 */
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { EngineSurface } from '../../components/Settings/engine/EngineSurface';
import { StoragePage } from '../../components/Settings/engine/StoragePage';
import { useWasmEngineAdapter } from '../../components/Settings/engine/useWasmEngineAdapter';
import { ModelManagementSection } from '../../components/Settings/sections/ModelManagementSection';
import { getManifestEntry } from '../../lib/local-inference/modelManifest';
import { shortenModelName } from '../../lib/local-inference/modelName';
import { splitDirection, type Stage } from '../../lib/local-inference/selection/types';
import type { EngineProps, EngineSummaryProps, LanguagePair, SettingsProps } from '../../lib/provider/types';
import { useModelStatuses } from '../../stores/modelStore';
import { LocalInferenceTurnDetectionControls, LocalInferenceTurnDetectionHelp, LocalInferenceTurnDetectionSummary } from '../localInference/LocalInferenceTurnDetection';
import { LOCAL_INFERENCE_DEFAULTS, type LocalInferenceSettings } from '../localInference/settings';
// Type only: `localai.ts` imports these views, and a value import back would close a cycle.
import type { LocalAISettings as S } from './localai';
import { deviceChoices, deviceLanguage, deviceModelFor, deviceNeeds, type DeviceNeed } from './localaiDevice';
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
function useDeviceSettings(settings: S, update: (patch: Partial<S>) => void): { settings: LocalInferenceSettings; update(patch: Partial<LocalInferenceSettings>): void } {
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

/** The slots a run would load, each once: both legs' recognizers may be the same slot. */
function useSlots(settings: S, pair: LanguagePair, legs: EngineProps<S>['legs']): DeviceNeed[] {
  const { asrVia, translateVia, coach, selections } = settings;
  const { source, target } = pair;
  return useMemo(() => {
    const seen = new Set<string>();
    return deviceNeeds(deviceChoices({ asrVia, translateVia, coach, selections }), { source, target }, legs)
      .filter((need) => !seen.has(`${need.dir}|${need.stage}`) && Boolean(seen.add(`${need.dir}|${need.stage}`)));
  }, [asrVia, translateVia, coach, selections, source, target, legs]);
}

/** This computer's model management, for the slots a run would load. */
export function LocalAIEngine({ settings, update, disabled = false, pair = FALLBACK_PAIR, legs, initialSlot, onInitialSlotConsumed }: EngineProps<S>) {
  const device = useDeviceSettings(settings, update);
  const slots = useSlots(settings, pair, legs);
  // The catalog's own codes: the pair as Local Inference would hold it.
  const source = deviceLanguage(pair.source);
  const target = deviceLanguage(pair.target);
  const basePair = useMemo(() => ({ source, target }), [source, target]);
  const override = useMemo(() => ({ settings: device.settings, update: device.update, pair: basePair }), [device.settings, device.update, basePair]);
  const whole = useWasmEngineAdapter(disabled, override);
  const adapter = useMemo(() => {
    const dirs = [...new Set(slots.map((slot) => slot.dir))];
    return {
      ...whole,
      directions: dirs.map((dir) => { const [src, tgt] = splitDirection(dir); return { dir, src, tgt }; }),
      stagesFor: (dir: string): Stage[] => slots.filter((slot) => slot.dir === dir).map((slot) => slot.stage),
    };
  }, [whole, slots]);
  if (slots.length === 0) return null;
  return (
    <EngineSurface
      adapter={adapter}
      // Every direction listed is one a run loads: the page filters none out.
      effectiveMode="both"
      initialSlot={initialSlot ?? null}
      onInitialSlotConsumed={onInitialSlotConsumed}
      renderLibrary={(slot) => (
        <ModelManagementSection isSessionActive={disabled} stageFilter={slot.stage} direction={slot.dir} settings={device.settings} update={device.update} pair={basePair} />
      )}
      renderStorage={() => <StoragePage provider="wasm" isSessionActive={disabled} settings={device.settings} pair={basePair} />}
    />
  );
}

/** The summary under the picker: one chip per slot a run would load, naming its model, or saying none is downloaded. */
export function LocalAIEngineSummary({ settings, pair = FALLBACK_PAIR, legs, openSlot }: EngineSummaryProps<S>) {
  const { t } = useTranslation();
  const slots = useSlots(settings, pair, legs);
  // A download finishing elsewhere changes what a slot resolves to.
  const statuses = useModelStatuses();
  const chips = useMemo(() => slots.map((slot) => {
    const id = deviceModelFor(slot, settings.selections);
    const entry = id ? getManifestEntry(id) : undefined;
    return { slot, name: id ? (entry ? shortenModelName(entry.name, entry.shortName) : id) : null };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [slots, settings.selections, statuses]);
  if (chips.length === 0) return null;
  return (
    <div className="local-inference-info" data-tour="engine-chips">
      <div className="model-info">
        <div className="model-inline">
          {chips.map(({ slot, name }) => (
            <button key={`${slot.dir}|${slot.stage}`} type="button" className="model-chip" onClick={() => openSlot({ dir: slot.dir, stage: slot.stage })}>
              <span className="model-chip-label">
                {slot.stage === 'asr' ? t('providers.local_inference.modelAsr', 'ASR') : t('providers.local_inference.modelTranslation', 'MT')}
                {chips.length > 2 ? ` ${slot.dir}` : ''}
              </span>
              <span className={`model-chip-value ${name ? 'model-ok' : 'model-warn'}`}>{name ?? t('common.none', 'None')}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
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
