/**
 * Fork: the SteamVR overlay's settings and state (`src/app/vrOverlay.ts`):
 * whether the headset shows the strip, whether the wrist panel's window is
 * open, and what the main process says of the headset. A store of its own, as the fork's other settings are, with the
 * settings service imported when first used.
 */
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

/** What the main process says (`electron/vr-overlay.js`): off, the helper waiting for SteamVR, shown, or no helper in this build. */
export type VrLink = 'off' | 'waiting' | 'connected' | 'missing';

interface VrStoreState {
  /** The strip in the headset. */
  on: boolean;
  /** The wrist panel's window on the desktop, for a wrist tool such as XSOverlay. */
  panel: boolean;
  link: VrLink;
  setOn(on: boolean): void;
  setPanel(panel: boolean): void;
  /** The panel's window closed by itself (Alt+F4, the app quitting): shown closed, the setting kept for the next start. */
  panelClosed(): void;
  setLink(link: VrLink): void;
  /** Called once at app boot (`src/routes/Home.tsx`). */
  hydrate(): Promise<void>;
}

const KEY = { on: 'settings.vr.on', panel: 'settings.vr.panel' } as const;

const persist = (key: string, value: unknown) => {
  void import('../services/persistSetting').then(({ persistSetting }) => persistSetting(key, value));
};

export const useVrStore = create<VrStoreState>()(
  subscribeWithSelector((set) => ({
    on: false,
    panel: false,
    link: 'off',
    setOn: (on) => { set({ on }); persist(KEY.on, on); },
    setPanel: (panel) => { set({ panel }); persist(KEY.panel, panel); },
    panelClosed: () => set({ panel: false }),
    setLink: (link) => set({ link }),
    hydrate: async () => {
      const { ServiceFactory } = await import('../services/ServiceFactory');
      const service = ServiceFactory.getSettingsService();
      const [on, panel] = await Promise.all([service.getSetting(KEY.on, false), service.getSetting(KEY.panel, false)]);
      set({ on: on === true, panel: panel === true });
    },
  })),
);
