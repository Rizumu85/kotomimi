/**
 * Fork: VRChat on the same computer, in the settings (`src/app/vrchat.ts`): whether it answers, and its settings —
 * the mute, the chatbox, a video. Shown only where VRChat runs: the desktop app on Windows. What each does is in the
 * title's help; the card itself is the controls. The chatbox is chosen from pictures of it — off, the translation,
 * the original over it, the translation over the original — and shown below as it will look, with the user's last
 * sentence, or one in their pair's languages before they have said any.
 */
import { useEffect } from 'react';
import { Ban, Gamepad2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSessionLocked } from '../../app/useRun';
import { vrchatOffered } from '../../app/vrchatHandle';
import useAudioStore from '../../stores/audioStore';
import { useProviderStore } from '../../stores/providerStore';
import { useVRChatStore, type ChatboxShows, type OnVideo } from '../../stores/vrchatStore';
import ToggleSwitch from '../Settings/shared/ToggleSwitch';
import Tooltip from '../Tooltip/Tooltip';
import './VRChat.scss';

/** The chatbox's four looks: what is shown, the translation first, and the name under its picture. */
type Look = { shows: ChatboxShows; translationFirst: boolean; words: string; lines: Array<'said' | 'translation'> };
const LOOKS: Look[] = [
  { shows: 'off', translationFirst: false, words: 'chatboxOff', lines: [] },
  { shows: 'translation', translationFirst: false, words: 'chatboxTranslation', lines: ['translation'] },
  { shows: 'both', translationFirst: false, words: 'chatboxSourceFirst', lines: ['said', 'translation'] },
  { shows: 'both', translationFirst: true, words: 'chatboxTranslationFirst', lines: ['translation', 'said'] },
];

/** "Let's go to the next world", for a chatbox shown before the user has said anything: by the language's base. */
const SAMPLE: Readonly<Record<string, string>> = {
  zh: '我们去下一个世界吧', 'zh-tw': '我們去下一個世界吧', yue: '我哋去下一個世界啦', ja: '次のワールドに行こう', ko: '다음 월드로 가자',
  en: "Let's go to the next world", es: 'Vamos al siguiente mundo', fr: 'Allons au monde suivant', de: 'Lass uns zur nächsten Welt gehen',
  it: 'Andiamo al prossimo mondo', pt: 'Vamos para o próximo mundo', ru: 'Пойдём в следующий мир',
};
const sampleIn = (code: string | undefined): string => {
  const lower = (code ?? '').toLowerCase();
  const traditional = /^zh-(tw|hk|hant)/.test(lower);
  return (traditional ? SAMPLE['zh-tw'] : SAMPLE[lower.split(/[-_]/)[0]]) ?? SAMPLE.en;
};
const ON_VIDEO: Array<[OnVideo, string]> = [['ask', 'videoAsk'], ['normal', 'videoNormal'], ['quick', 'videoQuick'], ['pause', 'videoPause']];

export function VRChatSection() {
  const { t } = useTranslation();
  const { muteGate, chatbox, chatboxTranslationFirst, onVideo, translateVideo, link, recent, setMuteGate, setChatbox, setChatboxTranslationFirst, setOnVideo, setTranslateVideo, view } = useVRChatStore();
  // The chatbox carries what the user says: with only the other side heard, it stays empty. Said under it, with the
  // way out — the mode, changed while no session runs, as the main panel changes it.
  const mode = useAudioStore((state) => state.mode);
  const setMode = useAudioStore((state) => state.setMode);
  const locked = useSessionLocked();
  const unheard = chatbox !== 'off' && mode === 'participant';
  const pair = useProviderStore((state) => (state.selected ? state.entries[state.selected]?.pair : undefined));
  const kotomimi = useProviderStore((state) => state.selected === 'localai');
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
      <div className="kt-chatbox-looks" role="group" aria-label={t('fork.vrchat.chatbox')}>
        {LOOKS.map((look) => {
          const on = chatbox === look.shows && (look.shows !== 'both' || chatboxTranslationFirst === look.translationFirst);
          return (
            <button
              key={look.words}
              type="button"
              className={`kt-chatbox-look${on ? ' is-on' : ''}`}
              aria-pressed={on}
              onClick={() => { setChatbox(look.shows); if (look.shows === 'both') setChatboxTranslationFirst(look.translationFirst); }}
            >
              <span className="kt-chatbox-look__pic" aria-hidden="true">
                {look.lines.length === 0 ? <Ban size={22} /> : (
                  <span className="kt-chatbox-look__bubble">
                    {look.lines.map((line, i) => <span key={i} className={`kt-chatbox-look__bar is-${line}`} />)}
                  </span>
                )}
              </span>
              <span className="kt-chatbox-look__name">{t(`fork.vrchat.${look.words}`)}</span>
            </button>
          );
        })}
      </div>
      {/* Nothing goes up while only the other side is heard: no picture of a chatbox, the note in its place. */}
      {chatbox !== 'off' && !unheard && (
        // As it will look above the avatar: the last sentence, or one in the pair's languages.
        <div className="kt-chatbox-preview" aria-hidden="true">
          {(LOOKS.find((look) => look.shows === chatbox && (chatbox !== 'both' || look.translationFirst === chatboxTranslationFirst))?.lines ?? []).map((line) => (
            <span key={line} className={`kt-chatbox-preview__line is-${line}`}>
              {line === 'said' ? recent?.said ?? sampleIn(pair?.source) : recent?.translation ?? sampleIn(pair?.target)}
            </span>
          ))}
        </div>
      )}
      {unheard && (
        <p className="kt-vrchat__unheard" role="status">
          <span>{t('fork.vrchat.chatboxUnheard')}</span>
          <button type="button" className="kt-vrchat__fix" onClick={() => setMode('both')} disabled={locked}>{t('fork.vrchat.chatboxHearBoth')}</button>
        </p>
      )}
      <div className="kt-vrchat__label">{t('fork.vrchat.onVideo')}</div>
      <div className="segmented-control">
        {ON_VIDEO.map(([value, words]) => (
          <button key={value} type="button" className={`segmented-option ${onVideo === value ? 'active' : ''}`} aria-pressed={onVideo === value} onClick={() => setOnVideo(value)}>
            {t(`fork.vrchat.${words}`)}
          </button>
        ))}
      </div>
      {/* Faster takes a video's sound out where it can: its words can then be translated as well. */}
      {/* Its words heard apart only by Kotomimi's own pipeline (`laneOffered`): no switch where nothing would do it. */}
      {onVideo === 'quick' && kotomimi && (
        <div className="kt-vrchat__more">
          <ToggleSwitch checked={translateVideo} onChange={() => setTranslateVideo(!translateVideo)} label={t('fork.vrchat.translateVideo')} />
        </div>
      )}
    </div>
  );
}
