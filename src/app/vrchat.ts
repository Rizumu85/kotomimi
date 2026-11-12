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
import { VIDEO_ORIGIN, type Entry, type Row } from '../lib/projection/types';
import type { LegName } from '../lib/conversation/types';
import type { LegPace, SideHandle } from '../lib/session/run';
import type { Runner } from '../lib/session/runner';
import type { Readable } from '../lib/view/conversationView';
import { useCoachingStore } from '../stores/coachingStore';
import useAudioStore from '../stores/audioStore';
import { getProvider } from '../providers/registry';
import { useProviderStore } from '../stores/providerStore';
import useSettingsStore from '../stores/settingsStore';
import { useSubtitleLookStore } from '../stores/subtitleLookStore';
import { useVRChatStore, type ChatboxShows, type OnVideo, type VideoApart, type VRChatLink } from '../stores/vrchatStore';
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
  /**
   * Fork: the other side's languages — their main one, and the one lit beside it — and whether the user's sentences in
   * them are translated back into their own (`speakBoth`): what a sentence the user said in one goes up as
   * (`finishedLine`), and how many translations a sentence of theirs waits for. Absent: none known.
   */
  theirs?(): Theirs | undefined;
  /** The conversation emptied (a clear, a new run): what waits to be sent was said there, and is not sent. */
  onReset?(listener: () => void): () => void;
  store: typeof useVRChatStore;
  /** The other side's sound by channel (`participantSplit`): absent, a video is only ever heard faster. */
  split?: Pick<ParticipantSplit, 'onHearing' | 'onShared' | 'setMode' | 'spatialSeen'>;
  /** Whether the run's provider can hear a video's words apart: one whose segments state their origins (Kotomimi's own). */
  laneOffered?(): boolean;
  /** The least time between two chatbox lines: VRChat drops lines sent faster. */
  chatboxGapMs?: number;
  /** How long a question about a video waits for its answer before faster is chosen (`ASK_WAIT_MS`). */
  askWaitMs?: number;
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
 * The most anything that goes up holds the chatbox from what comes after it, a whole line or a page of a long one: the
 * same rule for both. A full chatbox of Chinese or Japanese, or two translations, takes this long to read; at 6 s a
 * line that fitted was gone before it was read, while the same words cut into pages stayed (the user, 2026-11-11).
 */
const CHATBOX_HOLD_MOST_S = 12;

/** Reading time for the visible chatbox text, independent of recognition/subtitle pacing. */
export function chatboxReadingMs(text: string): number {
  const visible = [...text.split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n')].slice(0, CHATBOX_MOST);
  let seconds = 1;
  for (const character of visible) {
    if (/\s/u.test(character)) continue;
    seconds += /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(character) ? 1 / 6 : 1 / 22;
  }
  return Math.round(Math.max(3, Math.min(CHATBOX_HOLD_MOST_S, seconds)) * 1000);
}

/** What goes up after a wait: every line waiting that fits together, oldest first. The talk has moved on: what does not fit is dropped. */
export function chatboxWaiting(waiting: readonly string[]): string {
  let lines = waiting[waiting.length - 1];
  for (let i = waiting.length - 2; i >= 0; i--) {
    const more = `${waiting[i]}\n${lines}`;
    if ([...more].length > CHATBOX_MOST) break;
    lines = more;
  }
  return lines;
}

/** Where a page may end, best first: after a sentence, after a clause, at a space. */
const SENTENCE_END = /[。！？!?.…]/u;
const CLAUSE_END = /[，、,;；:：）)」』]/u;

/**
 * One line in pages the chatbox holds: whole where it fits, else cut where a page can best end — after a sentence,
 * else a clause, else a space, else where the room runs out — never in its first half. A page that does not end a
 * sentence says it goes on (…).
 */
function pagesOf(line: string): string[] {
  const pages: string[] = [];
  let rest = [...line.trim()];
  while (rest.length > CHATBOX_MOST) {
    const room = CHATBOX_MOST - 1;
    const least = Math.floor(room / 2);
    const lastWhere = (test: (c: string) => boolean) => {
      for (let i = room; i >= least; i--) if (test(rest[i - 1])) return i;
      return -1;
    };
    let at = lastWhere((c) => SENTENCE_END.test(c));
    const sentence = at > 0;
    if (!sentence) at = lastWhere((c) => CLAUSE_END.test(c));
    if (at < 0) at = lastWhere((c) => /\s/u.test(c));
    if (at < 0) at = room;
    const page = rest.slice(0, at).join('').trim();
    pages.push(sentence ? page : `${page}…`);
    rest = [...rest.slice(at).join('').trim()];
  }
  if (rest.length > 0) pages.push(rest.join(''));
  return pages;
}

/**
 * What goes up for a finished line, page by page. The chatbox holds 144 characters and VRChat cuts the rest, so a
 * longer line goes up in pages, one after another, rather than cut short with its end lost (the user, 2026-11-04).
 * Two lines that fit together go up together; two that do not, each in its own pages, in the order they are shown.
 */
export function chatboxPages(line: string): string[] {
  if ([...line].length <= CHATBOX_MOST) return [line];
  return line.split('\n').filter((part) => part.trim()).flatMap(pagesOf);
}

/**
 * A sentence of the user's that is done, as it goes above their avatar: its own words and its translation final.
 * Coached and spoken, it is the sentence as they said it, once that is final — what answers it is feedback for them,
 * never shown to others. With both shown, each has a line of its own: the original first, or — `translationFirst` —
 * the translation. With the original alone (`source`), it goes up once its own words are final, with no translation
 * waited for. Null while it is not done, or for anything else.
 */
const base = (code: string) => code.toLowerCase().split(/[-_]/)[0];

/** Fork: the other side's languages (their main one first, then the one lit), and whether the user's speech in them is translated back. */
export interface Theirs { languages: readonly string[]; back: boolean }

/** Each answer's text, in order: one per translation segment (the second language lit gives a sentence two). */
export const answersOf = (rows: readonly Row[]): string[] => {
  const out: { id: string; text: string }[] = [];
  for (const row of rows) {
    if (row.purpose === 'feedback') continue;
    if (out[out.length - 1]?.id !== row.segmentId) out.push({ id: row.segmentId, text: '' });
    out[out.length - 1].text += row.text;
  }
  return out.map((answer) => answer.text.trim()).filter(Boolean);
};

/**
 * With two languages lit a sentence has two translations, each on a line of its own; where the two and the original do
 * not fit the chatbox together, the original goes, and the two go up alone (the user, 2026-11-08). `settled`: the
 * second will not come — a later sentence of the user's is already translated, and translations are done in order.
 */
export function finishedLine(entry: Entry, shows: ChatboxShows, said = false, translationFirst = false, theirs?: Theirs, settled = false): string | null {
  if (shows === 'off' || entry.kind !== 'exchange' || entry.leg !== 'speaker') return null;
  // Speech already in the other language is shown as said unless the user enabled translation back into their own.
  const inTheirs = theirs !== undefined && entry.source.length > 0 && entry.source.every((row) => row.language !== undefined && theirs.languages.some((code) => base(code) === base(row.language!)));
  if (said || shows === 'source' || (inTheirs && !theirs.back)) {
    const words = textOf(entry.source);
    return entry.source.length > 0 && entry.source.every((row) => row.final) && words ? words : null;
  }
  if (entry.source.length === 0 || entry.translation.length === 0) return null;
  if (!entry.source.every((row) => row.final) || !entry.translation.every((row) => row.final)) return null;
  const answers = answersOf(entry.translation);
  if (answers.length === 0) return null;
  // Back into their own, a sentence has one; else one for each language of theirs.
  const wanted = inTheirs ? 1 : Math.max(1, theirs?.languages.length ?? 1);
  if (answers.length < wanted && !settled) return null;
  const translation = answers.join('\n');
  if (shows !== 'both') return translation;
  const original = textOf(entry.source);
  const line = translationFirst ? `${translation}\n${original}` : `${original}\n${translation}`;
  return answers.length > 1 && [...line].length > CHATBOX_MOST ? translation : line;
}

export interface VRChatController {
  /** The user's answer to a video; `remember` makes it the setting. */
  answer(choice: Exclude<OnVideo, 'ask'>, remember: boolean): void;
  /** Whether a video's words can be heard apart: `both` is offered only then. */
  laneOffered(): boolean;
  /** The user's "end": the video is over. */
  endVideo(): void;
  stop(): void;
}

/**
 * Fork: a question about a video unanswered this long — the user in VR, the main window out of sight — is answered
 * for them with faster, as where they cannot be asked: the other side's words are not left to wait under the video.
 */
const ASK_WAIT_MS = 12_000;

/** How long the typing bubble stays with no news of the sentence it is for: one that never goes up lets it go. */
const TYPING_HOLD_MS = 8_000;

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
  /** Whether this video's words are to be heard apart as well. */
  let laneWanted = false;
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
    if (lane || !split || !laneWanted || !deps.laneOffered?.() || !runner.openSide || !runner.sideOffered?.('participant')) return false;
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
  const apply = (choice: Exclude<OnVideo, 'ask'>, auto: boolean) => {
    whole();
    const pace = choice === 'pause' ? 'paused' : 'quick';
    laneWanted = choice === 'both';
    setPace(pace);
    store.getState().setVideo({ kind: 'on', pace, auto });
    if (pace === 'quick') listen();
  };
  // A video under way follows a change between hearing the people and hearing both.
  offs.push(store.subscribe((s) => s.onVideo, (on) => {
    const video = store.getState().video;
    if (stopped || video.kind !== 'on' || (on !== 'quick' && on !== 'both')) return;
    laneWanted = on === 'both';
    if (!video.apart) return;
    if (!laneWanted) { closeLane(); mark('removed'); } else if (openLane()) mark('separated');
  }));
  ipc.receive?.('vrchat:video', () => {
    if (stopped || !running() || !deps.legs().includes('participant')) return;
    // A video already heard to (the next of a playlist): what is on stays on.
    if (store.getState().video.kind !== 'none') return;
    const on = store.getState().onVideo;
    if (on !== 'ask') return apply(on, false);
    // Asked, where the user can answer; chosen for them where they cannot — shorter stretches lose no one's words.
    if (!deps.canAsk()) return apply('quick', true);
    store.getState().setVideo({ kind: 'asking' });
    later(() => { if (!stopped && store.getState().video.kind === 'asking') apply('quick', true); }, deps.askWaitMs ?? ASK_WAIT_MS);
  });
  ipc.receive?.('vrchat:world', () => { if (!stopped) endVideo(); });

  // ── The chatbox ───────────────────────────────────────────────────────────
  const sent = new Set<string>();
  /** The lines waiting, each in its pages. */
  const queue: string[][] = [];
  /** The pages still to go of the line going up now. */
  let rest: string[] = [];
  let sending = false;
  /** Whether a line may go up now: asked again at the moment it is sent, as the setting may have changed while it waited. */
  const allowed = () => !stopped && store.getState().chatbox !== 'off';
  /**
   * Fork: VRChat's typing bubble over the avatar while a sentence of the user's is on its way to the chatbox, from the
   * moment it is heard to the moment it goes up, as Kikitan shows it: the others see that an answer is coming. What it
   * is for: the user's spoken sentences not sent yet, and lines waiting their turn. A sentence that never goes up (its
   * translation failed, its feedback is the user's alone) lets it go after `TYPING_HOLD_MS` with no change to it.
   */
  let typing = false;
  let typingFor = '';
  let typingArmed = 0;
  const setTyping = (on: boolean) => {
    const mine = ++typingArmed;
    if (on) later(() => { if (mine === typingArmed && !stopped) setTyping(false); }, TYPING_HOLD_MS);
    if (on === typing) return;
    typing = on;
    void ipc.invoke('vrchat:typing', { on }).catch(() => {});
  };
  const showTyping = () => {
    if (!allowed() || !running()) { typingFor = ''; setTyping(false); return; }
    const state = deps.view.get();
    const typed = new Set((state.legs ?? []).flatMap((leg) => leg.segments.filter((s) => TYPED.test(s.origin ?? '')).map((s) => s.id)));
    const coming = state.entries
      .filter((entry): entry is Extract<Entry, { kind: 'exchange' }> => entry.kind === 'exchange' && entry.leg === 'speaker' && !sent.has(entry.id)
        && !entry.source.some((row) => typed.has(row.segmentId)) && textOf(entry.source).trim() !== '')
      .map((entry) => `${entry.id}:${textOf(entry.source)}`)
      .join('|');
    const waiting = queue.length > 0 || rest.length > 0 ? `waiting:${queue.length}:${rest.length}` : '';
    const now = `${coming}${waiting}`;
    if (now === '') { typingFor = ''; setTyping(false); return; }
    // Only news of the sentence holds it longer: the other side talking on does not.
    if (now !== typingFor) { typingFor = now; setTyping(true); }
  };
  const pump = () => {
    if (sending) return;
    if (!allowed()) { queue.length = 0; rest = []; return; }
    let line: string;
    if (rest.length > 0) {
      line = rest.shift()!;
    } else {
      if (queue.length === 0) return;
      // The newest line: one of several pages goes up page by page; one that fits, together with the ones of a page
      // that waited before it, as many as fit. What is older than that, the talk has moved past.
      const newest = queue[queue.length - 1];
      if (newest.length > 1) {
        [line, ...rest] = newest;
      } else {
        let single = queue.length - 1;
        while (single > 0 && queue[single - 1].length === 1) single--;
        line = chatboxWaiting(queue.slice(single).map((pages) => pages[0]));
      }
      queue.length = 0;
    }
    sending = true;
    void ipc.invoke('vrchat:chatbox', { text: line }).catch(() => {});
    showTyping();
    later(() => { sending = false; pump(); }, Math.max(gap, chatboxReadingMs(line)));
  };
  const look = () => {
    const shows = store.getState().chatbox;
    const state = deps.view.get();
    const coached = deps.coached();
    const theirs = deps.theirs?.();
    // The segments typed text opened: everything else of the user's leg was spoken.
    const typed = new Set((state.legs ?? []).flatMap((leg) => leg.segments.filter((s) => TYPED.test(s.origin ?? '')).map((s) => s.id)));
    // Feedback is private; a coached speaker's own-language sentence is a translation instead.
    // An undecided partial must not reach the chatbox before the final language arrives.
    const feedback = (entry: Extract<Entry, { kind: 'exchange' }>) => coached
      && !theirs?.back
      && !entry.translation.some((row) => row.purpose === 'translation')
      && !entry.source.some((row) => typed.has(row.segmentId))
      && !(theirs && entry.source.length > 0 && entry.source.every((row) => row.language && !theirs.languages.some((code) => base(code) === base(row.language!))));
    // The last sentence of the user's translated as it would go up, for the settings to show the chatbox with: not
    // one answered with feedback, which is theirs alone.
    for (let i = state.entries.length - 1; i >= 0; i--) {
      const entry = state.entries[i];
      if (entry.kind !== 'exchange' || entry.leg !== 'speaker') continue;
      if (feedback(entry)) continue;
      if (finishedLine(entry, 'translation') === null) continue;
      store.getState().setRecent({ said: textOf(entry.source), translation: answersOf(entry.translation).join('\n') });
      break;
    }
    // Said with the chatbox off: for the user alone, and not sent once it is turned on again — whatever of it is
    // translated only then. (Turned off to say something aside, the aside went up with the next sentence.)
    if (shows === 'off') {
      for (const entry of state.entries) {
        if (entry.kind === 'exchange' && entry.leg === 'speaker' && entry.source.length > 0 && entry.source.every((row) => row.final)) sent.add(entry.id);
      }
      showTyping();
      return;
    }
    // The newest of the user's sentences that is translated: every one before it has all the translations it will get.
    let newest = -1;
    state.entries.forEach((entry, i) => { if (entry.kind === 'exchange' && entry.leg === 'speaker' && answersOf(entry.translation).length > 0) newest = i; });
    state.entries.forEach((entry, i) => {
      if (entry.kind !== 'exchange' || sent.has(entry.id)) return;
      const said = feedback(entry);
      const line = finishedLine(entry, shows, said, store.getState().chatboxTranslationFirst, theirs, i < newest);
      if (line === null) return;
      sent.add(entry.id);
      queue.push(chatboxPages(line));
    });
    pump();
    showTyping();
  };
  // What is finished on screen when this begins was said before: it is not sent now. A sentence still under way is.
  for (const entry of deps.view.get().entries) if (finishedLine(entry, 'translation') !== null) sent.add(entry.id);
  offs.push(deps.view.subscribe(look));
  if (deps.onReset) offs.push(deps.onReset(() => { queue.length = 0; rest = []; }));

  // ── Following the run, the settings and the views ─────────────────────────
  let wasRunning = running();
  offs.push(runner.state.subscribe(() => {
    const now = running();
    // The run is over: a video it heard is forgotten, the pace is the usual for the next.
    if (wasRunning && !now) { endVideo(); queue.length = 0; rest = []; showTyping(); }
    wasRunning = now;
    watch();
  }));
  offs.push(store.subscribe(() => {
    if (store.getState().chatbox === 'off') { queue.length = 0; rest = []; }
    showTyping();
    watch();
  }));
  watch();

  return {
    answer(choice, remember) {
      if (remember) store.getState().setOnVideo(choice);
      apply(choice, false);
    },
    laneOffered: () => deps.laneOffered?.() === true,
    endVideo,
    stop() {
      if (stopped) return;
      // The pace back to the usual first: a paused leg must not stay paused for the runs after.
      endVideo();
      typingFor = '';
      setTyping(false);
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
    theirs: () => {
      const { selected, entries, models } = useProviderStore.getState();
      const entry = selected ? entries[selected] : undefined;
      const provider = selected ? getProvider(selected) : undefined;
      if (!entry || !provider) return undefined;
      // Fork: the other side's languages — their main one, and the one lit beside it — and whether the user speaks
      // them ("我也会说").
      const listed = models[selected!] ?? [];
      const more = provider.languages.more?.(entry.settings, listed, entry.pair);
      const lit = more?.theirs?.lit;
      const languages = [entry.pair.target, ...(lit && lit !== 'auto' ? [lit] : [])];
      const base = (code: string) => code.toLowerCase().split(/[-_]/)[0];
      const speaks = more?.mine ? more.mine.chosen.some((code: string) => languages.some((one) => base(one) === base(code))) : true;
      return { languages, back: speaks && provider.languages.detection?.(entry.settings, listed, entry.pair).both.on === true };
    },
    onReset: (listener) => session.runner.conversation.onReset(() => listener()),
    store: useVRChatStore,
    split: participantSplit,
    laneOffered: () => useProviderStore.getState().selected === 'localai',
  });
  setVRChatController(controller);
  return controller;
}
