import React from 'react';
import { AlertTriangle, Download, RefreshCw, Wrench, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  useAudioSystemStatus,
  useAudioSystemReason,
  useAudioSystemDismissed,
  useAudioSystemRetrying,
  useAudioSystemRetry,
  useAudioSystemRepairing,
  useAudioSystemRepairFailed,
  useAudioSystemRepair,
  useAudioSystemDismiss,
} from '../../stores/audioSystemStore';
import './AudioSystemBanner.scss';

/**
 * `speaks` (fork): whether the provider in use ever speaks a translation. The virtual microphone carries a spoken
 * translation into a meeting: a provider that never speaks (the fork's own, which writes subtitles) has no use for it,
 * and is told nothing of its absence. Handed in by the panel, which knows the provider: the banner loads no store of it.
 */
const AudioSystemBanner: React.FC<{ speaks?: boolean }> = ({ speaks = true }) => {
  const { t } = useTranslation();
  const status = useAudioSystemStatus();
  const reason = useAudioSystemReason();
  const dismissed = useAudioSystemDismissed();
  const retrying = useAudioSystemRetrying();
  const retry = useAudioSystemRetry();
  const repairing = useAudioSystemRepairing();
  const repairFailed = useAudioSystemRepairFailed();
  const repair = useAudioSystemRepair();
  const dismiss = useAudioSystemDismiss();

  if (status !== 'unavailable' || dismissed || !speaks) {
    return null;
  }

  const isPactlMissing = reason === 'pactl-missing';
  // macOS: the driver is installed but was never loaded; the fix is a re-sign
  // behind macOS's administrator prompt, not another retry.
  const isMacDriverNotLoaded = reason === 'mac-driver-not-loaded';
  // Fork, Windows: the driver is VB-CABLE, and it is not installed. Said as that, with the install one press away:
  // the retry asks whether to download it, as upstream's start did.
  const isVbCableMissing = reason === 'vbcable-missing';

  let body = t('audioSystem.unavailableBody');
  if (isPactlMissing) body = t('audioSystem.pactlMissingBody');
  if (isMacDriverNotLoaded) body = repairFailed ? t('audioSystem.macRepairFailedBody') : t('audioSystem.macDriverNotLoadedBody');
  if (isVbCableMissing) body = t('fork.audio.vbcableMissing');

  return (
    <div className="audio-system-banner">
      <div className="audio-system-banner-content">
        <AlertTriangle size={14} />
        <div className="audio-system-banner-text">
          <span>{body}</span>
          {isPactlMissing && (
            <code className="audio-system-banner-command">{t('audioSystem.installCommand')}</code>
          )}
        </div>
      </div>
      <div className="audio-system-banner-actions">
        {isMacDriverNotLoaded ? (
          <button
            className="retry-button"
            onClick={() => repair(t('audioSystem.macRepairPrompt'))}
            disabled={repairing}
          >
            <Wrench size={12} className={repairing ? 'spinning' : ''} />
            {repairing ? t('audioSystem.repairing') : t('audioSystem.repair')}
          </button>
        ) : (
          <button
            className="retry-button"
            onClick={() => retry()}
            disabled={retrying}
          >
            {isVbCableMissing && !retrying ? <Download size={12} /> : <RefreshCw size={12} className={retrying ? 'spinning' : ''} />}
            {isVbCableMissing ? (retrying ? t('fork.audio.vbcableInstalling') : t('fork.audio.vbcableInstall')) : retrying ? t('audioSystem.retrying') : t('audioSystem.retry')}
          </button>
        )}
        <button className="dismiss-button" onClick={dismiss} aria-label="Dismiss">
          <X size={12} />
        </button>
      </div>
    </div>
  );
};

export default AudioSystemBanner;
