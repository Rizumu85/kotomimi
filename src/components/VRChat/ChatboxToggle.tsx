/**
 * Fork: VRChat's chatbox on or off from the main panel's footer, beside the mode it carries — the wrist panel's
 * button on the desktop. Off, or back to the last look that showed something (`useVRChatStore.turnChatbox`); which
 * look is the VRChat card's. Shown where VRChat runs, once the user has chosen a look there: a player who never
 * used the chatbox is not handed a switch for it.
 */
import { MessageSquareOff, MessageSquareText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { vrchatOffered } from '../../app/vrchatHandle';
import { useVRChatStore } from '../../stores/vrchatStore';
import './VRChat.scss';

export function ChatboxToggle() {
  const { t } = useTranslation();
  const on = useVRChatStore((state) => state.chatbox !== 'off');
  const used = useVRChatStore((state) => state.chatboxLast !== null);
  const turn = useVRChatStore((state) => state.turnChatbox);
  if (!vrchatOffered() || !used) return null;
  const Icon = on ? MessageSquareText : MessageSquareOff;
  return (
    <button
      type="button"
      className={`kt-chatbox-toggle${on ? ' is-on' : ''}`}
      aria-pressed={on}
      onClick={() => turn(!on)}
    >
      <Icon size={14} />
      <span>{t('fork.vrchat.chatbox')}</span>
    </button>
  );
}
