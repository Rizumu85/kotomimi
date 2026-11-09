/**
 * Fork: the SteamVR overlay in the settings (`src/app/vrOverlay.ts`), a card of its own below VRChat's: the headset
 * shows captions in any SteamVR game, not only in VRChat. The strip on or off, and where SteamVR is with it, beside
 * the title; and the wrist panel's window, which a wrist tool such as XSOverlay carries. Shown where the overlay
 * runs: the desktop app on Windows. It takes the VRChat card's looks (`VRChat.scss`).
 */
import { Glasses } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { vrchatOffered } from '../../app/vrchatHandle';
import { useVrStore } from '../../stores/vrStore';
import ToggleSwitch from '../Settings/shared/ToggleSwitch';
import Tooltip from '../Tooltip/Tooltip';
import './VRChat.scss';

export function VrHeadsetSection() {
  const { t } = useTranslation();
  const vr = useVrStore();
  if (!vrchatOffered()) return null;
  const status = vr.link === 'connected' ? 'fork.vr.linkConnected' : vr.link === 'missing' ? 'fork.vr.linkMissing' : 'fork.vr.linkWaiting';

  return (
    <div className="config-section kt-vrchat" id="vr-headset-section">
      <h3>
        <Glasses size={18} />
        <span>{t('fork.vr.title')}</span>
        <Tooltip content={t('fork.vr.help')} position="top" icon="help" maxWidth={340} />
        {vr.on && <span className={`kt-vrchat__pill${vr.link === 'connected' ? ' is-on' : ''}`} role="status">{t(status)}</span>}
      </h3>
      <ToggleSwitch checked={vr.on} onChange={() => vr.setOn(!vr.on)} label={t('fork.vr.setting')} />
      <ToggleSwitch checked={vr.panel} onChange={() => vr.setPanel(!vr.panel)} label={t('fork.vr.panel')} />
    </div>
  );
}
