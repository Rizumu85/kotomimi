/**
 * Everything the app plays, behind the runner's `PlaybackPort` (spec:
 * "Playback"): a clip queue per leg and one for replay, the preview route,
 * the route table kept live from the routing settings, and the tts tap.
 */
import { realClock, type Clock } from '../contract/clock';
import { describeCause, reportWarning } from '../diagnostics/report';
import type { LegName, Segment } from '../conversation/types';
import type { PlaybackPort } from '../session/ports';
import type { Source } from '../session/source';
import { ClipQueue, type QueueView } from './clipQueue';
import type { AudioGraph, BusMeter, OneShot } from './graph';
import type { PcmTap } from './pcmTap';
import { routesFor, type RoutingSettings, type Bus } from './routes';

/** How long playback must be quiet — no run live, nothing queued, no preview — before its context rests. */
export const QUIET_MS = 5_000;

/** One clip: a leg, the segment its `ref` names ('none' when it names none), and which of the segment's speech entries. */
export type ClipKey = `${LegName}:${number | 'none'}:${number}`;

export function clipKey(leg: LegName, ref: number | undefined, index: number): ClipKey {
  return `${leg}:${ref ?? 'none'}:${index}`;
}

/** A clip key's parts; `ref` is undefined for audio that names no segment. Surfaces read keys through this, never by splitting them. */
export function parseClipKey(key: ClipKey): { leg: LegName; ref: number | undefined; index: number } {
  const [leg, ref, index] = key.split(':') as [LegName, string, string];
  return { leg, ref: ref === 'none' ? undefined : Number(ref), index: Number(index) };
}

/** The routing settings, live: the app reads its stores, the preview its toggles, a test a fixture. */
export interface RoutingSource {
  get(): RoutingSettings;
  subscribe(listener: () => void): () => void;
}

/** A voice sample or the test tone, at its own rate. */
export interface PreviewClip {
  audio: Float32Array;
  sampleRate: number;
}

export interface Playback extends PlaybackPort {
  readonly queues: Readonly<Record<'speaker' | 'participant' | 'replay', QueueView<ClipKey>>>;
  /** Plays a segment's kept speech on the real device, replacing any replay in progress. */
  replay(leg: LegName, segment: Segment): void;
  stopReplay(): void;
  /**
   * Fork: a line said on demand, piece by piece as its voice is made (`src/app/lineVoice.ts`): on the replay route,
   * so on the real device alone and never into the meeting. The pieces of one line play back to back; whoever
   * starts a line stops what was replaying first (`stopReplay`).
   */
  line(pcm: Int16Array): void;
  /** Plays a clip on the real device, stopping the previous one; resolves when it ends or is stopped. */
  preview(clip: PreviewClip): Promise<void>;
  stopPreview(): void;
  /** The microphone as spoken, before the recorder's chunk processing. */
  passthrough(stream: MediaStream | null): void;
  /** Listen to a capture source only while the run's passthrough route is open. */
  passthrough(listen: NonNullable<Source['onStream']>): () => void;
  /**
   * Fork: the microphone outside a run, so that a game or a meeting that takes the virtual device as its microphone
   * hears the user whether a session runs or not. Listened to only while the passthrough route is open, there is a
   * virtual device, and no run carries a microphone of its own.
   */
  standing(listen: NonNullable<Source['onStream']>): () => void;
  /** The translated speech as played, before any route: the echo monitor's reference. */
  readonly ttsTap: PcmTap;
  /** Fork: what the user's device plays of the app's own, chunk by chunk (`AudioGraph.onPlayed`). */
  onPlayed(listener: (chunk: Float32Array) => void): () => void;
  /** What a bus carries. Direct desktop microphone output bypasses the virtual bus. */
  meter(bus: Bus): BusMeter | null;
  dispose(): Promise<void>;
}

export function createPlayback(graph: AudioGraph, routing: RoutingSource, clock: Pick<Clock, 'setTimeout'> = realClock): Playback {
  const queues: Record<LegName, ClipQueue<ClipKey>> = {
    speaker: new ClipQueue<ClipKey>(graph.timeline('speaker')),
    participant: new ClipQueue<ClipKey>(graph.timeline('participant')),
  };
  const replayQueue = new ClipQueue<ClipKey>(graph.timeline('replay'));
  /**
   * Per `${leg}:${ref}`, how many clips have arrived: the next one's speech
   * entry index, since L1 appends one entry per `audio` event, in order.
   */
  const counts = new Map<string, number>();
  /** The pieces of lines said on demand so far: each is a clip of its own on the replay queue. */
  let linePieces = 0;
  let held = false;
  let current: OneShot | null = null;
  let live = false;
  let rest: (() => void) | null = null;
  let disposing: Promise<void> | null = null;

  let disconnectMic: (() => void) | undefined;
  // A microphone carried outside a run (`standing`) is sound too: where it goes through this graph, a rest would cut it.
  const quiet = () => !live && current === null && disconnectMic === undefined
    && queues.speaker.pending === 0 && queues.participant.pending === 0 && replayQueue.pending === 0;

  /** Rests the graph once it has stayed quiet for QUIET_MS; anything that plays resumes it. */
  const restLater = () => {
    rest?.();
    rest = clock.setTimeout(() => {
      rest = null;
      if (quiet()) void graph.suspend();
    }, QUIET_MS);
  };

  let passthroughOpen = false;
  let microphone: MediaStream | null = null;
  let followMic: ((active: boolean) => void) | undefined;
  /** Fork: the microphone outside a run (`standing`), and whether there is a virtual device for it to go to. */
  let standingMic: MediaStream | null = null;
  let followStanding: ((active: boolean) => void) | undefined;
  let virtualThere = false;
  const syncMic = () => {
    const carried = disconnectMic !== undefined;
    disconnectMic?.();
    disconnectMic = undefined;
    // A run carries its own microphone; until it has one, and outside it, the standing one goes on.
    const stream = live && microphone ? microphone : standingMic;
    if (stream && passthroughOpen) {
      try {
        disconnectMic = graph.connectMicrophone(stream);
        void graph.resume();
      } catch (error) {
        reportWarning('Playback', `Could not connect microphone passthrough: ${describeCause(error)}`, { cause: error, dedupeKey: 'playback:mic' });
      }
    }
    if (carried && !disconnectMic && quiet()) restLater();
  };
  const syncStanding = () => followStanding?.(passthroughOpen && virtualThere && !(live && microphone));

  function passthrough(stream: MediaStream | null): void;
  function passthrough(listen: NonNullable<Source['onStream']>): () => void;
  function passthrough(input: MediaStream | null | NonNullable<Source['onStream']>) {
    if (typeof input === 'function') {
      followMic?.(false);
      let off: (() => void) | undefined;
      const follow = (active: boolean) => {
        if (active) {
          off ??= input(passthrough);
        } else {
          off?.();
          off = undefined;
        }
      };
      followMic = follow;
      follow(live && passthroughOpen);
      return () => {
        if (followMic === follow) followMic = undefined;
        follow(false);
      };
    }
    if (microphone === input) return;
    microphone = input;
    syncMic();
    syncStanding();
  }

  function standing(listen: NonNullable<Source['onStream']>): () => void {
    followStanding?.(false);
    let off: (() => void) | undefined;
    const receive = (stream: MediaStream | null) => {
      if (standingMic === stream) return;
      standingMic = stream;
      syncMic();
    };
    const follow = (active: boolean) => {
      if (active) {
        off ??= listen(receive);
      } else {
        off?.();
        off = undefined;
        receive(null);
      }
    };
    followStanding = follow;
    syncStanding();
    return () => {
      if (followStanding === follow) followStanding = undefined;
      follow(false);
    };
  }

  const apply = () => {
    const settings = routing.get();
    const edges = routesFor(settings, held);
    const open = edges.some((e) => e.from === 'passthrough');
    void graph.setSinks(settings.sinks);
    graph.route(edges);
    virtualThere = settings.sinks.virtual !== undefined;
    if (passthroughOpen !== open) {
      passthroughOpen = open;
      syncMic();
      followMic?.(live && open);
    }
    syncStanding();
  };
  apply();
  const unsubscribeRouting = routing.subscribe(apply);
  // Any clip starting or ending, on any queue, may turn playback quiet (or
  // end a quiet stretch): re-arm the rest timer whenever it does.
  const unsubscribeQueues = [queues.speaker, queues.participant, replayQueue].map((q) =>
    q.subscribe(() => { if (quiet()) restLater(); }));
  restLater();

  const stopPreview = () => {
    current?.stop();
    current = null;
  };

  // The clips were scheduled on a context that is gone. The indices (`counts`)
  // stay: L1's speech entries go on, so the next clip keeps its place.
  const unsubscribeReset = graph.onReset(() => {
    queues.speaker.clear();
    queues.participant.clear();
    replayQueue.clear();
    syncMic();
    stopPreview();
  });

  return {
    queues: { speaker: queues.speaker, participant: queues.participant, replay: replayQueue },

    audio(leg, ref, pcm) {
      const id = `${leg}:${ref ?? 'none'}`;
      const index = counts.get(id) ?? 0;
      counts.set(id, index + 1);
      void graph.resume();
      queues[leg].enqueue(clipKey(leg, ref, index), pcm);
    },

    held(next) {
      if (next === held) return;
      held = next;
      apply();
    },

    live(on) {
      if (live === on) return;
      live = on;
      syncMic();
      followMic?.(live && passthroughOpen);
      syncStanding();
      if (!on) restLater();
    },

    clear() {
      queues.speaker.clear();
      queues.participant.clear();
      replayQueue.clear();
      // L1's `clear()` empties every segment's speech too: the indices restart together.
      counts.clear();
    },

    replay(leg, segment) {
      replayQueue.clear();
      void graph.resume();
      segment.speech.forEach((entry, index) => {
        // An entry whose pcm retention dropped plays nothing, but keeps its index.
        if (entry.pcm.length > 0) replayQueue.enqueue(clipKey(leg, segment.ref, index), entry.pcm);
      });
    },

    stopReplay: () => replayQueue.clear(),

    line(pcm) {
      void graph.resume();
      // It names no segment: the karaoke of the conversation's rows never takes it for one of theirs.
      replayQueue.enqueue(clipKey('speaker', undefined, linePieces), pcm);
      linePieces += 1;
    },

    preview(clip) {
      stopPreview();
      if (clip.audio.length === 0) return Promise.resolve();
      void graph.resume();
      let shot: OneShot;
      try {
        shot = graph.playOnce(clip.audio, clip.sampleRate);
      } catch (error) {
        // createBuffer rejects a rate outside its supported range: a caller
        // awaiting this promise must see a rejection, not a synchronous throw.
        return Promise.reject(error);
      }
      current = shot;
      return shot.ended.then(() => {
        if (current === shot) current = null;
        restLater();
      });
    },

    stopPreview,

    passthrough,

    standing,

    ttsTap: graph.ttsTap,

    onPlayed: (listener) => graph.onPlayed(listener),

    meter: (bus) => graph.meter(bus),

    dispose() {
      disposing ??= (async () => {
        rest?.();
        unsubscribeRouting();
        unsubscribeReset();
        for (const off of unsubscribeQueues) off();
        queues.speaker.clear();
        queues.participant.clear();
        replayQueue.clear();
        live = false;
        followMic?.(false);
        followMic = undefined;
        followStanding?.(false);
        followStanding = undefined;
        microphone = null;
        syncMic();
        // A microphone let go just now armed a rest: nothing rests after the close.
        rest?.();
        stopPreview();
        await graph.close();
      })();
      return disposing;
    },
  };
}
