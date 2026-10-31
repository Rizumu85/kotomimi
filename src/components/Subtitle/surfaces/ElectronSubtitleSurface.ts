import type { SubtitleSurface } from './SubtitleSurface';
import { useSubtitleStore } from '../../../stores/subtitleStore';
import { mirrorChildDocument } from './childDocument';
import { setSubtitleWindowHost } from './subtitleWindowHost';
import useSettingsStore from '../../../stores/settingsStore';

export class ElectronSubtitleSurface implements SubtitleSurface {
  private child: Window | null = null;
  private cleanup: (() => void) | null = null;

  async enter(): Promise<void> {
    if (this.child && !this.child.closed) return;
    const child = window.open('', 'kotomimi-subtitle', 'width=800,height=200');
    if (!child) throw new Error('The subtitle window could not open.');
    this.child = child;
    child.document.title = 'Kotomimi Subtitles';
    const unmirror = mirrorChildDocument(document, child.document);
    child.document.body.style.cssText = 'margin:0;background:transparent;overflow:hidden';
    const host = child.document.createElement('div');
    child.document.body.appendChild(host);
    let disposed = false;
    this.cleanup = () => {
      if (disposed) return;
      disposed = true;
      unmirror();
      setSubtitleWindowHost(null);
      this.child = null;
      this.cleanup = null;
      useSettingsStore.getState().__notifySubtitleSurfaceExited();
    };
    child.addEventListener('pagehide', this.cleanup, { once: true });
    const { windowBounds, alwaysOnTop, positionLocked } = useSubtitleStore.getState();
    try {
      const result = await window.electron?.invoke('subtitle:enter', {
        bounds: windowBounds ?? undefined, alwaysOnTop, locked: positionLocked,
      });
      if (!result?.ok || child.closed || this.child !== child) throw new Error('The subtitle window did not initialize.');
      setSubtitleWindowHost(host);
    } catch (error) {
      this.cleanup?.();
      child.close();
      throw error;
    }
  }

  async exit(): Promise<void> {
    const child = this.child;
    this.cleanup?.();
    await window.electron?.invoke('subtitle:exit', {});
    if (child && !child.closed) child.close();
  }

  async setFullscreen(flag: boolean): Promise<void> {
    await window.electron?.invoke('subtitle:set-fullscreen', flag);
  }

  async setAlwaysOnTop(flag: boolean): Promise<void> {
    await window.electron?.invoke('subtitle:set-always-on-top', flag);
  }
}
