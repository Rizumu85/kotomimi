import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { mergeGlossaryEntries, normalizeGlossaryEntries, parseGlossaryClipboard } from '../lib/glossary/glossary';
import type { GlossaryEntry, GlossaryEntryInput, GlossaryImportResult, GlossarySnapshot } from '../lib/glossary/types';

const KEY = 'settings.common.glossary';

interface GlossaryStoreState {
  entries: readonly GlossaryEntry[];
  hydrated: boolean;
  add(input: GlossaryEntryInput): void;
  update(id: string, patch: Partial<Pick<GlossaryEntry, 'source' | 'target' | 'aliases' | 'enabled'>>): void;
  remove(id: string): void;
  toggle(id: string): void;
  importClipboard(raw: string): GlossaryImportResult;
  snapshot(): GlossarySnapshot;
  hydrate(): Promise<void>;
}

function write(entries: readonly GlossaryEntry[]): void {
  void import('../services/persistSetting').then(({ persistSetting }) => persistSetting(KEY, entries));
}

export const useGlossaryStore = create<GlossaryStoreState>()(
  subscribeWithSelector((set, get) => ({
    entries: [],
    hydrated: false,
    add: (input) => {
      const { entries } = mergeGlossaryEntries(get().entries, [input]);
      set({ entries });
      write(entries);
    },
    update: (id, patch) => {
      const entries = normalizeGlossaryEntries(get().entries.map((entry) => entry.id === id ? { ...entry, ...patch } : entry));
      set({ entries });
      write(entries);
    },
    remove: (id) => {
      const entries = get().entries.filter((entry) => entry.id !== id);
      set({ entries });
      write(entries);
    },
    toggle: (id) => {
      const entries = get().entries.map((entry) => entry.id === id ? { ...entry, enabled: !entry.enabled } : entry);
      set({ entries });
      write(entries);
    },
    importClipboard: (raw) => {
      const { entries, result } = mergeGlossaryEntries(get().entries, parseGlossaryClipboard(raw));
      set({ entries });
      write(entries);
      return result;
    },
    snapshot: () => ({ entries: get().entries.map((entry) => ({ ...entry, aliases: [...entry.aliases] })) }),
    hydrate: async () => {
      const { ServiceFactory } = await import('../services/ServiceFactory');
      const stored = await ServiceFactory.getSettingsService().getSetting<unknown>(KEY, []);
      set({ entries: normalizeGlossaryEntries(stored), hydrated: true });
    },
  })),
);

