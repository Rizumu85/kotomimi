/**
 * Fork: VRChat on the same computer, in the settings (`src/app/vrchat.ts`): whether it answers, and the three
 * settings — the mute, the chatbox, a video. Shown only where VRChat runs: the desktop app on Windows. What each
 * does is in the title's help; the card itself is the controls.
 */
import { useEffect } from 'react';
import { Gamepad2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { vrchatOffered } from '../../app/vrchatHandle';
import { useVRChatStore, type ChatboxShows, type OnVideo } from '../../stores/vrchatStore';
import ToggleSwitch from '../Settings/shared/ToggleSwitch';
import Tooltip from '../Tooltip/Tooltip';
import './VRChat.scss';

const CHATBOX: Array<[ChatboxShows, string]> = [['off', 'chatboxOff'], ['translation', 'chatboxTranslation'], ['both', 'chatboxBoth']];
const ON_VIDEO: Array<[OnVideo, string]> = [['ask', 'videoAsk'], ['normal', 'videoNormal'], ['quick', 'videoQuick'], ['pause', 'videoPause']];

export function VRChatSection() {
  const { t } = useTranslation();
  const { muteGate, chatbox, onVideo, link, setMuteGate, setChatbox, setOnVideo, view } = useVRChatStore();
  // While the card is open the mute is asked, so that whether VRChat answers is shown as it is.
  useEffect(() => {
    if (!vrchatOffered()) return undefined;
    view(true);
    return () => view(false);
  }, [view]);
  if (!vrchatOffered()) return null;

  return (
    <div className="config-section kt-vrchat" id="vrchat-section">
      <h3>
        <Gamepad2 size={18} />
        <span>{t('fork.vrchat.title')}</span>
        <Tooltip content={t('fork.vrchat.help')} position="top" icon="help" maxWidth={340} />
        <span className={`kt-vrchat__pill${link.connected ? ' is-on' : ''}`}>{link.connected ? t('fork.vrchat.connected') : t('fork.vrchat.notConnected')}</span>
      </h3>
      {/* VRChat runs, and its service does not answer the mute: OSC is off there. */}
      {link.found && !link.connected && <p className="kt-vrchat__todo">{t('fork.vrchat.turnOnOsc')}</p>}
      <ToggleSwitch checked={muteGate} onChange={() => setMuteGate(!muteGate)} label={t('fork.vrchat.muteGate')} />
      <div className="kt-vrchat__label">{t('fork.vrchat.chatbox')}</div>
      <div className="segmented-control">
        {CHATBOX.map(([value, words]) => (
          <button key={value} type="button" className={`segmented-option ${chatbox === value ? 'active' : ''}`} aria-pressed={chatbox === value} onClick={() => setChatbox(value)}>
            {t(`fork.vrchat.${words}`)}
          </button>
        ))}
      </div>
      <div className="kt-vrchat__label">{t('fork.vrchat.onVideo')}</div>
      <div className="segmented-control">
        {ON_VIDEO.map(([value, words]) => (
          <button key={value} type="button" className={`segmented-option ${onVideo === value ? 'active' : ''}`} aria-pressed={onVideo === value} onClick={() => setOnVideo(value)}>
            {t(`fork.vrchat.${words}`)}
          </button>
        ))}
      </div>
    </div>
  );
}
