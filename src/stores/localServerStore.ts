/**
 * Fork: the LocalAI installed on this computer (`src/lib/lan/localServer.ts`)
 * — what the settings and the title bar show of it, and whether it starts
 * with the app. A store of its own, so no upstream store's shape or tests
 * move. The settings service is imported when first used, as
 * `annotationStore` does and for the same reason.
 */
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { askLocalServer, NO_LOCAL_SERVER, onLocalServerStatus, type LocalServerStatus } from '../lib/lan/localServer';

interface LocalServerStoreState {
  status: LocalServerStatus;
  /** Started when the app opens. */
  autoStart: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  setAutoStart(on: boolean): void;
  /** Asks again whether it is up: something else may have started or stopped it. */
  refresh(): Promise<void>;
  /** Called once at app boot (`src/routes/Home.tsx`). */
  hydrate(): Promise<void>;
}

const KEY = 'settings.common.localServer.autoStart';

export const useLocalServerStore = create<LocalServerStoreState>()(
  subscribeWithSelector((set, get) => ({
    status: NO_LOCAL_SERVER,
    autoStart: false,
    start: async () => { set({ status: await askLocalServer('start') }); },
    stop: async () => { set({ status: await askLocalServer('stop') }); },
    refresh: async () => { set({ status: await askLocalServer('get') }); },
    setAutoStart: (on) => {
      if (get().autoStart === on) return;
      set({ autoStart: on });
      void import('../services/persistSetting').then(({ persistSetting }) => persistSetting(KEY, on));
    },
    hydrate: async () => {
      // Its changes arrive by themselves from here on: "starting", then what came of it.
      onLocalServerStatus((status) => set({ status }));
      const { ServiceFactory } = await import('../services/ServiceFactory');
      const autoStart = (await ServiceFactory.getSettingsService().getSetting<unknown>(KEY, false)) === true;
      const status = await askLocalServer('get');
      set({ autoStart, status });
      if (autoStart && status.state === 'stopped') await get().start();
    },
  })),
);
