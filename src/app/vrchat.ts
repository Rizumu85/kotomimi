// src/app/vrchat.ts
/**
 * Fork: VRChat on the same computer, as the page uses it (`electron/vrchat.js`
 * is the main process's side; the settings are `vrchatStore`).
 *
 * - **The mute.** Asked while a run hears the user and the gate is on, or
 *   while the settings card is open: the user's leg hears silence while they
 *   are muted in VRChat (`vrchatHolds`, read by the microphone source).
 * - **The chatbox.** Each of the user's sentences, once it and its
 *   translation are final, goes above their avatar — spoken or typed; where
 *   the translation is read aloud to the other side, when its reading
 *   begins, so that what is read and what is heard are one sentence. While
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
import { useRoutingStore } from '../stores/routingStore';
import { parseClipKey } from '../lib/audio/playback';
import { speaksAlong, voiceSpeaks, type VoiceChoice } from '../providers/openai/localaiVoice';
import type { LocalAIModel } from '../providers/openai/localaiModels';
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
  view: Readable<{ entries: readonly Entry[]; legs?: readonly { segments: readonly { id: string; origin?: string; ref?: number }[] }[] }>;
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
  /**
   * Fork: the user's translations as they are read aloud to the other side (`Reading`), while a run reads them so.
   * Null, or absent: nothing is read to them, and a line goes up as soon as it is finished.
   */
  reading?(): Reading | null;
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

/**
 * Fork: what is being read aloud of the user's leg: the playback's own queue for it (`ClipQueue.scheduled`), each
 * clip by the segment it reads (`Segment.ref`; none for what is said with no segment of its own).
 */
export interface Reading {
  scheduled(): Array<{ ref: number | undefined; inMs: number }>;
  /** Told when a clip is queued, one ends, or the queue is emptied. */
  subscribe(listener: () => void): () => void;
}

/**
 * How long a line waits for a reading that has not come while nothing else is being read: a sentence the voice
 * passed over, or could not make, goes up all the same.
 */
export const READING_WAIT_MS = 3000;

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
 * never shown to others. Each language has a line of its own. With the original alone (`source`), it goes up once
 * its own words are final, with no translation waited for. Null while it is not done, or for anything else.
 */
const base = (code: string) => code.toLowerCase().split(/[-_]/)[0];

/** Fork: the other side's languages (their main one first, then the one lit), and whether the user's speech in them is translated back. */
export interface Theirs { languages: readonly string[]; back: boolean }

/** Each answer's text, in order: one per translation segment (the second language lit gives a sentence two). */
export const answersOf = (rows: readonly Row[]): { text: string; language?: string }[] => {
  const out: { id: string; text: string; language?: string }[] = [];
  for (const row of rows) {
    if (row.purpose === 'feedback') continue;
    if (out[out.length - 1]?.id !== row.segmentId) out.push({ id: row.segmentId, text: '', language: row.language });
    out[out.length - 1].text += row.text;
  }
  return out.map(({ text, language }) => ({ text: text.trim(), language })).filter((answer) => answer.text);
};

/**
 * Each sentence goes up in language order: the user's own, their main, their second; `translationFirst` puts theirs
 * before the user's own. Every line is kept, paged where needed (the user, 2026-11-15). `settled`: missing answers
 * will not come — a later sentence of the user's is already translated, and translations are done in order.
 */
export function finishedLine(entry: Entry, shows: ChatboxShows, said = false, translationFirst = false, theirs?: Theirs, settled = false): string | null {
  if (shows === 'off' || entry.kind !== 'exchange' || entry.leg !== 'speaker') return null;
  // Fork: heard in none of the user's languages: nothing they said, and nothing to send.
  if (entry.source.some((row) => row.misheard)) return null;
  // Speech already in the other language is shown as said unless the user enabled translation back into their own.
  const inTheirs = theirs !== undefined && entry.source.length > 0 && entry.source.every((row) => row.language !== undefined && theirs.languages.some((code) => base(code) === base(row.language!)));
  if (said || shows === 'source' || (inTheirs && !theirs.back)) {
    const words = textOf(entry.source);
    return entry.source.length > 0 && entry.source.every((row) => row.final) && words ? words : null;
  }
  if (entry.source.length === 0 || entry.translation.length === 0) return null;
  if (!entry.source.every((row) => row.final) || !entry.translation.every((row) => row.final)) return null;
  const answers = answersOf(entry.translation).map(({ text, language }) => ({ text, language: base(language || entry.languages.target) }));
  if (answers.length === 0) return null;
  // Forward and crossing sentences have one answer per language of theirs; with one lit, back has one too.
  const wanted = Math.max(1, theirs?.languages.length ?? 1);
  if (answers.length < wanted && !settled) return null;
  if (shows === 'both') answers.unshift({ text: textOf(entry.source), language: base(entry.source[0].language || entry.languages.source) });
  const own = base(entry.languages.source);
  const other = (theirs?.languages ?? [entry.languages.target]).map(base);
  const order = translationFirst ? [...other, own] : [own, ...other];
  answers.sort((a, b) => {
    const first = order.indexOf(a.language);
    const second = order.indexOf(b.language);
    return (first < 0 ? order.length : first) - (second < 0 ? order.length : second);
  });
  return answers.map((answer) => answer.text).join('\n');
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
  /**
   * Fork: the lines kept back for their reading, oldest first (`Reading`): each with the segments its translations
   * are in. One goes up when the reading of it begins — and with it every line before it, which the voice has then
   * passed over (it reads in order) — or when nothing is read for `READING_WAIT_MS` and its turn has not come.
   */
  const held: Array<{ pages: string[]; refs: number[] }> = [];
  /** The segments the reading has had in its queue, and those of them it has begun. */
  const queued = new Set<number>();
  const begun = new Set<number>();
  let listened: Reading | null = null;
  let unlisten: (() => void) | null = null;
  let startTimer = 0;
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
    const waiting = queue.length > 0 || rest.length > 0 || held.length > 0 ? `waiting:${queue.length}:${rest.length}:${held.length}` : '';
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
    // Read aloud to them, the voice sets the pace: the next sentence goes up when it is read, held only as long as
    // VRChat asks. A line of several pages still gives each its reading time.
    const paced = rest.length === 0 && readingNow() !== null;
    later(() => { sending = false; pump(); }, paced ? gap : Math.max(gap, chatboxReadingMs(line)));
  };
  /** The reading now, listened to while there is one. */
  function readingNow(): Reading | null {
    const reading = allowed() ? deps.reading?.() ?? null : null;
    if (reading !== listened) {
      unlisten?.();
      listened = reading;
      unlisten = reading ? reading.subscribe(() => release()) : null;
    }
    return reading;
  }
  const letGo = (count: number) => {
    if (count <= 0) return;
    for (const line of held.splice(0, count)) queue.push(line.pages);
    pump();
    showTyping();
  };
  /** Sends up every kept line whose reading has begun, and the ones before it. */
  function release(): void {
    if (stopped) return;
    const reading = readingNow();
    // Nothing is read to them any more: nothing is waited for.
    if (!reading) { letGo(held.length); return; }
    // What it reads is noted whether or not a line waits for it yet: a reading may begin before its line is finished
    // on screen, and be over by then.
    const now = reading.scheduled();
    const present = new Set<number>();
    for (const clip of now) {
      if (clip.ref === undefined) continue;
      present.add(clip.ref);
      queued.add(clip.ref);
      if (clip.inMs <= 0) begun.add(clip.ref);
    }
    // One that was in the queue and is no longer has been played to its end.
    for (const ref of queued) if (!present.has(ref)) { begun.add(ref); queued.delete(ref); }
    let upTo = 0;
    held.forEach((line, i) => { if (line.refs.some((ref) => begun.has(ref))) upTo = i + 1; });
    letGo(upTo);
    // The next of them to begin: looked at again at that moment, which the queue does not tell.
    const next = now.filter((clip) => clip.ref !== undefined && clip.inMs > 0 && held.some((line) => line.refs.includes(clip.ref!))).map((clip) => clip.inMs);
    if (next.length === 0) return;
    const mine = ++startTimer;
    later(() => { if (mine === startTimer) release(); }, Math.ceil(Math.min(...next)) + 5);
  }
  /** A kept line whose reading has not come: it goes up once nothing is being read, with the ones before it. */
  const giveUp = (line: { pages: string[] }) => {
    const at = held.findIndex((one) => one.pages === line.pages);
    if (stopped || at < 0) return;
    const reading = readingNow();
    if (reading && reading.scheduled().length > 0) { later(() => giveUp(line), READING_WAIT_MS); return; }
    letGo(at + 1);
  };
  const forget = () => { queue.length = 0; rest = []; held.length = 0; queued.clear(); begun.clear(); };
  const look = () => {
    const shows = store.getState().chatbox;
    const state = deps.view.get();
    const coached = deps.coached();
    const theirs = deps.theirs?.();
    // The segments typed text opened: everything else of the user's leg was spoken.
    const typed = new Set((state.legs ?? []).flatMap((leg) => leg.segments.filter((s) => TYPED.test(s.origin ?? '')).map((s) => s.id)));
    /** The segment a row is of, as its reading names it. */
    const refOf = new Map((state.legs ?? []).flatMap((leg) => leg.segments.flatMap((s): Array<[string, number]> => (s.ref === undefined ? [] : [[s.id, s.ref]]))));
    // Feedback is private; a coached speaker's own-language sentence is a translation instead.
    // An undecided partial must not reach the chatbox before the final language arrives.
    const feedback = (entry: Extract<Entry, { kind: 'exchange' }>) => coached
      && !theirs?.back
      && !entry.translation.some((row) => row.purpose === 'translation')
      && !entry.source.some((row) => typed.has(row.segmentId))
      && !(theirs && entry.source.length > 0 && entry.source.every((row) => row.language && !theirs.languages.some((code) => base(code) === base(row.language!))));
    // Said in the other side's language with no translation back asked for: it goes up as said (`finishedLine`), though
    // a coached speaker's is translated back for them alone.
    const asSaid = (entry: Extract<Entry, { kind: 'exchange' }>) => theirs !== undefined && !theirs.back && entry.source.length > 0
      && entry.source.every((row) => row.language !== undefined && theirs.languages.some((code) => base(code) === base(row.language!)));
    // The newest of the user's sentences that is translated: every one before it has all the translations it will get.
    let newest = -1;
    state.entries.forEach((entry, i) => { if (entry.kind === 'exchange' && entry.leg === 'speaker' && answersOf(entry.translation).length > 0) newest = i; });
    // The last sentence of the user's translated as it would go up, for the settings to show the chatbox with: not
    // one answered with feedback, which is theirs alone.
    for (let i = state.entries.length - 1; i >= 0; i--) {
      const entry = state.entries[i];
      if (entry.kind !== 'exchange' || entry.leg !== 'speaker') continue;
      if (feedback(entry) || asSaid(entry)) continue;
      const translation = finishedLine(entry, 'translation', false, store.getState().chatboxTranslationFirst, theirs, i < newest);
      if (translation === null) continue;
      store.getState().setRecent({ said: textOf(entry.source), translation });
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
    state.entries.forEach((entry, i) => {
      if (entry.kind !== 'exchange' || sent.has(entry.id)) return;
      const said = feedback(entry);
      const line = finishedLine(entry, shows, said, store.getState().chatboxTranslationFirst, theirs, i < newest);
      if (line === null) return;
      sent.add(entry.id);
      const pages = chatboxPages(line);
      // Fork: read aloud to them, it goes up with its reading. Not what is sent as said (it is not read), nor a line
      // with no translation into a language of theirs (one back into the user's own is not read either).
      const refs = said || asSaid(entry) || readingNow() === null ? [] : entry.translation
        .filter((row) => row.purpose !== 'feedback' && (!theirs || theirs.languages.some((code) => base(code) === base(row.language || entry.languages.target))))
        .flatMap((row) => { const ref = refOf.get(row.segmentId); return ref === undefined ? [] : [ref]; });
      if (refs.length === 0) { queue.push(pages); return; }
      const kept = { pages, refs };
      held.push(kept);
      later(() => giveUp(kept), READING_WAIT_MS);
    });
    release();
    pump();
    showTyping();
  };
  // What is finished on screen when this begins was said before: it is not sent now. A sentence still under way is.
  for (const entry of deps.view.get().entries) if (finishedLine(entry, 'translation', false, false, deps.theirs?.()) !== null) sent.add(entry.id);
  offs.push(deps.view.subscribe(look));
  if (deps.onReset) offs.push(deps.onReset(forget));

  // ── Following the run, the settings and the views ─────────────────────────
  let wasRunning = running();
  offs.push(runner.state.subscribe(() => {
    const now = running();
    // The run is over: a video it heard is forgotten, the pace is the usual for the next.
    if (wasRunning && !now) { endVideo(); forget(); showTyping(); }
    // A run begins: the reading is asked for now, so that it is there when the first sentence is finished.
    if (!wasRunning && now) readingNow();
    wasRunning = now;
    watch();
  }));
  offs.push(store.subscribe(() => {
    if (store.getState().chatbox === 'off') forget();
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
      forget();
      unlisten?.();
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

/**
 * Fork: the reading of the user's translations, where the selected provider's run reads them aloud to the other
 * side: Kotomimi's own voice stage on and set to speak along, in a voice that speaks one of their languages, and the
 * other side set to hear it. The playback's queue of the user's leg is what it reads from; it is there once the run
 * has made its first sound, and until then nothing is kept back for it.
 */
export function appReading(theirs: () => Theirs | undefined): () => Reading | null {
  let reading: Reading | null = null;
  let asked = false;
  return () => {
    const { selected, entries, models } = useProviderStore.getState();
    const speak = selected === 'localai' ? (entries[selected]?.settings as { speak?: VoiceChoice } | undefined)?.speak : undefined;
    if (!speak || !speaksAlong(speak) || !useRoutingStore.getState().meeting) return null;
    const lent = (models.localai ?? []) as readonly LocalAIModel[];
    if (!(theirs()?.languages ?? []).some((language) => voiceSpeaks(speak, language, lent))) return null;
    if (!asked) {
      asked = true;
      void import('../lib/audio/appAudio').then(({ getAppAudio }) => getAppAudio()).then((audio) => {
        const queue = audio.playback.queues.speaker;
        reading = {
          scheduled: () => queue.scheduled().map(({ key, inMs }) => ({ ref: parseClipKey(key).ref, inMs })),
          subscribe: (listener) => queue.subscribe(listener),
        };
      }, () => { asked = false; });
    }
    return reading;
  };
}

async function build(): Promise<VRChatController> {
  const { getAppSession } = await import('./session');
  const session = getAppSession();
  const theirs = (): Theirs | undefined => {
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
  };
  const controller = startVRChat({
    ipc: (window as unknown as { electron: VRChatIpc }).electron,
    runner: session.runner,
    view: { get: () => session.view.get(), subscribe: (listener) => session.view.subscribe(listener) },
    legs: () => { const mode = useAudioStore.getState().mode; return mode === 'both' ? ['speaker', 'participant'] : [mode]; },
    canAsk: () => !(useSettingsStore.getState().subtitleModeActive && useSubtitleLookStore.getState().through),
    coached: () => useCoachingStore.getState().coached,
    theirs,
    reading: appReading(theirs),
    onReset: (listener) => session.runner.conversation.onReset(() => listener()),
    store: useVRChatStore,
    split: participantSplit,
    laneOffered: () => useProviderStore.getState().selected === 'localai',
  });
  setVRChatController(controller);
  return controller;
}
