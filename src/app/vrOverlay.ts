// src/app/vrOverlay.ts
/**
 * Fork: the SteamVR overlay as the page drives it (`electron/vr-overlay.js`
 * is the main process's side, `src/vr/` its two pages — the strip it draws in
 * the headset and the wrist panel's window — `vrStore` the settings).
 *
 * - **What they show** (`VrState`): the last few lines, whether each side is
 *   heard, the pair, this computer's models with how each ran, all in the
 *   user's words. Built while SteamVR shows the strip or the panel's window is
 *   open, sent only when it changes.
 * - **What the panel asks.** A language or a model is a setting the run fixes:
 *   a running run stops, takes the change, and starts again, and the strip
 *   says what it changes to meanwhile.
 * - **How a model ran**, measured in this session: for a recognizer, from the
 *   end of the other side's sound to their sentence's last word; for a
 *   translator, from a sentence's last word to its translation's.
 */
import type { Entry } from '../lib/projection/types';
import type { LegName } from '../lib/conversation/types';
import type { LevelMeter } from '../lib/audio/levelMeter';
import type { Readable } from '../lib/view/conversationView';
import type { RunState } from '../lib/session/types';
import type { LanguagePair } from '../lib/provider/types';
import { languageLabel } from '../lib/language/label';
import { addTheirs, pressTheirs, type TheirLanguages, type TheirNext } from '../lib/language/theirLanguages';
import { toViewerEntry } from '../lib/share/viewerEntry';
import { describeCause, reportError } from '../lib/diagnostics/report';
import type { VrCaptions, VrChoice, VrCommand, VrLine, VrModel, VrState, VrWords } from '../vr/types';
import { useVrStore, type VrLink } from '../stores/vrStore';
import type { ChatboxShows } from '../stores/vrchatStore';

export interface VrIpc {
  invoke(channel: string, data?: unknown): Promise<unknown>;
  receive?(channel: string, fn: (...args: unknown[]) => void): void;
}

/** What the pair and the models are, and how to change them: the selected provider's, through the provider store. */
export interface VrSettingsPort {
  pair(): LanguagePair | null;
  setPair(pair: LanguagePair): void;
  /** The other side's languages the provider offers. */
  theirOptions(): readonly string[];
  /** The user's own languages the provider offers. */
  myOptions(): readonly string[];
  pins(): readonly string[];
  /**
   * Fork: the other side's languages switched by hand ("对方说", `theirLanguages.ts`), where the provider switches them;
   * and a change to them, their main one and their row and light together. Absent: the pair's target alone.
   */
  theirs?(): TheirLanguages | null;
  applyTheirs?(next: TheirNext): void;
  /** This computer's recognizers that hear the other side's language and are downloaded, and the one that does; null where the run does not hear on this computer. */
  hearers(): { value: string; options: readonly { id: string; label: string }[] } | null;
  setHearer(id: string): void;
  translators(): { value: string; options: readonly { id: string; label: string }[] } | null;
  setTranslator(id: string): void;
  /** Settings written before a start reads them. */
  flush(): Promise<unknown>;
  /** Anything above changed. */
  subscribe(listener: () => void): () => void;
}

export interface VrOverlayDeps {
  ipc: VrIpc;
  runner: {
    state: { getState(): RunState; subscribe(listener: () => void): () => void };
    stop(): Promise<void>;
    /** Fork: the run goes on in the languages and settings as they stand now, restarted only where it cannot (`Runner.retarget`). */
    retarget?(): Promise<void>;
  };
  /** The one start every surface calls (`AppSession.start`). */
  start(): Promise<void>;
  view: Readable<{ entries: readonly Entry[] }>;
  levels(): Promise<Readonly<Record<LegName, LevelMeter>> | null>;
  legs(): readonly LegName[];
  settings: VrSettingsPort;
  /** VRChat has the user muted, and the run follows it. */
  muted(): boolean;
  subscribeMuted(listener: () => void): () => void;
  /** VRChat's chatbox setting; it changes beside `muted` (one store). */
  chatbox(): ChatboxShows;
  /** Off, or back to the last look that showed something (`useVRChatStore.turnChatbox`). */
  turnChatbox(on: boolean): void;
  words(): VrWords;
  uiLanguage(): string;
  /** What the strip reads beside the conversation, as the computer's subtitle reads it (`VrCaptions`), and its changes. */
  captionLook(): Pick<VrCaptions, 'filters' | 'coached' | 'aids'>;
  subscribeCaptionLook(listener: () => void): () => void;
  store?: typeof useVrStore;
  now?(): number;
  setInterval?(fn: () => void, ms: number): unknown;
  clearInterval?(handle: unknown): void;
}

export interface VrOverlayController {
  stop(): void;
}

/** How many lines the headset gets; the strip reads the last, the wrist three. */
const LINES = 6;
const HEARD_LOOK_MS = 250;
/** A sentence ending later than this after the sound stopped is not counted against the recognizer: a pause, not a lag. */
const LAG_MOST_MS = 10_000;
/** The last few runs of a model, averaged. */
const LAG_SAMPLES = 5;

const textOf = (rows: readonly { text: string }[]) => rows.map((r) => r.text).join(' ').trim();

/** The last lines of the conversation, as the headset draws them. */
export function vrLines(entries: readonly Entry[]): VrLine[] {
  const out: VrLine[] = [];
  for (let i = entries.length - 1; i >= 0 && out.length < LINES; i--) {
    const viewer = toViewerEntry(entries[i]);
    if (!viewer) continue;
    const source = textOf(viewer.source);
    const translation = textOf(viewer.translation);
    if (!source && !translation) continue;
    const final = viewer.source.every((r) => r.final) && viewer.translation.every((r) => r.final);
    out.push({ id: viewer.id, leg: viewer.leg, source, translation, final });
  }
  return out.reverse();
}

/** The chips under "they speak": the pinned languages the provider offers, else a few common ones — the current one always among them. */
export function quickLanguages(current: string, offered: readonly string[], pins: readonly string[], most = 3): string[] {
  const has = new Set(offered);
  const pinned = pins.filter((code) => has.has(code));
  const base = pinned.length >= 2 ? pinned : [...pinned, ...['ja', 'en', 'ko', 'zh', 'yue'].filter((c) => has.has(c) && !pinned.includes(c))];
  const list = base.slice(0, most);
  if (current && !list.includes(current)) list[Math.min(list.length, most - 1)] = current;
  return [...new Set(list)];
}

/** How many of the conversation's entries the strip is sent: enough for each side's newest and the ones still held. */
const CAPTION_ENTRIES = 24;

/** The strip's entries: the latest, a video's words left out (the subtitle draws those apart, and the strip not). */
export function captionEntries(entries: readonly Entry[]): Entry[] {
  const people = entries.filter((e) => !(e.kind === 'exchange' && e.lane === 'video'));
  return people.slice(-CAPTION_ENTRIES);
}

/** A model's last few runs: their average. */
class Lags {
  private samples = new Map<string, number[]>();
  add(model: string, ms: number) {
    const list = this.samples.get(model) ?? [];
    list.push(ms);
    if (list.length > LAG_SAMPLES) list.shift();
    this.samples.set(model, list);
  }
  of(model: string): number | undefined {
    const list = this.samples.get(model);
    return list && list.length ? list.reduce((a, b) => a + b, 0) / list.length : undefined;
  }
}

export function startVrOverlay(deps: VrOverlayDeps): VrOverlayController {
  const store = deps.store ?? useVrStore;
  const { ipc, runner, settings } = deps;
  const now = deps.now ?? (() => Date.now());
  const every = deps.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clear = deps.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
  const offs: Array<() => void> = [];
  let stopped = false;

  let strip = true;
  let switching: VrState['switching'] = null;
  let heard: VrState['heard'] = null;
  const hearLags = new Lags();
  const translateLags = new Lags();

  // ── The headset's state, sent when it changes ──────────────────────────────
  let last = '';
  let queued = false;
  const label = (code: string) => languageLabel(code, deps.uiLanguage());
  const choices = (codes: readonly string[]): VrChoice[] => codes.map((value) => ({ value, label: label(value) }));
  const models = (list: ReturnType<VrSettingsPort['hearers']>, lags: Lags): VrState['hear'] => (list
    ? { value: list.value, options: list.options.map((m): VrModel => ({ id: m.id, label: m.label, ...(lags.of(m.id) !== undefined ? { ms: Math.round(lags.of(m.id)!) } : {}) })) }
    : { value: '', options: [] });

  const build = (): VrState => {
    const run = runner.state.getState();
    const pair = settings.pair() ?? { source: '', target: '' };
    const theirs = settings.theirOptions();
    const mine = settings.myOptions();
    const myQuick = quickLanguages(pair.source, mine, settings.pins(), 4);
    const switched = settings.theirs?.() ?? null;
    return {
      words: deps.words(),
      phase: run.phase,
      switching,
      failed: run.phase === 'idle' && run.lastEnd && run.lastEnd.reason !== 'user' ? run.lastEnd.reason : null,
      heard,
      muted: deps.muted(),
      lines: vrLines(deps.view.get().entries),
      // Fork: their row where it is switched by hand ("对方说"), the main one and the one lit beside it; else the quick ones.
      theirs: switched
        ? { value: pair.target, ...(switched.lit && switched.lit !== 'auto' ? { lit: switched.lit } : {}), options: choices(theirs), quick: switched.row.filter((code) => code !== 'auto'), row: true }
        : { value: pair.target, options: choices(theirs), quick: quickLanguages(pair.target, theirs, settings.pins()) },
      mine: { value: pair.source, options: choices(myQuick) },
      hear: models(settings.hearers(), hearLags),
      translate: models(settings.translators(), translateLags),
      strip,
      chatbox: deps.chatbox() !== 'off',
      captions: {
        entries: captionEntries(deps.view.get().entries),
        legs: [...deps.legs()],
        pair: settings.pair(),
        language: deps.uiLanguage(),
        ...deps.captionLook(),
      },
    };
  };

  /** Someone looks: SteamVR shows the strip, or the panel's window is open. */
  const shown = () => store.getState().link === 'connected' || store.getState().panel;
  const publish = () => {
    if (stopped || !shown()) return;
    if (queued) return;
    queued = true;
    // Many changes in one turn (a sentence's rows, a run's phase) make one picture.
    queueMicrotask(() => {
      queued = false;
      if (stopped || !shown()) return;
      const state = build();
      const text = JSON.stringify(state);
      if (text === last) return;
      last = text;
      void ipc.invoke('vr:state', state).catch(() => {});
    });
  };

  // ── Whether each side is heard, while a run is on and SteamVR shows it ─────
  let levels: Readonly<Record<LegName, LevelMeter>> | null = null;
  let look: unknown = null;
  /** When the other side's sound last stopped: what a recognizer's lag is counted from. */
  let soundEnded: number | null = null;
  const watchHeard = () => {
    const want = !stopped && shown() && runner.state.getState().phase === 'running';
    if (want && look === null) {
      void deps.levels().then((l) => { levels = l; });
      look = every(() => {
        if (!levels) return;
        const next: NonNullable<VrState['heard']> = {};
        for (const leg of deps.legs()) next[leg] = levels[leg].heard();
        if (heard?.participant && !next.participant) soundEnded = now();
        if (next.participant) soundEnded = null;
        if (JSON.stringify(next) !== JSON.stringify(heard)) {
          heard = next;
          publish();
        }
      }, HEARD_LOOK_MS);
    } else if (!want && look !== null) {
      clear(look);
      look = null;
      heard = null;
      soundEnded = null;
      publish();
    }
  };

  // ── How each model ran ──────────────────────────────────────────────────
  /** Per entry: when its words were final, and whether its translation was counted. */
  const timed = new Map<string, { said?: number; translated?: boolean }>();
  const measure = () => {
    const hearer = settings.hearers()?.value;
    const translator = settings.translators()?.value;
    for (const entry of deps.view.get().entries) {
      if (entry.kind !== 'exchange' || entry.lane === 'video') continue;
      let t = timed.get(entry.id);
      const said = entry.source.length > 0 && entry.source.every((r) => r.final);
      if (said && !t) {
        t = { said: now() };
        timed.set(entry.id, t);
        if (entry.leg === 'participant' && hearer && soundEnded !== null && now() - soundEnded < LAG_MOST_MS) hearLags.add(hearer, now() - soundEnded);
      }
      if (t && !t.translated && t.said !== undefined && entry.translation.length > 0 && entry.translation.every((r) => r.final)) {
        t.translated = true;
        if (translator) translateLags.add(translator, now() - t.said);
      }
    }
    if (timed.size > 200) for (const key of [...timed.keys()].slice(0, 100)) timed.delete(key);
  };

  // ── What the wrist asks ───────────────────────────────────────────────────
  /** Bumped by the user's own start or stop: a restart under way then does not start the run again. */
  let asked = 0;
  /**
   * Takes a change the run fixes: at once while idle; else the run goes on in it (`retarget`), stopping and starting
   * again only where it cannot.
   */
  const restartWith = async (kind: NonNullable<VrState['switching']>['kind'], name: string, change: () => void) => {
    if (switching) return;
    const mine = asked;
    const phase = runner.state.getState().phase;
    if (phase === 'idle') {
      change();
      publish();
      return;
    }
    switching = { kind, label: name };
    publish();
    try {
      if (runner.retarget) {
        change();
        await settings.flush();
        if (!stopped && mine === asked) await runner.retarget();
        return;
      }
      await runner.stop();
      change();
      await settings.flush();
      if (!stopped && mine === asked) await deps.start();
    } catch (error) {
      reportError('VrOverlay', `Restarting for a change from the headset failed: ${describeCause(error)}`, { cause: error });
    } finally {
      switching = null;
      publish();
    }
  };

  const onCommand = (raw: unknown) => {
    if (stopped || !raw || typeof raw !== 'object') return;
    const command = raw as VrCommand;
    const pair = settings.pair();
    switch (command.type) {
      case 'theirs': {
        // Fork: their row pressed as the settings' is (`theirLanguages.ts`): one in it lit or put out, another added lit.
        const switched = settings.theirs?.();
        if (switched && settings.applyTheirs && typeof command.value === 'string') {
          const value = command.value;
          const inRow = switched.row.some((code) => code.toLowerCase().split(/[-_]/)[0] === value.toLowerCase().split(/[-_]/)[0]);
          const next = inRow ? pressTheirs(switched, value) : addTheirs(switched, value);
          if (next) void restartWith('theirs', label(value), () => settings.applyTheirs!(next));
          break;
        }
        if (pair && typeof command.value === 'string' && command.value !== pair.target) {
          const target = command.value;
          void restartWith('theirs', label(target), () => settings.setPair(target === pair.source ? { source: pair.target, target } : { source: pair.source, target }));
        }
        break;
      }
      case 'mine':
        if (pair && typeof command.value === 'string' && command.value !== pair.source) {
          const source = command.value;
          void restartWith('mine', label(source), () => settings.setPair(source === pair.target ? { source, target: pair.source } : { source, target: pair.target }));
        }
        break;
      case 'run':
        asked += 1;
        if (command.on) void deps.start();
        else void runner.stop();
        break;
      case 'strip':
        strip = command.on === true;
        publish();
        break;
      case 'chatbox':
        deps.turnChatbox(command.on === true);
        break;
      case 'hear': {
        const model = settings.hearers()?.options.find((m) => m.id === command.id);
        if (model) void restartWith('hear', model.label, () => settings.setHearer(model.id));
        break;
      }
      case 'translate': {
        const model = settings.translators()?.options.find((m) => m.id === command.id);
        if (model) void restartWith('translate', model.label, () => settings.setTranslator(model.id));
        break;
      }
    }
  };

  // ── Wiring ─────────────────────────────────────────────────────────────────
  ipc.receive?.('vr:status', (s) => {
    const link = (s as { vr?: string } | null)?.vr;
    store.getState().setLink((['off', 'waiting', 'connected', 'missing'] as const).includes(link as VrLink) ? (link as VrLink) : 'off');
  });
  // The panel's window closed by itself: shown closed until the switch opens it again, or the next start.
  ipc.receive?.('vr:panel', (s) => { if ((s as { on?: boolean } | null)?.on === false && store.getState().panel) store.getState().panelClosed(); });
  ipc.receive?.('vr:command', onCommand);

  const sendOn = (on: boolean) => {
    void ipc.invoke('vr:set', { on }).then((s) => {
      const link = (s as { vr?: string } | null)?.vr;
      if (!stopped && link) store.getState().setLink(link as VrLink);
    }, () => {});
  };
  const sendPanel = (on: boolean) => { void ipc.invoke('vr:panel', { on }).catch(() => {}); };
  sendOn(store.getState().on);
  if (store.getState().panel) sendPanel(true);
  offs.push(store.subscribe((s) => s.on, sendOn));
  offs.push(store.subscribe((s) => s.panel, (on) => { sendPanel(on); last = ''; watchHeard(); publish(); }));
  offs.push(store.subscribe((s) => s.link, () => { last = ''; watchHeard(); publish(); }));
  offs.push(runner.state.subscribe(() => { watchHeard(); publish(); }));
  offs.push(deps.view.subscribe(() => { measure(); publish(); }));
  offs.push(settings.subscribe(publish));
  offs.push(deps.subscribeMuted(publish));
  offs.push(deps.subscribeCaptionLook(publish));

  return {
    stop() {
      stopped = true;
      for (const off of offs.splice(0)) off();
      if (look !== null) clear(look);
      look = null;
    },
  };
}

let building: Promise<VrOverlayController | null> | null = null;

/** The page's one controller (desktop on Windows): over the app session and window.electron. Null elsewhere. */
export function getVrOverlayController(): Promise<VrOverlayController | null> {
  building ??= build();
  return building;
}

async function build(): Promise<VrOverlayController | null> {
  const { isElectron } = await import('../utils/environment');
  const ipc = (window as unknown as { electron?: VrIpc }).electron;
  if (!isElectron() || !ipc || !/Windows/.test(navigator.userAgent)) return null;
  const [{ getAppSession }, { vrSettingsPort, vrWords }, { default: useAudioStore }, { useVRChatStore, vrchatHolds }, { default: i18n }, { useSubtitleStore }, { useAnnotationStore }, { useCoachingStore }] = await Promise.all([
    import('./session'),
    import('./vrOverlayPorts'),
    import('../stores/audioStore'),
    import('../stores/vrchatStore'),
    import('../locales'),
    import('../stores/subtitleStore'),
    import('../stores/annotationStore'),
    import('../stores/coachingStore'),
  ]);
  const session = getAppSession();
  return startVrOverlay({
    ipc,
    runner: { state: session.runner.state, stop: () => session.runner.stop('vr'), retarget: () => session.runner.retarget() },
    start: () => session.start('vr'),
    view: { get: () => session.view.get(), subscribe: (listener) => session.view.subscribe(listener) },
    levels: () => session.audio().then((a) => a.capture.levels, () => null),
    legs: () => { const mode = useAudioStore.getState().mode; return mode === 'both' ? ['speaker', 'participant'] : [mode]; },
    settings: vrSettingsPort(),
    muted: () => vrchatHolds(useVRChatStore.getState()),
    subscribeMuted: (listener) => useVRChatStore.subscribe(listener),
    chatbox: () => useVRChatStore.getState().chatbox,
    turnChatbox: (on) => useVRChatStore.getState().turnChatbox(on),
    words: () => vrWords((key, fallback) => i18n.t(key, fallback) as string),
    uiLanguage: () => i18n.language ?? 'en',
    captionLook: () => {
      const subtitle = useSubtitleStore.getState();
      const aids = useAnnotationStore.getState();
      return {
        filters: { speaker: subtitle.speakerDisplayMode, participant: subtitle.participantDisplayMode },
        coached: useCoachingStore.getState().coached,
        aids: { furigana: aids.furigana, romanization: aids.romanization, romanizationOff: [...aids.romanizationOff], pinyin: aids.pinyin, jyutping: aids.jyutping, sourceItalic: aids.sourceItalic },
      };
    },
    subscribeCaptionLook: (listener) => {
      const offs = [useSubtitleStore.subscribe(listener), useAnnotationStore.subscribe(listener), useCoachingStore.subscribe(listener)];
      return () => { for (const off of offs) off(); };
    },
  });
}
