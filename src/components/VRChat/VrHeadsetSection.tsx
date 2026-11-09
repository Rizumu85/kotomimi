/**
 * Fork: the SteamVR overlay in the settings (`src/app/vrOverlay.ts`), a card of its own below VRChat's: the headset
 * shows captions in any SteamVR game, not only in VRChat. Two pictures, each pressed on or off as the chatbox's looks
 * are chosen: the captions low in the view, and the wrist panel's window, which a wrist tool such as XSOverlay
 * carries. Where SteamVR is with the captions sits beside the title while they are on. Shown where the overlay runs:
 * the desktop app on Windows. It takes the VRChat card's looks (`VRChat.scss`).
 */
import { Glasses } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { vrchatOffered } from '../../app/vrchatHandle';
import { useVrStore } from '../../stores/vrStore';
import Tooltip from '../Tooltip/Tooltip';
import './VRChat.scss';

export function VrHeadsetSection() {
  const { t } = useTranslation();
  const vr = useVrStore();
  if (!vrchatOffered()) return null;
  const status = vr.link === 'connected' ? 'fork.vr.linkConnected' : vr.link === 'missing' ? 'fork.vr.linkMissing' : 'fork.vr.linkWaiting';
  const parts = [
    { key: 'strip', on: vr.on, turn: () => vr.setOn(!vr.on), words: 'fork.vr.strip' },
    { key: 'wrist', on: vr.panel, turn: () => vr.setPanel(!vr.panel), words: 'fork.vr.wrist' },
  ];

  return (
    <div className="config-section kt-vrchat" id="vr-headset-section">
      <h3>
        <Glasses size={18} />
        <span>{t('fork.vr.title')}</span>
        <Tooltip content={t('fork.vr.help')} position="top" icon="help" maxWidth={340} />
        {vr.on && <span className={`kt-vrchat__pill${vr.link === 'connected' ? ' is-on' : ''}`} role="status">{t(status)}</span>}
      </h3>
      <div className="kt-chatbox-looks kt-vr-parts">
        {parts.map((part) => (
          <button key={part.key} type="button" className={`kt-chatbox-look${part.on ? ' is-on' : ''}`} aria-pressed={part.on} onClick={part.turn}>
            <span className={`kt-chatbox-look__pic kt-vr-part is-${part.key}`} aria-hidden="true">
              {part.key === 'strip' ? (
                <span className="kt-vr-part__strip">
                  <span className="kt-chatbox-look__bar" />
                  <span className="kt-chatbox-look__bar is-translation" />
                </span>
              ) : (
                <span className="kt-vr-part__wrist">
                  <span className="kt-vr-part__key is-on" />
                  <span className="kt-vr-part__key" />
                  <span className="kt-vr-part__key" />
                  <span className="kt-vr-part__key" />
                </span>
              )}
            </span>
            <span className="kt-chatbox-look__name">{t(part.words)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
