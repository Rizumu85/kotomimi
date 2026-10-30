import { useMemo } from 'react';
import { OutputToggles } from './sections/SpeechSection';
import SentenceSegmentationSection from './sections/SentenceSegmentationSection';
import { ProviderEngine, ProviderOwnSettings, ProviderTurnDetectionControls } from '../providers/ProviderOwnSettings';
import { ProviderLanguages } from '../providers/ProviderLanguages';
import { ProviderPicker } from '../providers/ProviderPicker';
import { useAuthContext } from '../providers/useAuthContext';
import { presentProviders } from '../../providers/registry';
import { useMode } from '../../stores/audioStore';
import { SENTENCE_SEGMENTATION_SHOWN, useEngineSlotTarget, useSetEngineSlotTarget, useTextOnly } from '../../stores/settingsStore';

/** General and Provider categories read the same provider entry and session lock. */
export function SessionSettingsGeneral({ locked }: { locked: boolean }) {
  const providers = useMemo(() => presentProviders(), []);
  const mode = useMode();
  const textOnly = useTextOnly();
  return (
    <>
      {/* Language pair and output preferences. */}
      <ProviderLanguages providers={providers} disabled={locked} sentence={{ mode, textOnly }} />
      <OutputToggles locked={locked} />
      {SENTENCE_SEGMENTATION_SHOWN && <SentenceSegmentationSection isSessionActive={locked} />}
    </>
  );
}

export function SessionSettingsProvider({ locked }: { locked: boolean }) {
  const providers = useMemo(() => presentProviders(), []);
  const auth = useAuthContext();
  const engineSlotTarget = useEngineSlotTarget();
  const setEngineSlotTarget = useSetEngineSlotTarget();
  return (
    <>
      <ProviderPicker providers={providers} auth={auth} disabled={locked} openSlot={setEngineSlotTarget} />
      <ProviderEngine providers={providers} disabled={locked} initialSlot={engineSlotTarget} onInitialSlotConsumed={() => setEngineSlotTarget(null)} />
      <ProviderOwnSettings providers={providers} auth={auth} disabled={locked} />
      {/* The provider's speech-detection Controls, where LocalInference's VAD sat before the Speech section summarized it. */}
      <ProviderTurnDetectionControls providers={providers} disabled={locked} />
    </>
  );
}
