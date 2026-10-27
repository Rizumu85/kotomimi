// src/app/vrchat.ts
/**
 * Fork: VRChat on the same computer, as the page uses it (`electron/vrchat.js`
 * is the main process's side; the settings are `vrchatStore`).
 *
 * - **The mute.** Asked while a run hears the user and the gate is on, or
 *   while the settings card is open: the user's leg hears silence while they
 *   are muted in VRChat (`vrchatHolds`, read by the microphone source).
 * - **The chatbox.** Each of the user's sentences, once it and its
 *   translation are final, goes above their avatar — spoken or typed. While
 *   coached the user speaks the other side's language and gets feedback, not
 *   a translation: their spoken sentence goes up as they said it, the
 *   feedback is for them alone; typed text is translated as ever.
 * - **A video.** When a world's video player begins one during a run that
 *   hears the other side, the other side's leg is heard faster, or not at
 *   all, as the setting says — or the user is asked, where they can be: with
 *   the subtitle strip passing the mouse through, they cannot, and faster is
 *   chosen for them. Faster begins with shorter stretches, and listens
 *   (`stereoSplit.ts`): a video whose sound is the same in both channels has
 *   no place in the world, and is taken out of the other side's sound — the
 *   stretches as usual again, and, where the user asked and the provider can,
 *   the video's own words heard and translated apart (`Run.openSide`). It
 *   ends with another world, the run's end, the user's "end", or, once taken
 *   out, when the video's sound has stopped; VRChat writes nothing then.
 */
import { createVideoJudge, participantSplit, type ParticipantSplit } from '../lib/audio/capture/stereoSplit';
import { VIDEO_ORIGIN, type Entry } from '../lib/projection/types';
import type { LegName } from '../lib/conversation/types';
import type { LegPace, SideHandle } from '../lib/session/run';
import type { Runner } from '../lib/session/runner';
import type { Readable } from '../lib/view/conversationView';
import { useCoachingStore } from '../stores/coachingStore';
import useAudioStore from '../stores/audioStore';
import { useProviderStore } from '../stores/providerStore';
import useSettingsStore from '../stores/settingsStore';
import { useSubtitleLookStore } from '../stores/subtitleLookStore';
import { useVRChatStore, type ChatboxShows, type VideoApart, type VRChatLink } from '../stores/vrchatStore';
import { setVRChatController, vrchatOffered } from './vrchatHandle';

export interface VRChatIpc {
  invoke(channel: string, data?: unknown): Promise<unknown>;
  receive?(channel: string, fn: (...args: unknown[]) => void): void;
}

export interface VRChatDeps {
  ipc: VRChatIpc;
  runner: Pick<Runner, 'setLegPace'> & Partial<Pick<Runner, 'openSide' | 'sideOffered'>> & { state: { getState(): { phase: string }; subscribe(listener: () => void): () => void } };
  /** The conversation as drawn, and its segments: a typed sentence is told by its origin (`pipeline.ts`). */
  view: Readable<{ entries: readonly Entry[]; legs?: readonly { segments: readonly { id: string; origin?: string }[] }[] }>;
  /** The legs a run opens now (the audio mode's). */
  legs(): readonly LegName[];
  /** Whether the user can be asked now: false while the subtitle strip lets the mouse pass through. */
  canAsk(): boolean;
  coached(): boolean;
  /** The conversation emptied (a clear, a new run): what waits to be sent was said there, and is not sent. */
  onReset?(listener: () => void): () => void;
  store: typeof useVRChatStore;
  /** The other side's sound by channel (`participantSplit`): absent, a video is only ever heard faster. */
  split?: Pick<ParticipantSplit, 'onHearing' | 'onShared' | 'setMode' | 'spatialSeen'>;
  /** Whether the run's provider can hear a video's words apart: one whose segments state their origins (Kotomimi's own). */
  laneOffered?(): boolean;
  /** The least time between two chatbox lines: VRChat drops lines sent faster. */
  chatboxGapMs?: number;
  setTimeout?(fn: () => void, ms: number): unknown;
}

/** The main process's word for VRChat's side, held to its shape. */
export function linkOf(value: unknown): VRChatLink {
  const v = (value ?? {}) as Partial<VRChatLink>;
  return { found: v.found === true, connected: v.connected === true, muted: typeof v.muted === 'boolean' ? v.muted : null };
}

/** The text of rows, as drawn: one after another. */
const textOf = (rows: readonly { text: string }[]) => rows.map((row) => row.text).join('').trim();

/** The origin the pipeline gives a typed sentence (`appendText` in `pipeline.ts`). */
const TYPED = /^sokuji_typed_/;

/** The chatbox's length, as the main process cuts to (`CHATBOX_MOST` in `electron/vrchat.js`). */
const CHATBOX_MOST = 144;

/**
 * Two lines within the chatbox's length: each whole where they fit; else the shorter whole where it takes no more
 * than half, and the other cut to the rest — so that neither is lost to the cut of the whole.
 */
function twoLines(first: string, second: string): string {
  const a = [...first];
  const b = [...second];
  const room = CHATBOX_MOST - 1;
  if (a.length + b.length <= room) return `${first}\n${second}`;
  const half = Math.floor(room / 2);
  const cut = (chars: string[], most: number) => (chars.length <= most ? chars.join('') : `${chars.slice(0, most - 1).join('')}…`);
  const keepA = a.length <= half ? a.length : b.length <= half ? room - b.length : half;
  return `${cut(a, keepA)}\n${cut(b, room - Math.min(a.length, keepA))}`;
}

/**
 * A sentence of the user's that is done, as it goes above their avatar: its own words and its translation final.
 * Coached and spoken, it is the sentence as they said it, once that is final — what answers it is feedback for them,
 * never shown to others. With both shown, each has a line of its own: the original first, or — `translationFirst` —
 * the translation. Null while it is not done, or for anything else.
 */
export function finishedLine(entry: Entry, shows: ChatboxShows, said = false, translationFirst = false): string | null {
  if (shows === 'off' || entry.kind !== 'exchange' || entry.leg !== 'speaker') return null;
  if (said) {
    const words = textOf(entry.source);
    return entry.source.length > 0 && entry.source.every((row) => row.final) && words ? words : null;
  }
  if (entry.source.length === 0 || entry.translation.length === 0) return null;
  if (!entry.source.every((row) => row.final) || !entry.translation.every((row) => row.final)) return null;
  const translation = textOf(entry.translation);
  if (!translation) return null;
  if (shows !== 'both') return translation;
  const original = textOf(entry.source);
  return translationFirst ? twoLines(translation, original) : twoLines(original, translation);
}

export interface VRChatController {
  /** The user's answer to a video: a pace, or carry on as usual; `remember` makes it the setting. */
  answer(choice: 'quick' | 'pause' | 'normal', remember: boolean): void;
  /** The user's "end": the video is over. */
  endVideo(): void;
  stop(): void;
}

const PACE_OF: Record<'quick' | 'pause', Exclude<LegPace, 'normal'>> = { quick: 'quick', pause: 'paused' };

export function startVRChat(deps: VRChatDeps): VRChatController {
  const { ipc, runner, store } = deps;
  const later = deps.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const gap = deps.chatboxGapMs ?? 1500;
  const offs: Array<() => void> = [];
  const running = () => runner.state.getState().phase === 'running';
  /** Stopped: nothing it was told after, and nothing it scheduled, does anything. */
  let stopped = false;

  // ── The mute ──────────────────────────────────────────────────────────────
  // Null until first said: a page loaded again says so at once, ending what the last page had asked for.
  let watching: boolean | null = null;
  const watch = () => {
    if (stopped) return;
    const s = store.getState();
    const want = s.viewers > 0 || (running() && s.muteGate && deps.legs().includes('speaker'));
    if (want === watching) return;
    watching = want;
    // Not asked any longer, the last answer is not the mute now: a microphone opened outside a run (the settings'
    // test) must not be heard as silence on its word.
    if (!want) store.getState().setLink({ ...s.link, muted: null });
    void ipc.invoke('vrchat:watch', { on: want }).then((state) => { if (state && watching) store.getState().setLink(linkOf(state)); }, () => {});
  };
  ipc.receive?.('vrchat:state', (state) => { if (!stopped) store.getState().setLink(linkOf(state)); });

  // ── A video ───────────────────────────────────────────────────────────────
  const setPace = (pace: LegPace) => runner.setLegPace('participant', pace);
  const { split } = deps;
  /** Listening for whether the video can be taken out, and then for its end. */
  let hearing: (() => void) | null = null;
  /** The video's own lane, opening or open: what closes it, once it has. */
  let lane: Promise<SideHandle | null> | null = null;
  /** What the video state says of its sound: taken out, or heard apart as well — under these origins, once open. */
  const mark = (apart: VideoApart, laneOrigin?: string) => {
    const video = store.getState().video;
    if (video.kind !== 'on' || (video.apart === apart && video.laneOrigin === laneOrigin)) return;
    const { laneOrigin: _gone, ...rest } = video;
    store.getState().setVideo({ ...rest, apart, ...(laneOrigin ? { laneOrigin } : {}) });
  };
  const closeLane = () => {
    const opening = lane;
    lane = null;
    void opening?.then((handle) => handle?.close());
  };
  /** Opens the video's lane where the user asked and the run can: false where it does not. */
  const openLane = (): boolean => {
    if (lane || !split || !store.getState().translateVideo || !deps.laneOffered?.() || !runner.openSide || !runner.sideOffered?.('participant')) return false;
    // Ended on its own (its session failed): the video's sound stays out, its words are no longer heard.
    const ended = () => { if (lane === opening) { lane = null; mark('removed'); } };
    const opening: Promise<SideHandle | null> = runner.openSide('participant', { prefix: VIDEO_ORIGIN, feed: (deliver) => split.onShared(deliver), onEnded: ended });
    lane = opening;
    void opening.then((handle) => {
      // Closed while it opened: it goes at once. Not opened: the video's sound is only taken out.
      if (lane !== opening) void handle?.close();
      else if (!handle) ended();
      else mark('separated', handle.origin);
    }, ended);
    return true;
  };
  const takeOut = () => {
    split?.setMode('people');
    setPace('normal');
    mark(openLane() ? 'separated' : 'removed');
  };
  const listen = () => {
    if (!split || hearing) return;
    const judge = createVideoJudge();
    hearing = split.onHearing((heard) => {
      const said = judge.hear(heard, split.spatialSeen());
      if (said === 'apart') takeOut();
      else if (said === 'over') endVideo();
    });
  };
  /** The other side's sound whole again: nothing listened for, no lane. */
  const whole = () => {
    hearing?.();
    hearing = null;
    closeLane();
    split?.setMode('mix');
  };
  const endVideo = () => {
    whole();
    if (store.getState().video.kind === 'none') return;
    setPace('normal');
    store.getState().setVideo({ kind: 'none' });
  };
  const apply = (choice: 'quick' | 'pause', auto: boolean) => {
    whole();
    setPace(PACE_OF[choice]);
    store.getState().setVideo({ kind: 'on', pace: PACE_OF[choice] === 'paused' ? 'paused' : 'quick', auto });
    if (choice === 'quick') listen();
  };
  // The lane follows its setting while the video's sound is out.
  offs.push(store.subscribe((s) => s.translateVideo, (on) => {
    const video = store.getState().video;
    if (stopped || video.kind !== 'on' || !video.apart) return;
    if (!on) { closeLane(); mark('removed'); } else if (openLane()) mark('separated');
  }));
  ipc.receive?.('vrchat:video', () => {
    if (stopped || !running() || !deps.legs().includes('participant')) return;
    // A video already heard to (the next of a playlist): what is on stays on.
    if (store.getState().video.kind !== 'none') return;
    const on = store.getState().onVideo;
    if (on === 'normal') return;
    if (on === 'quick' || on === 'pause') return apply(on, false);
    // Asked, where the user can answer; chosen for them where they cannot — shorter stretches lose no one's words.
    if (deps.canAsk()) store.getState().setVideo({ kind: 'asking' });
    else apply('quick', true);
  });
  ipc.receive?.('vrchat:world', () => { if (!stopped) endVideo(); });

  // ── The chatbox ───────────────────────────────────────────────────────────
  const sent = new Set<string>();
  const queue: string[] = [];
  let sending = false;
  /** Whether a line may go up now: asked again at the moment it is sent, as the setting may have changed while it waited. */
  const allowed = () => !stopped && store.getState().chatbox !== 'off';
  const pump = () => {
    if (sending) return;
    if (!allowed()) { queue.length = 0; return; }
    const line = queue.shift();
    if (line === undefined) return;
    sending = true;
    void ipc.invoke('vrchat:chatbox', { text: line }).catch(() => {});
    later(() => { sending = false; pump(); }, gap);
  };
  const look = () => {
    const shows = store.getState().chatbox;
    const state = deps.view.get();
    const coached = deps.coached();
    // The segments typed text opened: everything else of the user's leg was spoken.
    const typed = new Set((state.legs ?? []).flatMap((leg) => leg.segments.filter((s) => TYPED.test(s.origin ?? '')).map((s) => s.id)));
    for (const entry of state.entries) {
      if (entry.kind !== 'exchange' || sent.has(entry.id)) continue;
      const said = coached && !entry.source.some((row) => typed.has(row.segmentId));
      const line = finishedLine(entry, shows, said, store.getState().chatboxTranslationFirst);
      if (line === null) continue;
      sent.add(entry.id);
      queue.push(line);
    }
    pump();
  };
  // What is finished on screen when this begins was said before: it is not sent now. A sentence still under way is.
  for (const entry of deps.view.get().entries) if (finishedLine(entry, 'translation') !== null) sent.add(entry.id);
  offs.push(deps.view.subscribe(look));
  if (deps.onReset) offs.push(deps.onReset(() => { queue.length = 0; }));

  // ── Following the run, the settings and the views ─────────────────────────
  let wasRunning = running();
  offs.push(runner.state.subscribe(() => {
    const now = running();
    // The run is over: a video it heard is forgotten, the pace is the usual for the next.
    if (wasRunning && !now) endVideo();
    wasRunning = now;
    watch();
  }));
  offs.push(store.subscribe(watch));
  watch();

  return {
    answer(choice, remember) {
      if (remember) store.getState().setOnVideo(choice);
      if (choice === 'normal') {
        whole();
        setPace('normal');
        store.getState().setVideo({ kind: 'none' });
      } else {
        apply(choice, false);
      }
    },
    endVideo,
    stop() {
      if (stopped) return;
      // The pace back to the usual first: a paused leg must not stay paused for the runs after.
      endVideo();
      stopped = true;
      for (const off of offs.splice(0)) off();
      queue.length = 0;
      if (watching) void ipc.invoke('vrchat:watch', { on: false }).catch(() => {});
      watching = false;
    },
  };
}

let building: Promise<VRChatController> | null = null;

/** The page's one controller (desktop on Windows): over the app session and window.electron. Null elsewhere. */
export function getVRChatController(): Promise<VRChatController | null> {
  if (!vrchatOffered()) return Promise.resolve(null);
  // One build, however many ask while it is under way (React's strict mode runs the boot effect twice).
  building ??= build();
  return building;
}

async function build(): Promise<VRChatController> {
  const { getAppSession } = await import('./session');
  const session = getAppSession();
  const controller = startVRChat({
    ipc: (window as unknown as { electron: VRChatIpc }).electron,
    runner: session.runner,
    view: { get: () => session.view.get(), subscribe: (listener) => session.view.subscribe(listener) },
    legs: () => { const mode = useAudioStore.getState().mode; return mode === 'both' ? ['speaker', 'participant'] : [mode]; },
    canAsk: () => !(useSettingsStore.getState().subtitleModeActive && useSubtitleLookStore.getState().through),
    coached: () => useCoachingStore.getState().coached,
    onReset: (listener) => session.runner.conversation.onReset(() => listener()),
    store: useVRChatStore,
    split: participantSplit,
    laneOffered: () => useProviderStore.getState().selected === 'localai',
  });
  setVRChatController(controller);
  return controller;
}
