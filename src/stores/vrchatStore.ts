/**
 * Fork: VRChat on the same computer (`electron/vrchat.js`, `src/app/vrchat.ts`) —
 * five settings, and what the app knows of VRChat now.
 *
 * - `muteGate`: muted in VRChat, the user's own leg is not heard (on by
 *   default). Off for a player who keeps silent in VRChat and still wants
 *   what they say translated into the chatbox.
 * - `chatbox`: the user's translations above their avatar — off, the
 *   translation, or the original with it, on lines of their own, the
 *   original first or — `chatboxTranslationFirst` — the translation.
 *   Typed text goes the same way.
 * - `onVideo`: when a world's video player begins a video — ask, carry on,
 *   hear the other side faster, or not hear it at all. Faster takes the
 *   video's sound out where it has no direction in the world, and hears the
 *   other side in shorter stretches where it has.
 * - `translateVideo`: with the video's sound taken out, its words are heard
 *   and translated as well, apart from the other side's.
 *
 * A store of its own, as the fork's other settings are, with the settings
 * service imported when first used.
 */
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

export type ChatboxShows = 'off' | 'translation' | 'both';
export type OnVideo = 'ask' | 'normal' | 'quick' | 'pause';
/**
 * A video in the world: none, asked about, or being heard at a pace (`auto`: chosen for the user, who could not be
 * asked). `apart`: its sound taken out of the other side's — and heard on its own as well (`separated`), its words
 * under origins that begin `laneOrigin` once its lane is open.
 */
export type VideoApart = 'removed' | 'separated';
export type VideoState =
  | { kind: 'none' }
  | { kind: 'asking' }
  | { kind: 'on'; pace: 'quick' | 'paused'; auto: boolean; apart?: VideoApart; laneOrigin?: string };
/** What VRChat's side says: a log of a running VRChat was found, its OSCQuery answers the mute, and the mute. */
export interface VRChatLink { found: boolean; connected: boolean; muted: boolean | null }

const KEYS = {
  muteGate: 'settings.vrchat.muteGate',
  chatbox: 'settings.vrchat.chatbox',
  chatboxTranslationFirst: 'settings.vrchat.chatboxTranslationFirst',
  onVideo: 'settings.vrchat.onVideo',
  translateVideo: 'settings.vrchat.translateVideo',
} as const;
const CHATBOX: readonly ChatboxShows[] = ['off', 'translation', 'both'];
const ON_VIDEO: readonly OnVideo[] = ['ask', 'normal', 'quick', 'pause'];

interface VRChatStore {
  muteGate: boolean;
  chatbox: ChatboxShows;
  chatboxTranslationFirst: boolean;
  onVideo: OnVideo;
  translateVideo: boolean;
  link: VRChatLink;
  video: VideoState;
  /** How many views want the link kept fresh now (the settings card): the mute is asked while one does. */
  viewers: number;
  setMuteGate(on: boolean): void;
  setChatbox(shows: ChatboxShows): void;
  setChatboxTranslationFirst(on: boolean): void;
  setOnVideo(on: OnVideo): void;
  setTranslateVideo(on: boolean): void;
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
    chatboxTranslationFirst: false,
    onVideo: 'ask',
    translateVideo: false,
    link: { found: false, connected: false, muted: null },
    video: { kind: 'none' },
    viewers: 0,
    setMuteGate: (muteGate) => { set({ muteGate }); persist(KEYS.muteGate, muteGate); },
    setChatbox: (chatbox) => { set({ chatbox }); persist(KEYS.chatbox, chatbox); },
    setChatboxTranslationFirst: (chatboxTranslationFirst) => { set({ chatboxTranslationFirst }); persist(KEYS.chatboxTranslationFirst, chatboxTranslationFirst); },
    setOnVideo: (onVideo) => { set({ onVideo }); persist(KEYS.onVideo, onVideo); },
    setTranslateVideo: (translateVideo) => { set({ translateVideo }); persist(KEYS.translateVideo, translateVideo); },
    setLink: (link) => set({ link }),
    setVideo: (video) => set({ video }),
    view: (on) => set((state) => ({ viewers: Math.max(0, state.viewers + (on ? 1 : -1)) })),
    hydrate: async () => {
      const { ServiceFactory } = await import('../services/ServiceFactory');
      const service = ServiceFactory.getSettingsService();
      const [muteGate, chatbox, chatboxTranslationFirst, onVideo, translateVideo] = await Promise.all([
        service.getSetting<unknown>(KEYS.muteGate, true),
        service.getSetting<unknown>(KEYS.chatbox, 'off'),
        service.getSetting<unknown>(KEYS.chatboxTranslationFirst, false),
        service.getSetting<unknown>(KEYS.onVideo, 'ask'),
        service.getSetting<unknown>(KEYS.translateVideo, false),
      ]);
      set({
        muteGate: muteGate !== false,
        chatbox: CHATBOX.includes(chatbox as ChatboxShows) ? (chatbox as ChatboxShows) : 'off',
        chatboxTranslationFirst: chatboxTranslationFirst === true,
        onVideo: ON_VIDEO.includes(onVideo as OnVideo) ? (onVideo as OnVideo) : 'ask',
        translateVideo: translateVideo === true,
      });
    },
  })),
);

/** Whether the user's own leg is heard as silence now: the gate on, VRChat answering, and muted there. */
export function vrchatHolds(state: Pick<VRChatStore, 'muteGate' | 'link'> = useVRChatStore.getState()): boolean {
  return state.muteGate && state.link.connected && state.link.muted === true;
}
