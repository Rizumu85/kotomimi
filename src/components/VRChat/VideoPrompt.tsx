/**
 * Fork: a video begun in VRChat (`src/app/vrchat.ts`) — the question, where the user is asked, and what was chosen,
 * with its end. Two looks: under the conversation in the main window (`VideoPrompt`), and in the subtitle strip
 * (`VideoPill`), the strip's own buttons; with the strip passing the mouse through, a mark that cannot be pressed
 * (`VideoMark`).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { vrchatController } from '../../app/vrchatHandle';
import { useVRChatStore } from '../../stores/vrchatStore';
import './VRChat.scss';

type Choice = 'quick' | 'pause' | 'normal';
const CHOICES: Array<[Choice, string]> = [['quick', 'videoQuick'], ['pause', 'videoPause'], ['normal', 'videoNormal']];

/** Under the conversation: the question with its three answers and "remember", or what is on with its end. */
export function VideoPrompt() {
  const { t } = useTranslation();
  const video = useVRChatStore((state) => state.video);
  const [remember, setRemember] = useState(false);
  if (video.kind === 'none') return null;
  if (video.kind === 'asking') {
    return (
      <div className="kt-video" role="status">
        <b className="kt-video__title"><span className="kt-video__play" />{t('fork.vrchat.videoStarted')}</b>
        <div className="kt-video__acts">
          {CHOICES.map(([choice, words]) => (
            <button key={choice} type="button" className={`kt-video__btn${choice === 'quick' ? ' is-go' : ''}`} onClick={() => vrchatController()?.answer(choice, remember)}>
              {t(`fork.vrchat.${words}`)}
            </button>
          ))}
          <label className="kt-video__remember">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            {t('fork.vrchat.remember')}
          </label>
        </div>
      </div>
    );
  }
  return (
    <div className="kt-video-on" role="status">
      <span className="kt-video__btn is-go"><span className="kt-video__play" />{video.pace === 'quick' ? t('fork.vrchat.quickOn') : t('fork.vrchat.pausedOn')}</span>
      <button type="button" className="kt-video__btn" onClick={() => vrchatController()?.endVideo()}>{t('fork.vrchat.end')}</button>
    </div>
  );
}

/** In the subtitle strip, after its time: the strip's own buttons, the suggested one in its "on" tint. */
export function VideoPill() {
  const { t } = useTranslation();
  const video = useVRChatStore((state) => state.video);
  if (video.kind === 'none') return null;
  return (
    <span className="kt-video-pill" role="status">
      <span className="subtitle-bar__divider" aria-hidden="true" />
      {video.kind === 'asking' ? (
        <>
          <span className="kt-video-pill__label"><span className="kt-video__play" />{t('fork.vrchat.videoShort')}</span>
          {CHOICES.map(([choice, words]) => (
            <button key={choice} type="button" className={`subtitle-bar__btn kt-video-pill__btn${choice === 'quick' ? ' active' : ''}`} onClick={() => vrchatController()?.answer(choice, false)}>
              {t(`fork.vrchat.${words}`)}
            </button>
          ))}
        </>
      ) : (
        <>
          <span className="subtitle-bar__btn kt-video-pill__btn active">{video.pace === 'quick' ? t('fork.vrchat.quickOn') : t('fork.vrchat.pausedOn')}</span>
          <button type="button" className="subtitle-bar__btn kt-video-pill__btn" onClick={() => vrchatController()?.endVideo()}>{t('fork.vrchat.end')}</button>
        </>
      )}
    </span>
  );
}

/** Over the captions while the strip passes the mouse through: what is on, faint, not to be pressed. */
export function VideoMark() {
  const { t } = useTranslation();
  const video = useVRChatStore((state) => state.video);
  if (video.kind !== 'on') return null;
  return (
    <div className="kt-video-mark" aria-hidden="true">
      <span className="kt-video__play" />{video.pace === 'quick' ? t('fork.vrchat.quickOn') : t('fork.vrchat.pausedOn')}
    </div>
  );
}
