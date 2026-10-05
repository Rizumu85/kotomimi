/**
 * Fork: the native recognition engine (`src/lib/native/nativeEngine.ts`) —
 * what the settings show of it: whether its model is downloaded, how far a
 * download is, and whether it is up. A store of its own, as the LocalAI's
 * is, so no upstream store's shape or tests move.
 */
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { askNativeEngine, NO_NATIVE_ENGINE, onNativeEngineStatus, type NativeEngineStatus } from '../lib/native/nativeEngine';

interface NativeEngineStoreState {
  status: NativeEngineStatus;
  /** True once the main process has answered: before that, "unsupported" is a blank, not an answer. */
  asked: boolean;
  download(id: string): Promise<void>;
  cancel(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** Brings the engine up with this model: answers once it is ready, or failed. Asked twice, it starts once. */
  start(id: string): Promise<NativeEngineStatus>;
  stop(): Promise<void>;
  refresh(): Promise<NativeEngineStatus>;
  /** Called once at app boot (`src/routes/Home.tsx`). */
  hydrate(): Promise<void>;
}

const starting = new Map<string, Promise<NativeEngineStatus>>();

export const useNativeEngineStore = create<NativeEngineStoreState>()(
  subscribeWithSelector((set) => ({
    status: NO_NATIVE_ENGINE,
    asked: false,
    download: async (id) => { set({ status: await askNativeEngine('download', id), asked: true }); },
    cancel: async (id) => { set({ status: await askNativeEngine('cancel', id), asked: true }); },
    remove: async (id) => { set({ status: await askNativeEngine('remove', id), asked: true }); },
    start: (id) => {
      const running = starting.get(id);
      if (running) return running;
      const mine = askNativeEngine('start', id).then((status) => {
        set({ status, asked: true });
        return status;
      }).finally(() => { starting.delete(id); });
      starting.set(id, mine);
      return mine;
    },
    stop: async () => { set({ status: await askNativeEngine('stop'), asked: true }); },
    refresh: async () => {
      const status = await askNativeEngine('get');
      set({ status, asked: true });
      return status;
    },
    hydrate: async () => {
      // Its changes arrive by themselves from here on: a download's progress, a start's steps.
      onNativeEngineStatus((status) => set({ status, asked: true }));
      set({ status: await askNativeEngine('get'), asked: true });
    },
  })),
);
