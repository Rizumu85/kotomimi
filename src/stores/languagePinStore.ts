/**
 * Fork: the languages a person pinned to the top of the language menus
 * (`src/components/providers/LanguageMenu.tsx`) — the few they switch
 * between. One list for both menus, in the order pinned. A store of its own,
 * as the fork's other settings are, with the settings service imported when
 * first used.
 */
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

interface LanguagePinStoreState {
  pins: readonly string[];
  /** Pins a language, at the end of the pinned ones — or lets it go. */
  toggle(code: string): void;
  /** Called once at app boot (`src/routes/Home.tsx`). */
  hydrate(): Promise<void>;
}

const KEY = 'settings.common.pinnedLanguages';
/** More than this is no longer a short list at the top. */
export const MOST_PINS = 12;

/** What was stored, held to its shape: codes, each once. */
export function normalizePins(stored: unknown): string[] {
  if (!Array.isArray(stored)) return [];
  return [...new Set(stored.filter((code): code is string => typeof code === 'string' && code !== '' && code.length <= 40))].slice(0, MOST_PINS);
}

export const useLanguagePinStore = create<LanguagePinStoreState>()(
  subscribeWithSelector((set, get) => ({
    pins: [],
    toggle: (code) => {
      const now = get().pins;
      const pins = now.includes(code) ? now.filter((c) => c !== code) : [...now, code].slice(-MOST_PINS);
      set({ pins });
      // What is stored is what is pinned when the write is made: two presses in a row may reach here in either order.
      void import('../services/persistSetting').then(({ persistSetting }) => persistSetting(KEY, get().pins));
    },
    hydrate: async () => {
      const { ServiceFactory } = await import('../services/ServiceFactory');
      set({ pins: normalizePins(await ServiceFactory.getSettingsService().getSetting<unknown>(KEY, [])) });
    },
  })),
);
