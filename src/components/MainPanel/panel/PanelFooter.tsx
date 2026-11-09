import { useTranslation } from 'react-i18next';
import { X, Zap, Mic, Loader, Wrench } from 'lucide-react';
import ModePicker from '../ModePicker';
import SessionCountdown from '../SessionCountdown';
import { ChatboxToggle } from '../../VRChat/ChatboxToggle';
import { useLanguageLabel } from '../../../lib/language/useLanguageLabel';
import { startLabel } from './startLabel';
import type { RunState } from '../../../lib/session/types';
import type { AudioMode } from '../../../stores/audioStore';
import type { LanguagePair } from '../../../lib/provider/types';
import type { Heard } from './useHeard';

export interface PanelFooterProps {
  site: 'basic' | 'advanced';
  run: RunState;
  mode: AudioMode;
  /** Today's amber segment: 'speaker' when the speaker's leg has no microphone. */
  missingDevice: 'speaker' | null;
  canStart: boolean;
  /** A run is live under manual turns with the speaker leg live: the hold button shows. */
  holdToTalk: boolean;
  held: boolean;
  micMuted: boolean;
  pair: LanguagePair | null;
  /** Fork: the other side's language lit beside their main one: the user's speech goes into it too (`useLitLanguage`). */
  lit?: string;
  duration: string | null;
  onStart(): void;
  onStop(): void;
  onPress(): void;
  onRelease(): void;
  onModeSegment(target: AudioMode, el: HTMLElement): void;
  onLanguages(): void;
  /** Development builds: the test tone. */
  testTone?: { playing: boolean; toggle(): void };
  /** Fork: during a run, whether each captured leg hears sound (`useHeard`): a dot on its mode button. */
  heard?: Heard | null;
}

/**
 * The basic status footer and the advanced control footer, today's markup
 * verbatim (`MainPanel.tsx:4672-4766` basic, `4768-4907` advanced) over the
 * runner's own `RunState` instead of the old session booleans (1e-3 ruling
 * 16): a `stopping` run shows the same Stop variant as `running`, disabled,
 * never a disabled Start. The push-to-talk "Release" state, the mode
 * popover and the language-pair navigation are the caller's (Task 12) —
 * this component only renders what it is handed. And a leased run's
 * countdown beside the session clock (Stage 2 Kizuna Soniox). Why Start is
 * off, and a reconnecting leg's words, are the status line's (spec 2026-10-05
 * §3), not this footer's: the button carries no reason, the dot only pulses.
 */
export function PanelFooter(props: PanelFooterProps) {
  const { t } = useTranslation();
  const label = useLanguageLabel();
  const {
    site,
    run,
    mode,
    missingDevice,
    canStart,
    holdToTalk,
    held,
    micMuted,
    pair,
    lit,
    duration,
    onStart,
    onStop,
    onPress,
    onRelease,
    onModeSegment,
    onLanguages,
    testTone,
    heard,
  } = props;

  const isIdle = run.phase === 'idle';
  const isStarting = run.phase === 'starting';
  const isRunning = run.phase === 'running';
  const isRunningOrStopping = run.phase === 'running' || run.phase === 'stopping';
  const isReconnecting = run.phase === 'running' && Object.values(run.legs).includes('reconnecting');

  const statusDotClass = `status-dot ${isReconnecting ? 'reconnecting' : isRunning ? 'active' : ''}`;
  // A bidirectional pair (`zh+en`) is both ends at once: name it once, not `X → X`.
  // Fork: the other side's second language, lit by hand: the user's speech goes into it too.
  const languagePairText = !pair ? '' : pair.source === pair.target ? label(pair.source) : `${label(pair.source)} → ${label(pair.target)}${lit ? ` · ${label(lit)}` : ''}`;
  const handleActionClick = isIdle ? onStart : onStop;
  const actionDisabled = (isIdle && !canStart) || run.phase === 'stopping';

  if (site === 'basic') {
    return (
      <div className="control-footer basic">
        <span className={statusDotClass} />
        <ModePicker
          mode={mode}
          locked={!isIdle}
          missingDeviceForMode={missingDevice}
          onSegmentClick={onModeSegment}
          heard={heard}
        />
        <ChatboxToggle />

        <span className="footer-spacer" />

        <div className="action-cluster">
          {holdToTalk && (
            <button
              className={`push-to-talk-btn ${held ? 'recording' : ''}`}
              onMouseDown={onPress}
              onMouseUp={onRelease}
              onTouchStart={onPress}
              onTouchEnd={onRelease}
            >
              <Mic size={12} />
              <span className="btn-text">{held ? t('simplePanel.release', 'Release') : t('simplePanel.holdToSpeak', 'Hold')}</span>
            </button>
          )}
          <button
            data-tour="main-action"
            className={`main-action-btn ${isRunningOrStopping ? 'stop' : 'start'}`}
            onClick={handleActionClick}
            disabled={actionDisabled}
            title={isStarting ? t('mainPanel.clickToCancel', 'Click to cancel') : undefined}
          >
            {isStarting ? (
              <>
                <Loader className="spinning" size={16} />
                <span className="btn-text">{startLabel(t, run, 'basic')}</span>
              </>
            ) : isRunningOrStopping ? (
              <>
                <span className="stop-icon">■</span>
                <span className="btn-text">{t('simplePanel.stop', 'Stop')}</span>
              </>
            ) : (
              <>
                <span className="play-icon">▶</span>
                <span className="btn-text">{t('simplePanel.start', 'Start')}</span>
              </>
            )}
          </button>
        </div>

        <span className="footer-spacer" />

        <div className="footer-metadata">
          <span
            className="language-pair clickable"
            onClick={onLanguages}
            title={t('simplePanel.clickToConfigLanguages', 'Click to configure languages')}
          >
            {languagePairText}
          </span>
          {isRunning && duration && (
            <span className="session-duration">{duration}</span>
          )}
          {run.phase === 'running' && run.budget && <SessionCountdown budget={run.budget} />}
        </div>
      </div>
    );
  }

  return (
    <div className="control-footer advanced">
      <span className={statusDotClass} />

      <ModePicker
        mode={mode}
        locked={!isIdle}
        missingDeviceForMode={missingDevice}
        onSegmentClick={onModeSegment}
        heard={heard}
      />
      <ChatboxToggle />

      <span className="footer-spacer" />

      <div className="action-cluster">
        {holdToTalk && (
          <button
            className={`push-to-talk-button ${held ? 'recording' : ''}`}
            onMouseDown={onPress}
            onMouseUp={onRelease}
            disabled={micMuted}
          >
            <Mic size={14} />
            <span>
              {held ? t('mainPanel.release') : !micMuted ? t('mainPanel.pushToTalk') : t('mainPanel.inputDeviceOff')}
            </span>
          </button>
        )}
        <button
          data-tour="main-action"
          className={`session-button ${isRunningOrStopping ? 'active' : ''}`}
          onClick={handleActionClick}
          disabled={actionDisabled}
          title={isStarting ? t('mainPanel.clickToCancel', 'Click to cancel') : undefined}
        >
          {isStarting ? (
            <>
              <Loader size={14} className="spinner" />
              <span>{startLabel(t, run, 'advanced')}</span>
            </>
          ) : isRunningOrStopping ? (
            <>
              <X size={14} />
              <span>{t('mainPanel.endSession')}</span>
            </>
          ) : (
            <>
              <Zap size={14} />
              <span>{t('mainPanel.startSession')}</span>
            </>
          )}
        </button>

        {testTone && (
          <button
            className={`debug-button ${testTone.playing ? 'active' : ''}`}
            onClick={testTone.toggle}
          >
            <Wrench size={14} />
            <span>{testTone.playing ? t('mainPanel.stopDebug') : t('mainPanel.debug')}</span>
          </button>
        )}
      </div>

      <span className="footer-spacer" />

      <div className="footer-metadata">
        <span
          className="language-pair clickable"
          onClick={onLanguages}
          title={t('simplePanel.clickToConfigLanguages', 'Click to configure languages')}
        >
          {languagePairText}
        </span>
        {isRunning && duration && (
          <span className="session-duration">{duration}</span>
        )}
        {run.phase === 'running' && run.budget && <SessionCountdown budget={run.budget} />}
      </div>
    </div>
  );
}
