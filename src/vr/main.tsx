// src/vr/main.tsx
/**
 * Fork: the overlay's two pages (`electron/vr-overlay.js`): `#strip`, the
 * captions under the line of sight, drawn offscreen and shown by the SteamVR
 * helper — a picture goes to the headset only when it changes, so nothing
 * here animates — and `#wrist`, the panel, a window on the desktop a wrist
 * tool carries. They draw what the main window sends and ask it for changes.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles/theme.scss';
import './vr.scss';
import Strip from './Strip';
import Wrist from './Wrist';
import { bridge, surface } from './bridge';
import type { VrPerf, VrState } from './types';

document.documentElement.dataset.theme = 'dark';

function App() {
  const [state, setState] = useState<VrState | null>(null);
  const [perf, setPerf] = useState<VrPerf | null>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bridge?.receive('vr:state', (s) => setState(s as VrState));
    bridge?.receive('vr:perf', (p) => setPerf(p as VrPerf));
    void bridge?.invoke('vr:ready', { surface });
  }, []);
  // The window is the page's size: the main process sizes it to the page.
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    let last = '';
    const measure = () => {
      const width = Math.ceil(el.offsetWidth);
      const height = Math.ceil(el.offsetHeight);
      const key = `${width}x${height}`;
      if (key === last || width === 0 || height === 0) return;
      last = key;
      void bridge?.invoke('vr:size', { surface, width, height });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    measure();
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={root} className={`vr vr--${surface}`}>
      {state && (surface === 'strip' ? <Strip state={state} /> : <Wrist state={state} perf={perf} />)}
    </div>
  );
}

const el = document.getElementById('root');
if (el) createRoot(el).render(<App />);
