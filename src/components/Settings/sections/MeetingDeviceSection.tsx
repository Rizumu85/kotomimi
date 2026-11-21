/**
 * Fork: the output device the other side's sound goes to — the spoken translation, and the user's own voice where it
 * is sent on. By itself it is the virtual cable a game or a meeting takes as its microphone (`findVirtualSpeaker`);
 * a sound card that mixes in hardware has a playback pair of its own for it, and then the user's own voice never
 * passes through software at all. Desktop only: elsewhere there is no device to choose (`appAudio.ts`).
 */
import React from 'react';
import { Send } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import Tooltip from '../../Tooltip/Tooltip';
import { useAudioMonitorDevices } from '../../../stores/audioStore';
import { useRoutingStore } from '../../../stores/routingStore';
import { isElectron } from '../../../utils/environment';

const AUTO = '';

const MeetingDeviceSection: React.FC<{ disabled?: boolean }> = ({ disabled = false }) => {
  const { t } = useTranslation();
  const devices = useAudioMonitorDevices();
  const chosen = useRoutingStore((s) => s.meetingDevice);
  const setChosen = useRoutingStore((s) => s.setMeetingDevice);
  if (!isElectron()) return null;
  const label = t('fork.voice.meetingDevice', 'Output for the other side');
  // A chosen device the system no longer lists is not in the menu: the sound goes by itself again until it is back.
  const value = chosen && devices.some((device) => device.deviceId === chosen) ? chosen : AUTO;
  return (
    <div className="config-section meeting-device-section" id="meeting-device-section">
      <h3>
        <Send size={18} />
        <span>{label}</span>
        <Tooltip content={t('fork.voice.meetingDeviceTooltip')} position="top" icon="help" maxWidth={300} />
      </h3>
      <select className="select-dropdown" aria-label={label} value={value} onChange={(e) => setChosen(e.target.value || null)} disabled={disabled}>
        <option value={AUTO}>{t('fork.voice.meetingDeviceAuto', 'Virtual microphone (automatic)')}</option>
        {devices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}
      </select>
    </div>
  );
};

export default MeetingDeviceSection;
