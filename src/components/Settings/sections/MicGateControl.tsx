/**
 * Fork: the microphone's activation threshold, under the noise suppression
 * in the microphone section — as VRChat has it: a slider over a meter of
 * the microphone's own level, so that the mark is set by looking, between
 * where the bar sits while the loudspeakers alone are heard and where it
 * reaches when the user speaks (`src/lib/audio/capture/micGate.ts`).
 *
 * The meter reads what the microphone source reports (`micLevel.ts`): a
 * run's, while one holds the microphone; otherwise the section's own test,
 * started with the microphone button — not before: some drivers refuse to
 * open one device twice, so a test never runs beside a run, and ends by
 * itself when one starts, or after a couple of minutes.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { Mic } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import Tooltip from '../../Tooltip/Tooltip';
import { useMicGateThreshold, useSetMicGateThreshold } from '../../../stores/audioStore';
import { micLevel } from '../../../lib/audio/micLevel';
import { micSettings } from '../../../lib/audio/appCapture';
import { openMic } from '../../../lib/audio/capture/mic';
import { describeCause, reportWarning } from '../../../lib/diagnostics/report';
import type { Source } from '../../../lib/session/source';
import './MicGateControl.scss';

/** The section's own test ends by itself after this long: a microphone left open is an indicator lit for nothing. */
export const MIC_TEST_MOST_MS = 120_000;

export interface MicGateControlProps {
  /** A run holds the microphone: its level is what the meter shows, and no test is offered. */
  isSessionActive: boolean;
  /** The section is locked: the threshold cannot be moved. */
  disabled?: boolean;
  /** What the test opens; the microphone, as a run opens it. For tests. */
  openForTest?: (signal: AbortSignal) => Promise<Source>;
}

const openTestMic = (signal: AbortSignal) => openMic(micSettings(), signal);

export default function MicGateControl({ isSessionActive, disabled = false, openForTest = openTestMic }: MicGateControlProps) {
  const { t } = useTranslation();
  const id = useId();
  const threshold = useMicGateThreshold();
  const setThreshold = useSetMicGateThreshold();
  // The slider's own value while it is dragged: written to the store when it is let go, as the look's sliders are.
  const [local, setLocal] = useState(threshold);
  useEffect(() => { setLocal(threshold); }, [threshold]);
  const commit = () => { if (local !== threshold) setThreshold(local); };
  const latest = useRef(local);
  latest.current = local;

  // The meter, on its own frames: the bar's width and whether it is over the mark, without a render per chunk.
  const fill = useRef<HTMLDivElement>(null);
  const meter = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState(() => micLevel.live());
  useEffect(() => {
    if (typeof requestAnimationFrame !== 'function') return undefined;
    let frame = 0;
    const tick = () => {
      const level = micLevel.read();
      const isLive = micLevel.live();
      if (fill.current) {
        fill.current.style.width = `${Math.round(level)}%`;
        fill.current.classList.toggle('is-over', isLive && latest.current > 0 && level >= latest.current);
      }
      meter.current?.classList.toggle('is-live', isLive);
      setLive((before) => (before === isLive ? before : isLive));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  // The section's own test of the microphone.
  const [testing, setTesting] = useState(false);
  const test = useRef<{ controller: AbortController; source: Source | null; timer: ReturnType<typeof setTimeout> | null } | null>(null);
  const stopTest = () => {
    const current = test.current;
    if (!current) return;
    test.current = null;
    current.controller.abort();
    if (current.timer) clearTimeout(current.timer);
    void current.source?.stop();
    setTesting(false);
  };
  const startTest = async () => {
    if (test.current || isSessionActive) return;
    const controller = new AbortController();
    const current = { controller, source: null as Source | null, timer: null as ReturnType<typeof setTimeout> | null };
    test.current = current;
    setTesting(true);
    try {
      const source = await openForTest(controller.signal);
      // Stopped, or a run begun, while it opened: not wanted any more.
      if (test.current !== current) {
        void source.stop();
        return;
      }
      current.source = source;
      source.onEnded(() => { if (test.current === current) stopTest(); });
      current.timer = setTimeout(() => { if (test.current === current) stopTest(); }, MIC_TEST_MOST_MS);
    } catch (error) {
      if (test.current === current) {
        test.current = null;
        setTesting(false);
        if (!controller.signal.aborted) reportWarning('MicGate', `The microphone test could not open the microphone: ${describeCause(error)}`, { dedupeKey: 'micgate:test' });
      }
    }
  };
  // A run takes the microphone: the test lets go of it first. Leaving the section ends it too.
  useEffect(() => { if (isSessionActive) stopTest(); }, [isSessionActive]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => stopTest(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = local === 0 ? t('fork.audio.gateOff', 'Off') : `${local}%`;
  return (
    <div className="kt-gate" data-testid="mic-gate">
      <div className="kt-gate__header">
        <label className="kt-gate__label" htmlFor={id}>{t('fork.audio.gate', 'Mic activation threshold')}</label>
        <Tooltip content={t('fork.audio.gateTooltip', "Sound quieter than this is heard as silence — the other side's voice from your speakers, the keyboard, the room — so it is neither translated nor checked. The microphone is heard about 0.2 s later while this is on. Off: everything is heard.")} position="top" icon="help" maxWidth={320} />
        <span className="kt-gate__value" data-testid="mic-gate-value">{shown}</span>
      </div>
      <div className="kt-gate__row">
        <div ref={meter} className="kt-gate__meter">
          <div className="kt-gate__track" aria-hidden="true">
            <div ref={fill} className="kt-gate__fill" data-testid="mic-gate-fill" />
          </div>
          <input
            id={id}
            className="kt-gate__range"
            type="range"
            min={0}
            max={100}
            step={1}
            value={local}
            disabled={disabled}
            aria-valuetext={shown}
            onChange={(e) => setLocal(Number(e.target.value))}
            onPointerUp={commit}
            onKeyUp={commit}
            onBlur={commit}
          />
        </div>
        {!isSessionActive && (
          <button
            type="button"
            className={`kt-gate__test${testing ? ' is-on' : ''}`}
            aria-pressed={testing}
            title={testing ? t('fork.audio.gateTestStop', 'Stop the test') : t('fork.audio.gateTest', 'Test the microphone: the bar shows its level')}
            aria-label={testing ? t('fork.audio.gateTestStop', 'Stop the test') : t('fork.audio.gateTest', 'Test the microphone: the bar shows its level')}
            onClick={() => (testing ? stopTest() : void startTest())}
          >
            <Mic size={14} />
          </button>
        )}
      </div>
      {!live && !testing && (
        <div className="kt-gate__hint">
          {isSessionActive
            ? t('fork.audio.gateQuiet', 'Nothing from the microphone yet.')
            : t('fork.audio.gateHint', 'Press the microphone, speak, and set the mark under where the bar reaches — and above where it sits while only your speakers are heard.')}
        </div>
      )}
    </div>
  );
}
