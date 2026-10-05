/**
 * Fork: the native engines (`src/lib/native/nativeEngine.ts`) — what the
 * settings show of each: whether its model is downloaded, how far a download
 * is, and whether it is up. One store for the engine that hears and one for
 * the engine that translates, made the same way; stores of their own, as the
 * LocalAI's is, so no upstream store's shape or tests move.
 */
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { askNativeEngine, NO_NATIVE_ENGINE, onNativeEngineStatus, type NativeEngineName, type NativeEngineStatus } from '../lib/native/nativeEngine';

export interface NativeEngineStoreState {
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

function createNativeEngineStore(engine: NativeEngineName) {
  const starting = new Map<string, Promise<NativeEngineStatus>>();
  return create<NativeEngineStoreState>()(
    subscribeWithSelector((set) => ({
      status: NO_NATIVE_ENGINE,
      asked: false,
      download: async (id) => { set({ status: await askNativeEngine('download', id, engine), asked: true }); },
      cancel: async (id) => { set({ status: await askNativeEngine('cancel', id, engine), asked: true }); },
      remove: async (id) => { set({ status: await askNativeEngine('remove', id, engine), asked: true }); },
      start: (id) => {
        const running = starting.get(id);
        if (running) return running;
        const mine = askNativeEngine('start', id, engine).then((status) => {
          set({ status, asked: true });
          return status;
        }).finally(() => { starting.delete(id); });
        starting.set(id, mine);
        return mine;
      },
      stop: async () => { set({ status: await askNativeEngine('stop', undefined, engine), asked: true }); },
      refresh: async () => {
        const status = await askNativeEngine('get', undefined, engine);
        set({ status, asked: true });
        return status;
      },
      hydrate: async () => {
        // Its changes arrive by themselves from here on: a download's progress, a start's steps.
        onNativeEngineStatus((status) => set({ status, asked: true }), engine);
        set({ status: await askNativeEngine('get', undefined, engine), asked: true });
      },
    })),
  );
}

/** The engine that hears: audio.cpp. */
export const useNativeEngineStore = createNativeEngineStore('native-engine');
/** The engine that translates: llama.cpp's server. */
export const useNativeTranslatorStore = createNativeEngineStore('native-translator');
/** The engine that gives the grammar feedback: llama.cpp's server once more, with a chat model. */
export const useNativeCoachStore = createNativeEngineStore('native-coach');
export type NativeEngineStore = typeof useNativeEngineStore;
