import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { addGlossaryEntry, normalizeGlossaryEntries } from '../lib/glossary/glossary';
import type { GlossaryEntry, GlossaryEntryInput, GlossarySnapshot } from '../lib/glossary/types';

const KEY = 'settings.common.glossary';

interface GlossaryStoreState {
  entries: readonly GlossaryEntry[];
  hydrated: boolean;
  add(input: GlossaryEntryInput): void;
  /** A source another row already has is refused: the two would be one entry. */
  update(id: string, patch: Partial<Pick<GlossaryEntry, 'source' | 'target' | 'aliases'>>): void;
  remove(id: string): void;
  snapshot(): GlossarySnapshot;
  hydrate(): Promise<void>;
}

function write(entries: readonly GlossaryEntry[]): void {
  void import('../services/persistSetting').then(({ persistSetting }) => persistSetting(KEY, entries));
}

/** A beta imported whole friends lists: a row with nothing written on it did nothing, and only fills the table. */
const writtenOn = (row: unknown): boolean => {
  const { externalId, source, target, aliases } = row as { externalId?: unknown; source?: unknown; target?: unknown; aliases?: unknown[] };
  return !externalId || target !== source || Boolean(aliases?.length);
};

export const useGlossaryStore = create<GlossaryStoreState>()(
  subscribeWithSelector((set, get) => ({
    entries: [],
    hydrated: false,
    add: (input) => {
      const entries = addGlossaryEntry(get().entries, input);
      set({ entries });
      write(entries);
    },
    update: (id, patch) => {
      const before = get().entries;
      const entries = normalizeGlossaryEntries(before.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));
      if (entries.length < before.length) return;
      set({ entries });
      write(entries);
    },
    remove: (id) => {
      const entries = get().entries.filter((entry) => entry.id !== id);
      set({ entries });
      write(entries);
    },
    snapshot: () => ({ entries: get().entries.map((entry) => ({ ...entry, aliases: [...entry.aliases] })) }),
    hydrate: async () => {
      const { ServiceFactory } = await import('../services/ServiceFactory');
      const stored = await ServiceFactory.getSettingsService().getSetting<unknown>(KEY, []);
      set({ entries: normalizeGlossaryEntries(Array.isArray(stored) ? stored.filter(writtenOn) : []), hydrated: true });
    },
  })),
);
