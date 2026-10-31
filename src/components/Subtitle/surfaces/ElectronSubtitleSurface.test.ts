import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ElectronSubtitleSurface } from './ElectronSubtitleSurface';
import { getSubtitleWindowHost } from './subtitleWindowHost';

// Kept from before the old audio service was deleted: subtitleStore
// statically imports ServiceFactory, which used to reach
// ModernBrowserAudioService -> ModernAudioRecorder -> a worklet `?url` import
// that this sandboxed Vite test transform denied outright. ServiceFactory no
// longer reaches ModernAudioRecorder at all. Not needed by the current graph
// for that reason. Mocked anyway so subtitleStore's own persistence goes
// through this mock instead of a real settings backend.
vi.mock('../../../services/ServiceFactory', () => ({
  ServiceFactory: {
    getSettingsService: () => ({
      getSetting: vi.fn(async (_key: string, def: unknown) => def),
      setSetting: vi.fn(async () => ({ success: true })),
    }),
  },
}));

describe('ElectronSubtitleSurface', () => {
  const invoke = vi.fn(async () => ({ ok: true }));
  let frame: HTMLIFrameElement;
  let surface: ElectronSubtitleSurface;

  beforeEach(() => {
    invoke.mockClear();
    // @ts-ignore — minimal global stub
    globalThis.window = globalThis.window || {};
    // @ts-ignore
    (globalThis.window as any).electron = { invoke };
    frame = document.createElement('iframe');
    document.body.appendChild(frame);
    vi.spyOn(window, 'open').mockReturnValue(frame.contentWindow);
    vi.spyOn(frame.contentWindow!, 'close').mockImplementation(() => {});
    surface = new ElectronSubtitleSurface();
  });
  afterEach(async () => { await surface.exit(); frame.remove(); vi.restoreAllMocks(); });

  it('enter() sends subtitle:enter with bounds + alwaysOnTop + locked from subtitleStore', async () => {
    // Arrange — seed the subtitle store
    const { useSubtitleStore } = await import('../../../stores/subtitleStore');
    useSubtitleStore.setState({
      windowBounds: { x: 10, y: 20, width: 800, height: 200 },
      alwaysOnTop: true,
      positionLocked: false,
    });

    await surface.enter();
    expect(getSubtitleWindowHost()?.ownerDocument).toBe(frame.contentDocument);
    expect(window.open).toHaveBeenCalledWith('', 'kotomimi-subtitle', expect.any(String));

    expect(invoke).toHaveBeenCalledWith('subtitle:enter', {
      bounds: { x: 10, y: 20, width: 800, height: 200 },
      alwaysOnTop: true,
      locked: false,
    });
  });

  it('reuses one child and removes its host on close without stopping the main session', async () => {
    await surface.enter();
    await surface.enter();
    expect(window.open).toHaveBeenCalledTimes(1);
    frame.contentWindow!.dispatchEvent(new Event('pagehide'));
    expect(getSubtitleWindowHost()).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith('app:close-ready');
  });

  it('cleans up when native initialization fails', async () => {
    invoke.mockResolvedValueOnce({ ok: false });
    await expect(surface.enter()).rejects.toThrow('did not initialize');
    expect(getSubtitleWindowHost()).toBeNull();
    expect(frame.contentWindow!.close).toHaveBeenCalled();
  });

  it('exit() sends subtitle:exit with an empty payload, regardless of stored windowBounds', async () => {
    // Regression: subtitleStore.windowBounds is the SUBTITLE window's bounds
    // (the small floating bar), not the main window's pre-subtitle bounds.
    // The main process captures pre-subtitle bounds itself on enter and
    // restores from that snapshot — the renderer must NOT pass restoreBounds,
    // or the window would shrink to subtitle size on exit.
    const { useSubtitleStore } = await import('../../../stores/subtitleStore');
    useSubtitleStore.setState({
      windowBounds: { x: 100, y: 800, width: 960, height: 200 },
    });

    const surface = new ElectronSubtitleSurface();
    await surface.exit();
    expect(invoke).toHaveBeenCalledWith('subtitle:exit', {});
  });

  it('exit() sends an empty payload even when no subtitle bounds were stored', async () => {
    const { useSubtitleStore } = await import('../../../stores/subtitleStore');
    useSubtitleStore.setState({
      windowBounds: null,
    });

    const surface = new ElectronSubtitleSurface();
    await surface.exit();
    expect(invoke).toHaveBeenCalledWith('subtitle:exit', {});
  });

  it('setFullscreen(true) invokes subtitle:set-fullscreen with true', async () => {
    const surface = new ElectronSubtitleSurface();
    await surface.setFullscreen(true);
    expect(invoke).toHaveBeenCalledWith('subtitle:set-fullscreen', true);
  });

  it('setFullscreen(false) invokes subtitle:set-fullscreen with false', async () => {
    const surface = new ElectronSubtitleSurface();
    await surface.setFullscreen(false);
    expect(invoke).toHaveBeenCalledWith('subtitle:set-fullscreen', false);
  });
});
