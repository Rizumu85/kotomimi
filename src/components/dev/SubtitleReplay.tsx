import { useEffect, useMemo, useRef, useState } from 'react';
import { readSubtitleCapture, replaySubtitleCapture, type SubtitleCapture } from '../../lib/subtitle/capture';
import { getAppVersion } from '../../utils/conversationExport';
import { useSubtitleStore } from '../../stores/subtitleStore';
import { useSubtitleLookStore } from '../../stores/subtitleLookStore';
import { useAnnotationStore } from '../../stores/annotationStore';
import { SubtitleView, type SubtitleControls } from '../Subtitle/SubtitleView';

/**
 * Development builds only (`?preview=subtitle-replay`): a subtitle capture a user saved ("save what the subtitle just
 * showed", `saveSubtitleCapture`) drawn again as it was — the same entries, settings, look, reading aids, held lines
 * and window size — at any moment of its minute, to be scrubbed or played. The settings go into this page's stores in
 * memory only; nothing is saved.
 */
const NOOP: SubtitleControls = { exit() {}, clear() {}, press() {}, release() {} };

export function SubtitleReplay() {
  const [capture, setCapture] = useState<SubtitleCapture | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [at, setAt] = useState(0);
  const [playing, setPlaying] = useState(false);
  const frame = useRef<number | null>(null);

  const state = useMemo(() => (capture ? replaySubtitleCapture(capture, at) : null), [capture, at]);
  // The recorded settings into this page's stores, as they were at this moment.
  useEffect(() => {
    if (!state) return;
    useSubtitleStore.setState(state.settings);
    useSubtitleLookStore.setState(state.look);
    useAnnotationStore.setState(state.annotation);
  }, [state]);
  // Played at the recorded pace.
  useEffect(() => {
    if (!playing || !capture) return undefined;
    let last = performance.now();
    const step = (now: number) => {
      setAt((value) => {
        const next = value + (now - last);
        if (next >= capture.durationMs) { setPlaying(false); return capture.durationMs; }
        return next;
      });
      last = now;
      frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
    return () => { if (frame.current !== null) cancelAnimationFrame(frame.current); };
  }, [playing, capture]);

  const open = async (file: File | undefined) => {
    if (!file) return;
    const result = readSubtitleCapture(await file.text(), getAppVersion() ?? 'dev');
    if (!result.ok) { setCapture(null); setMessage(result.error); return; }
    setCapture(result.capture);
    setMessage(result.warning);
    setAt(0);
    setPlaying(false);
  };

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12, color: 'var(--sk-text-primary)', fontSize: 13 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <input type="file" accept="application/json,.json" onChange={(e) => void open(e.target.files?.[0])} />
        {capture && (
          <>
            <button type="button" onClick={() => { if (at >= capture.durationMs) setAt(0); setPlaying(!playing); }}>{playing ? 'Pause' : 'Play'}</button>
            <input type="range" min={0} max={capture.durationMs} step={50} value={at} onChange={(e) => { setPlaying(false); setAt(Number(e.target.value)); }} style={{ flex: 1, minWidth: 240 }} />
            <span>{(at / 1000).toFixed(1)} / {(capture.durationMs / 1000).toFixed(1)} s</span>
            <span style={{ opacity: 0.7 }}>{capture.appVersion} · {capture.platform} · {capture.language}{capture.truncated ? ' · truncated' : ''}</span>
          </>
        )}
      </div>
      {message && <div style={{ color: 'var(--sk-warning)' }}>{message}</div>}
      {state && (
        <div
          style={{
            width: state.viewport.width,
            height: state.viewport.height,
            position: 'relative',
            overflow: 'hidden',
            outline: '1px dashed var(--sk-border-default)',
            // A checkerboard: the window is transparent where the subtitle has no panel.
            backgroundImage: 'repeating-conic-gradient(var(--sk-bg-surface) 0% 25%, var(--sk-bg-base) 0% 50%)',
            backgroundSize: '16px 16px',
          }}
        >
          <SubtitleView surface={state.surface} model={{ ...state.model, held: state.held }} controls={NOOP} />
        </div>
      )}
    </div>
  );
}
