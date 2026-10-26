/**
 * Fork: a video begun in VRChat (`src/app/vrchat.ts`) — the question, where the user is asked, and what was chosen,
 * with its end. Two looks: under the conversation in the main window (`VideoPrompt`), and in the subtitle strip
 * (`VideoPill`), the strip's own buttons; with the strip passing the mouse through, a mark that cannot be pressed
 * (`VideoMark`). With its words heard apart, the strip shows the last of them above the captions (`VideoLine`).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { vrchatController } from '../../app/vrchatHandle';
import type { Entry } from '../../lib/projection/types';
import { useVRChatStore, type VideoState } from '../../stores/vrchatStore';
import './VRChat.scss';

type Choice = 'quick' | 'pause' | 'normal';
const CHOICES: Array<[Choice, string]> = [['quick', 'videoQuick'], ['pause', 'videoPause'], ['normal', 'videoNormal']];

/** What is on, in a word or two: paused, faster — and, faster, the video's sound taken out, or heard apart. */
function onWords(video: Extract<VideoState, { kind: 'on' }>, t: TFunction): string {
  if (video.pace === 'paused') return t('fork.vrchat.pausedOn');
  if (video.apart === 'separated') return t('fork.vrchat.separatedOn');
  if (video.apart === 'removed') return t('fork.vrchat.removedOn');
  return t('fork.vrchat.quickOn');
}

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
      <span className="kt-video__btn is-go"><span className="kt-video__play" />{onWords(video, t)}</span>
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
          <span className="subtitle-bar__btn kt-video-pill__btn active">{onWords(video, t)}</span>
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
      <span className="kt-video__play" />{onWords(video, t)}
    </div>
  );
}

/** Above the captions, while the video's words are heard apart: the last of them — this video's — small and faint. */
export function VideoLine({ entries }: { entries: readonly Entry[] }) {
  const origin = useVRChatStore((state) => (state.video.kind === 'on' && state.video.apart === 'separated' ? state.video.laneOrigin : undefined));
  // An exchange's id names its stated origin (`project.ts`): an earlier video's words are not this one's.
  const last = origin ? entries.filter((entry) => entry.id.includes(`:o:${origin}`)).pop() : undefined;
  if (last?.kind !== 'exchange') return null;
  const rows = last.translation.length > 0 ? last.translation : last.source;
  const text = rows.map((row) => row.text).join('').trim();
  if (!text) return null;
  return (
    <div className="kt-video-line" aria-hidden="true">
      <span className="kt-video__play kt-video__play--dim" />{text}
    </div>
  );
}
