/**
 * Fork: VRChat on the same computer (`electron/vrchat.js`, `src/app/vrchat.ts`) —
 * three settings, and what the app knows of VRChat now.
 *
 * - `muteGate`: muted in VRChat, the user's own leg is not heard (on by
 *   default). Off for a player who keeps silent in VRChat and still wants
 *   what they say translated into the chatbox.
 * - `chatbox`: the user's translations above their avatar — off, the
 *   translation, or the original with it. Typed text goes the same way.
 * - `onVideo`: when a world's video player begins a video — ask, carry on,
 *   hear the other side in shorter stretches, or not hear it at all.
 *
 * A store of its own, as the fork's other settings are, with the settings
 * service imported when first used.
 */
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

export type ChatboxShows = 'off' | 'translation' | 'both';
export type OnVideo = 'ask' | 'normal' | 'quick' | 'pause';
/** A video in the world: none, asked about, or being heard at a pace (`auto`: chosen for the user, who could not be asked). */
export type VideoState = { kind: 'none' } | { kind: 'asking' } | { kind: 'on'; pace: 'quick' | 'paused'; auto: boolean };
/** What VRChat's side says: a log of a running VRChat was found, its OSCQuery answers the mute, and the mute. */
export interface VRChatLink { found: boolean; connected: boolean; muted: boolean | null }

const KEYS = { muteGate: 'settings.vrchat.muteGate', chatbox: 'settings.vrchat.chatbox', onVideo: 'settings.vrchat.onVideo' } as const;
const CHATBOX: readonly ChatboxShows[] = ['off', 'translation', 'both'];
const ON_VIDEO: readonly OnVideo[] = ['ask', 'normal', 'quick', 'pause'];

interface VRChatStore {
  muteGate: boolean;
  chatbox: ChatboxShows;
  onVideo: OnVideo;
  link: VRChatLink;
  video: VideoState;
  /** How many views want the link kept fresh now (the settings card): the mute is asked while one does. */
  viewers: number;
  setMuteGate(on: boolean): void;
  setChatbox(shows: ChatboxShows): void;
  setOnVideo(on: OnVideo): void;
  setLink(link: VRChatLink): void;
  setVideo(video: VideoState): void;
  view(on: boolean): void;
  /** Called once at app boot (`src/routes/Home.tsx`). */
  hydrate(): Promise<void>;
}

const persist = (key: string, value: unknown) => {
  void import('../services/persistSetting').then(({ persistSetting }) => persistSetting(key, value));
};

export const useVRChatStore = create<VRChatStore>()(
  subscribeWithSelector((set) => ({
    muteGate: true,
    chatbox: 'off',
    onVideo: 'ask',
    link: { found: false, connected: false, muted: null },
    video: { kind: 'none' },
    viewers: 0,
    setMuteGate: (muteGate) => { set({ muteGate }); persist(KEYS.muteGate, muteGate); },
    setChatbox: (chatbox) => { set({ chatbox }); persist(KEYS.chatbox, chatbox); },
    setOnVideo: (onVideo) => { set({ onVideo }); persist(KEYS.onVideo, onVideo); },
    setLink: (link) => set({ link }),
    setVideo: (video) => set({ video }),
    view: (on) => set((state) => ({ viewers: Math.max(0, state.viewers + (on ? 1 : -1)) })),
    hydrate: async () => {
      const { ServiceFactory } = await import('../services/ServiceFactory');
      const service = ServiceFactory.getSettingsService();
      const [muteGate, chatbox, onVideo] = await Promise.all([
        service.getSetting<unknown>(KEYS.muteGate, true),
        service.getSetting<unknown>(KEYS.chatbox, 'off'),
        service.getSetting<unknown>(KEYS.onVideo, 'ask'),
      ]);
      set({
        muteGate: muteGate !== false,
        chatbox: CHATBOX.includes(chatbox as ChatboxShows) ? (chatbox as ChatboxShows) : 'off',
        onVideo: ON_VIDEO.includes(onVideo as OnVideo) ? (onVideo as OnVideo) : 'ask',
      });
    },
  })),
);

/** Whether the user's own leg is heard as silence now: the gate on, VRChat answering, and muted there. */
export function vrchatHolds(state: Pick<VRChatStore, 'muteGate' | 'link'> = useVRChatStore.getState()): boolean {
  return state.muteGate && state.link.connected && state.link.muted === true;
}
