/**
 * Fork: where the downloaded models are kept, and moving them (`electron/model-storage.js`). The page's side: the
 * folder, what the models take, the room left on its drive, and a move as it goes. Desktop only: elsewhere the
 * store stays empty and nothing shows it.
 */
import { create } from 'zustand';

export interface StorageDrive {
  /** `D:` on Windows, a volume's name on a Mac; blank for the computer's own disk. */
  name: string;
  freeBytes: number | null;
  totalBytes: number | null;
}

export interface StorageStatus {
  root: string;
  isDefault: boolean;
  /** A chosen folder that is not there (a drive not plugged in). */
  missing: boolean;
  usedBytes: number;
  drive: StorageDrive;
  /** An unpackaged run that names its own folder: nothing is offered. */
  fixed: boolean;
  moving: boolean;
}

export type PlanError = 'same' | 'inside' | 'not_writable' | 'no_space';
export type MoveError = 'busy' | 'downloading' | 'stopped' | 'copy_failed' | 'move_failed';

export interface StoragePlan {
  target: string;
  needBytes: number;
  drive: StorageDrive;
  sameDrive?: boolean;
  error?: PlanError;
}

interface Electron {
  invoke(channel: string, data?: unknown): Promise<unknown>;
  receive(channel: string, listener: (payload: never) => void): void;
  removeListener(channel: string, listener: (payload: never) => void): void;
}
const electron = (): Electron | undefined => (typeof window === 'undefined' ? undefined : (window as unknown as { electron?: Electron }).electron);

/** A status asked this long ago is asked again when something reads it. */
const FRESH_MS = 10_000;

interface ModelStorageState {
  status: StorageStatus | null;
  askedAt: number;
  /** A folder chosen, waiting for the move to be confirmed. */
  plan: StoragePlan | null;
  progress: { copied: number; total: number; startedAt: number } | null;
  /** Why the last move did not happen. */
  failed: MoveError | PlanError | null;
  /** The last move that finished: the room it freed, on which drive. */
  freed: { bytes: number; drive: StorageDrive } | null;
  /** Bumped when a folder is chosen from elsewhere (a model card): the section brings itself into view. */
  focus: number;
  refresh(force?: boolean): Promise<void>;
  choose(): Promise<void>;
  move(): Promise<void>;
  cancel(): void;
  dismiss(): void;
  reset(): Promise<void>;
  open(): void;
}

export const useModelStorageStore = create<ModelStorageState>()((set, get) => ({
  status: null,
  askedAt: 0,
  plan: null,
  progress: null,
  failed: null,
  freed: null,
  focus: 0,

  async refresh(force = false) {
    const api = electron();
    if (!api || (!force && Date.now() - get().askedAt < FRESH_MS)) return;
    set({ askedAt: Date.now() });
    try {
      const status = (await api.invoke('model-storage:status')) as StorageStatus | null;
      if (status) set({ status });
    } catch {
      // No main process to ask (an older build's preload): nothing is shown.
    }
  },

  async choose() {
    const api = electron();
    if (!api) return;
    set((s) => ({ focus: s.focus + 1 }));
    const plan = (await api.invoke('model-storage:choose').catch(() => null)) as StoragePlan | null;
    if (!plan) return;
    // The same folder again is no move: nothing to confirm.
    if (plan.error === 'same') { set({ plan: null, failed: null }); return; }
    set({ plan, failed: null, freed: null });
  },

  async move() {
    const api = electron();
    const { plan, status } = get();
    if (!api || !plan || plan.error) return;
    const onProgress = (p: { copied: number; total: number }) => set((s) => ({ progress: { ...p, startedAt: s.progress?.startedAt ?? Date.now() } }));
    api.receive('model-storage:progress', onProgress as (payload: never) => void);
    set({ progress: { copied: 0, total: plan.needBytes, startedAt: Date.now() }, failed: null });
    try {
      const answer = (await api.invoke('model-storage:move', { target: plan.target })) as { status?: StorageStatus; error?: MoveError };
      if (answer?.status) {
        const from = status?.drive;
        // Room is freed where they were only when they left that drive.
        set({ status: answer.status, plan: null, freed: from && !plan.sameDrive ? { bytes: plan.needBytes, drive: from } : null, askedAt: Date.now() });
      } else {
        set({ failed: answer?.error ?? 'move_failed', plan: answer?.error === 'stopped' ? null : plan });
      }
    } catch {
      set({ failed: 'move_failed' });
    } finally {
      api.removeListener('model-storage:progress', onProgress as (payload: never) => void);
      set({ progress: null });
    }
  },

  cancel() {
    void electron()?.invoke('model-storage:cancel').catch(() => undefined);
  },

  dismiss() {
    set({ plan: null, failed: null });
  },

  async reset() {
    const api = electron();
    if (!api) return;
    const status = (await api.invoke('model-storage:reset').catch(() => null)) as StorageStatus | null;
    if (status) set({ status, plan: null, failed: null, askedAt: Date.now() });
  },

  open() {
    void electron()?.invoke('model-storage:open').catch(() => undefined);
  },
}));

/**
 * A folder as the section writes it in its one line: whole where it fits, else its drive, then the last folders
 * (`C:\Users\…\Roaming\Kotomimi`): which drive, and which folder, are what a person looks for. The whole path is
 * its tooltip.
 */
export function shortPath(full: string, most = 34): string {
  if (full.length <= most) return full;
  const sep = full.includes('\\') ? '\\' : '/';
  const parts = full.split(sep).filter((part, at) => part !== '' || at === 0);
  const head = parts[0] === '' ? '' : parts[0];
  let tail = parts[parts.length - 1];
  for (let at = parts.length - 2; at > 0; at--) {
    const next = `${parts[at]}${sep}${tail}`;
    if (head.length + 2 + next.length > most) break;
    tail = next;
  }
  return `${head}${sep}…${sep}${tail}`;
}

const GB = 1024 ** 3;
/** Bytes as the section says them: gigabytes to one place, megabytes under one. */
export function sizeText(bytes: number): string {
  if (bytes >= GB / 10) return `${(bytes / GB).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

/** Kept free beyond a download, as the main process keeps it (`ROOM_MARGIN`, electron/native-engine.js). */
export const ROOM_MARGIN = 256 * 1024 ** 2;
