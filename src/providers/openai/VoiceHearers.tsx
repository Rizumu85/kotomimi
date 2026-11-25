/**
 * Fork: who hears a translation read aloud as it comes, in the voice stage's card — one choice: nobody (a line is
 * still read when its speaker button is pressed), the user (the monitor, on their own output device), the other side
 * (the virtual microphone a game or a meeting takes as its microphone), or both. Sent to the other side, one switch
 * more says whether the user's own voice goes there with it, and each side has a volume. The choice is the stage's `auto` and the app's own
 * routing (`audioStore`, `routingStore`): the Audio settings show the same state, with the devices. An option that
 * cannot act is dimmed, the row's tip says why, and what is missing offers its fix under it.
 */
import { Download, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import ToggleSwitch from '../../components/Settings/shared/ToggleSwitch';
import Tooltip from '../../components/Tooltip/Tooltip';
import useAudioStore, { useIsMonitorChannelInScope, useIsMonitorMuted, useSetMonitorMuted } from '../../stores/audioStore';
import { useAudioSystemReason, useAudioSystemRetry, useAudioSystemRetrying, useAudioSystemStatus } from '../../stores/audioSystemStore';
import { useRoutingStore } from '../../stores/routingStore';
import { useTurnModeStore } from '../../stores/turnModeStore';

export type Hearers = 'none' | 'me' | 'them' | 'both';
export const HEARERS: readonly Hearers[] = ['none', 'me', 'them', 'both'];

/**
 * The choice shown: what is set to speak along, by who can hear it now. Null: set to speak, with nobody able to hear
 * it (the user's own output is not allowed now, and nothing goes to the other side) — none of the four is lit, and
 * "off" can still be chosen, which stops the sentences being made.
 */
export function hearersOf(auto: boolean, me: boolean, them: boolean): Hearers | null {
  if (!auto) return 'none';
  return me && them ? 'both' : them ? 'them' : me ? 'me' : null;
}

/** One volume, 0 to 1, on one line: its name, the slider, its percentage. */
function Volume({ label, value, onChange }: { label: string; value: number; onChange(value: number): void }) {
  return (
    <div className="kt-voice__volume">
      <span className="kt-voice__volume-name">{label}</span>
      <input type="range" min="0" max="1" step="0.05" value={value} aria-label={label} onChange={(e) => onChange(parseFloat(e.target.value))} />
      <span className="kt-voice__volume-value">{Math.round(value * 100)}%</span>
    </div>
  );
}

export function VoiceHearers({ auto, onAuto, locked }: {
  auto: boolean;
  onAuto(next: boolean): void;
  /** A session runs: whether it speaks along is settled, who hears it is still the routing's, read live. */
  locked?: boolean;
}) {
  const { t } = useTranslation();
  const monitorMuted = useIsMonitorMuted();
  const setMonitorMuted = useSetMonitorMuted();
  const monitorAllowed = useIsMonitorChannelInScope();
  const meeting = useRoutingStore((s) => s.meeting);
  const setMeeting = useRoutingStore((s) => s.setMeeting);
  const volumeMine = useRoutingStore((s) => s.speechVolumeMine);
  const setVolumeMine = useRoutingStore((s) => s.setSpeechVolumeMine);
  const volumeTheirs = useRoutingStore((s) => s.speechVolumeTheirs);
  const setVolumeTheirs = useRoutingStore((s) => s.setSpeechVolumeTheirs);
  const passthrough = useAudioStore((s) => s.isRealVoicePassthroughEnabled);
  const togglePassthrough = useAudioStore((s) => s.toggleRealVoicePassthrough);
  const setPassthroughVolume = useAudioStore((s) => s.setRealVoicePassthroughVolume);
  const pushToTranslate = useTurnModeStore((s) => s.turnMode === 'push-to-translate');
  // The virtual microphone: a driver the system may not have (VB-CABLE on Windows).
  const status = useAudioSystemStatus();
  const reason = useAudioSystemReason();
  const retry = useAudioSystemRetry();
  const retrying = useAudioSystemRetrying();
  // …unless the sound goes to a device of the user's own choosing (`MeetingDeviceSection`), which needs no driver.
  const chosenDevice = useRoutingStore((s) => s.meetingDevice);
  const noVirtual = status === 'unavailable' && !chosenDevice;
  const installs = reason === 'vbcable-missing';

  const value = hearersOf(auto, !monitorMuted && monitorAllowed, meeting && !noVirtual);
  const label = t('fork.voice.hearers', 'Read my translations aloud');
  const names: Record<Hearers, string> = {
    none: t('fork.voice.hearNone', 'Off'),
    me: t('fork.voice.hearMe', 'To me'),
    them: t('fork.voice.hearThem', 'To them'),
    both: t('fork.voice.hearBoth', 'To both'),
  };
  const cannot = (option: Hearers) => {
    if (locked && (option === 'none') !== !auto) return true;
    if ((option === 'me' || option === 'both') && !monitorAllowed) return true;
    return (option === 'them' || option === 'both') && noVirtual;
  };
  /** Why a dimmed option cannot be chosen: said when the pointer rests on it, and nowhere else. */
  const why = (option: Hearers): string | undefined => {
    if ((option === 'me' || option === 'both') && !monitorAllowed) return t('fork.voice.toMeLocked');
    if ((option === 'them' || option === 'both') && noVirtual) return installs ? t('fork.audio.vbcableMissing') : t('audioSystem.unavailableBody');
    return undefined;
  };
  const pick = (option: Hearers) => {
    if (option === 'none') { onAuto(false); return; }
    if (!auto) onAuto(true);
    setMonitorMuted(option === 'them');
    setMeeting(option !== 'me');
  };
  const toThem = value === 'them' || value === 'both';
  return (
    <div className="kt-voice__hearers">
      <div className="kt-field">
        <span className="kt-field__label">
          {label}
          <Tooltip
            position="top"
            icon="help"
            maxWidth={300}
            content={t('fork.voice.toThemTooltip')}
          />
        </span>
        <div className="kt-seg" role="group" aria-label={label}>
          {HEARERS.map((option) => {
            const off = cannot(option);
            const reason = off ? why(option) : undefined;
            // One that says why stays reachable by the pointer (a disabled button is not): dimmed, and pressing it does nothing.
            const button = (
              <button key={option} type="button" className={`kt-seg__option${option === value ? ' is-active' : ''}`} aria-pressed={option === value} onClick={() => { if (!off && option !== value) pick(option); }} {...(reason ? { 'aria-disabled': true } : { disabled: off })}>
                {names[option]}
              </button>
            );
            return reason ? <Tooltip key={option} content={reason} position="top" maxWidth={300}>{button}</Tooltip> : button;
          })}
        </div>
      </div>
      {noVirtual && (
        <div className="kt-engine kt-engine--failed" role="status">
          <span>{installs ? t('fork.audio.vbcableMissing') : t('audioSystem.unavailableBody')}</span>
          <button type="button" className="kt-there__switch" onClick={() => { void retry(); }} disabled={retrying}>
            {installs && !retrying ? <Download size={12} /> : <RefreshCw size={12} className={retrying ? 'kt-engine__spin' : undefined} />}
            <span>{installs ? (retrying ? t('fork.audio.vbcableInstalling') : t('fork.audio.vbcableInstall')) : retrying ? t('audioSystem.retrying') : t('audioSystem.retry')}</span>
          </button>
        </div>
      )}
      {/* How loud the voice is on each side, moved while it speaks. The user's own is there whoever hears the
          run: a line read on demand and a sample are theirs alone. */}
      <div className="kt-voice__volumes">
        <Volume label={t('fork.voice.volumeMine', 'Volume for me')} value={volumeMine} onChange={setVolumeMine} />
        {toThem && <Volume label={t('fork.voice.volumeTheirs', 'Volume for them')} value={volumeTheirs} onChange={setVolumeTheirs} />}
      </div>
      {/* Shown too wherever the voice is going there already (turned on here before, or under another provider):
          what the other side hears of the user is never out of sight. */}
      {(toThem || passthrough) && (
        <ToggleSwitch
          checked={passthrough || pushToTranslate}
          // Turned on here it goes at the level it was said: the translation follows the voice, it is not laid over it.
          onChange={() => { if (!passthrough) setPassthroughVolume(1); togglePassthrough(); }}
          label={t('fork.voice.myVoiceToo', 'My own voice goes too')}
          disabled={pushToTranslate}
          tooltip={t('fork.voice.myVoiceTooTooltip')}
        />
      )}
    </div>
  );
}
