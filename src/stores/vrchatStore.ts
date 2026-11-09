/**
 * Fork: VRChat on the same computer (`electron/vrchat.js`, `src/app/vrchat.ts`) —
 * four settings, and what the app knows of VRChat now.
 *
 * - `muteGate`: muted in VRChat, the user's own leg is not heard (on by
 *   default). Off for a player who keeps silent in VRChat and still wants
 *   what they say translated into the chatbox.
 * - `chatbox`: what goes above the user's avatar — off, what they said
 *   alone (`source`: for a player who has it written for them rather than
 *   translated), the translation, or the original with it, on lines of
 *   their own, the original first or — `chatboxTranslationFirst` — the
 *   translation. Typed text goes the same way. `chatboxLast`, the last
 *   look that showed something, is what turning it on again shows (the
 *   main panel's switch and the wrist panel's, `turnChatbox`), and its
 *   being set at all is what puts that switch on the main panel.
 * - `onVideo`: when a world's video player begins a video — ask, hear the
 *   people (`quick`), hear the people and the video apart (`both`), or not
 *   hear the other side at all. The first two take the video's sound out
 *   where it has no direction in the world, and hear the other side in
 *   shorter stretches where it has.
 *
 * A store of its own, as the fork's other settings are, with the settings
 * service imported when first used.
 */
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

export type ChatboxShows = 'off' | 'source' | 'translation' | 'both';
export type ChatboxOn = Exclude<ChatboxShows, 'off'>;
export type OnVideo = 'ask' | 'quick' | 'both' | 'pause';
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
/** The user's last finished sentence and its translation: what the settings show the chatbox with (`VRChatSection`). */
export interface ChatboxSample { said: string; translation: string }
/** What VRChat's side says: a log of a running VRChat was found, its OSCQuery answers the mute, and the mute. */
export interface VRChatLink { found: boolean; connected: boolean; muted: boolean | null }

const KEYS = {
  muteGate: 'settings.vrchat.muteGate',
  chatbox: 'settings.vrchat.chatbox',
  chatboxTranslationFirst: 'settings.vrchat.chatboxTranslationFirst',
  chatboxLast: 'settings.vrchat.chatboxLast',
  onVideo: 'settings.vrchat.onVideo',
  /** Older builds' switch for `both`: read once, into `onVideo`. */
  translateVideo: 'settings.vrchat.translateVideo',
} as const;
const CHATBOX: readonly ChatboxShows[] = ['off', 'source', 'translation', 'both'];
const ON_VIDEO: readonly OnVideo[] = ['ask', 'quick', 'both', 'pause'];

interface VRChatStore {
  muteGate: boolean;
  chatbox: ChatboxShows;
  chatboxTranslationFirst: boolean;
  /** The last look that showed something; null until the user has chosen one. */
  chatboxLast: ChatboxOn | null;
  onVideo: OnVideo;
  link: VRChatLink;
  video: VideoState;
  recent: ChatboxSample | null;
  /** How many views want the link kept fresh now (the settings card): the mute is asked while one does. */
  viewers: number;
  setMuteGate(on: boolean): void;
  setChatbox(shows: ChatboxShows): void;
  /** Off, or back to the last look that showed something (the translation, if none). */
  turnChatbox(on: boolean): void;
  setChatboxTranslationFirst(on: boolean): void;
  setOnVideo(on: OnVideo): void;
  setLink(link: VRChatLink): void;
  setVideo(video: VideoState): void;
  setRecent(recent: ChatboxSample): void;
  view(on: boolean): void;
  /** Called once at app boot (`src/routes/Home.tsx`). */
  hydrate(): Promise<void>;
}

const persist = (key: string, value: unknown) => {
  void import('../services/persistSetting').then(({ persistSetting }) => persistSetting(key, value));
};

export const useVRChatStore = create<VRChatStore>()(
  subscribeWithSelector((set, get) => ({
    muteGate: true,
    chatbox: 'off',
    chatboxTranslationFirst: false,
    chatboxLast: null,
    onVideo: 'ask',
    link: { found: false, connected: false, muted: null },
    video: { kind: 'none' },
    recent: null,
    viewers: 0,
    setMuteGate: (muteGate) => { set({ muteGate }); persist(KEYS.muteGate, muteGate); },
    setChatbox: (chatbox) => {
      if (chatbox === 'off') set({ chatbox });
      else {
        set({ chatbox, chatboxLast: chatbox });
        persist(KEYS.chatboxLast, chatbox);
      }
      persist(KEYS.chatbox, chatbox);
    },
    turnChatbox: (on) => {
      const next: ChatboxShows = on ? get().chatboxLast ?? 'translation' : 'off';
      if (next !== get().chatbox) get().setChatbox(next);
    },
    setChatboxTranslationFirst: (chatboxTranslationFirst) => { set({ chatboxTranslationFirst }); persist(KEYS.chatboxTranslationFirst, chatboxTranslationFirst); },
    setOnVideo: (onVideo) => { set({ onVideo }); persist(KEYS.onVideo, onVideo); },
    setLink: (link) => set({ link }),
    setVideo: (video) => set({ video }),
    setRecent: (recent) => set((state) => (state.recent?.said === recent.said && state.recent.translation === recent.translation ? state : { recent })),
    view: (on) => set((state) => ({ viewers: Math.max(0, state.viewers + (on ? 1 : -1)) })),
    hydrate: async () => {
      const { ServiceFactory } = await import('../services/ServiceFactory');
      const service = ServiceFactory.getSettingsService();
      const [muteGate, chatbox, chatboxTranslationFirst, chatboxLast, onVideo, translateVideo] = await Promise.all([
        service.getSetting<unknown>(KEYS.muteGate, true),
        service.getSetting<unknown>(KEYS.chatbox, 'off'),
        service.getSetting<unknown>(KEYS.chatboxTranslationFirst, false),
        service.getSetting<unknown>(KEYS.chatboxLast, null),
        service.getSetting<unknown>(KEYS.onVideo, 'ask'),
        service.getSetting<unknown>(KEYS.translateVideo, false),
      ]);
      // Older builds heard the two mixed ('normal'), which lost people's words, or apart under a switch.
      const both = onVideo === 'normal' || (onVideo === 'quick' && translateVideo === true);
      if (both) persist(KEYS.onVideo, 'both');
      if (translateVideo === true) persist(KEYS.translateVideo, false);
      const shows = CHATBOX.includes(chatbox as ChatboxShows) ? (chatbox as ChatboxShows) : 'off';
      const last = chatboxLast !== 'off' && CHATBOX.includes(chatboxLast as ChatboxShows) ? (chatboxLast as ChatboxOn) : null;
      set({
        muteGate: muteGate !== false,
        chatbox: shows,
        // Builds before `chatboxLast` kept only the look itself.
        chatboxLast: last ?? (shows === 'off' ? null : shows),
        chatboxTranslationFirst: chatboxTranslationFirst === true,
        onVideo: both ? 'both' : ON_VIDEO.includes(onVideo as OnVideo) ? (onVideo as OnVideo) : 'ask',
      });
    },
  })),
);

/** Whether the user's own leg is heard as silence now: the gate on, VRChat answering, and muted there. */
export function vrchatHolds(state: Pick<VRChatStore, 'muteGate' | 'link'> = useVRChatStore.getState()): boolean {
  return state.muteGate && state.link.connected && state.link.muted === true;
}
