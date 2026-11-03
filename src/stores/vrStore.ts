/**
 * Fork: the SteamVR overlay's settings and state (`src/app/vrOverlay.ts`):
 * whether it is on, which wrist the panel is on, and what the main process
 * says of it. A store of its own, as the fork's other settings are, with the
 * settings service imported when first used.
 */
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

/** What the main process says (`electron/vr-overlay.js`): off, the helper waiting for SteamVR, shown, or no helper in this build. */
export type VrLink = 'off' | 'waiting' | 'connected' | 'missing';
export type VrHand = 'left' | 'right';

interface VrStoreState {
  on: boolean;
  hand: VrHand;
  link: VrLink;
  /** The wrist panel is in view. */
  wristShown: boolean;
  setOn(on: boolean): void;
  setHand(hand: VrHand): void;
  setLink(link: VrLink): void;
  setWristShown(shown: boolean): void;
  /** Called once at app boot (`src/routes/Home.tsx`). */
  hydrate(): Promise<void>;
}

const KEY = { on: 'settings.vr.on', hand: 'settings.vr.hand' } as const;

const persist = (key: string, value: unknown) => {
  void import('../services/persistSetting').then(({ persistSetting }) => persistSetting(key, value));
};

export const useVrStore = create<VrStoreState>()(
  subscribeWithSelector((set) => ({
    on: false,
    hand: 'left',
    link: 'off',
    wristShown: false,
    setOn: (on) => { set({ on }); persist(KEY.on, on); },
    setHand: (hand) => { set({ hand }); persist(KEY.hand, hand); },
    setLink: (link) => set({ link }),
    setWristShown: (wristShown) => set({ wristShown }),
    hydrate: async () => {
      const { ServiceFactory } = await import('../services/ServiceFactory');
      const service = ServiceFactory.getSettingsService();
      const [on, hand] = await Promise.all([service.getSetting(KEY.on, false), service.getSetting<unknown>(KEY.hand, 'left')]);
      set({ on: on === true, hand: hand === 'right' ? 'right' : 'left' });
    },
  })),
);
