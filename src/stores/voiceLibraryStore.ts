/**
 * Fork: the user's own voices, as the page knows them: recordings a cloning voice model speaks from, kept by the main
 * process in the profile (`electron/voice-library.js`). A recording made or chosen here is handed over as a WAV; a
 * voice a friend handed over, as the file it came in.
 */
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

export interface LibraryVoice {
  id: string;
  name: string;
  /** The words said in the recording, where they are known: it is cloned from its sound alone where they are not. */
  text: string;
  language: string;
  seconds: number;
  createdAt: number;
  /** The languages with a plain recording, by base code, its first recording's first. */
  languages: readonly string[];
  tones: readonly { tone: string; languages: readonly string[] }[];
}

/** Why a recording was not kept: the main process's code for it (`voice_too_short`, …), or `failed`. */
export type VoiceAdded = { ok: true; voice: LibraryVoice } | { ok: false; code: string };

interface ElectronApi { invoke(channel: string, data?: unknown): Promise<unknown> }
const electron = (): ElectronApi | undefined => (typeof window === 'undefined' ? undefined : (window as unknown as { electron?: ElectronApi }).electron);

/** The main process's list, held to its shape. */
function voicesOf(value: unknown): LibraryVoice[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((one): LibraryVoice[] => {
    const v = one as Partial<LibraryVoice> | null;
    if (!v || typeof v.id !== 'string' || typeof v.name !== 'string') return [];
    const languagesOf = (list: unknown): string[] => Array.isArray(list) ? list.filter((one): one is string => typeof one === 'string') : [];
    const tones = Array.isArray(v.tones) ? v.tones.flatMap((one) =>
      typeof one?.tone === 'string' && /^[a-z]{2,12}$/.test(one.tone) ? [{ tone: one.tone, languages: languagesOf(one.languages) }] : []) : [];
    return [{ id: v.id, name: v.name, text: typeof v.text === 'string' ? v.text : '', language: typeof v.language === 'string' ? v.language : '', seconds: Number(v.seconds) || 0, createdAt: Number(v.createdAt) || 0, languages: languagesOf(v.languages), tones }];
  });
}

interface VoiceLibraryState {
  voices: readonly LibraryVoice[];
  /** The main process has said what there is. */
  asked: boolean;
  refresh(): Promise<void>;
  /** `to`: the voice this recording belongs to, replacing any in the same language and tone. */
  add(voice: { name: string; text: string; language: string; wav: Uint8Array; to?: string; tone?: string }): Promise<VoiceAdded>;
  /** A voice handed over as a file (`.kotovoice`). */
  addPack(bytes: Uint8Array): Promise<VoiceAdded>;
  remove(id: string): Promise<void>;
  /** Takes away any recording but the voice's first. */
  removeTake(id: string, language: string, tone?: string): Promise<void>;
  /** Calls one by another name. A blank one changes nothing. */
  rename(id: string, name: string): Promise<void>;
  /** Saves one as a file where the user says. */
  export(id: string): Promise<void>;
}

export const useVoiceLibraryStore = create<VoiceLibraryState>()(
  subscribeWithSelector((set, get) => {
    const added = async (payload: object): Promise<VoiceAdded> => {
      const api = electron();
      if (!api) return { ok: false, code: 'failed' };
      try {
        const answer = (await api.invoke('voice-library:add', payload)) as { ok?: boolean; voice?: unknown; code?: unknown } | null;
        const voice = answer?.ok ? voicesOf([answer.voice])[0] : undefined;
        if (!voice) return { ok: false, code: typeof answer?.code === 'string' ? answer.code : 'failed' };
        await get().refresh();
        return { ok: true, voice };
      } catch {
        return { ok: false, code: 'failed' };
      }
    };
    return {
      voices: [],
      asked: false,
      refresh: async () => {
        const api = electron();
        if (!api) { set({ asked: true }); return; }
        try {
          set({ voices: voicesOf(await api.invoke('voice-library:list')), asked: true });
        } catch {
          set({ asked: true });
        }
      },
      add: (voice) => added(voice),
      addPack: (bytes) => added({ pack: bytes }),
      remove: async (id) => {
        await electron()?.invoke('voice-library:remove', { id }).catch(() => undefined);
        await get().refresh();
      },
      removeTake: async (id, language, tone) => {
        await electron()?.invoke('voice-library:remove-take', { id, language, tone }).catch(() => undefined);
        await get().refresh();
      },
      rename: async (id, name) => {
        await electron()?.invoke('voice-library:rename', { id, name }).catch(() => undefined);
        await get().refresh();
      },
      export: async (id) => { await electron()?.invoke('voice-library:export', { id }).catch(() => undefined); },
    };
  }),
);
