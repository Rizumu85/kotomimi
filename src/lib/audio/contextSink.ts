/**
 * Fork: a bus's output as an audio context of its own, sitting on the bus's device, where the graph was given an
 * `<audio>` element. An element that plays the graph's stream starves in stretches, heard as crackle through every
 * spoken translation: on Windows about 60 ms of silence four times a second while the graph's own context runs off a
 * device clock, and a few times a minute otherwise (measured 2026-11-21 with a steady tone on an unused output:
 * 77 holes in 15 s and 8 in 60 s; a context taking the same stream had one hole of 8 ms in each).
 *
 * It is the element the graph knows (`SinkElement`): paused until played, switched to a device with `setSinkId`,
 * given another stream when the graph rebuilds. Each switch opens a fresh context, so one a vanished device wedged
 * is left behind, not waited for.
 */
import { KEEP_AWAKE_LEVEL, type SinkElement } from './graph';

type SinkContext = AudioContext & { setSinkId?(id: string): Promise<void> };

export function contextSink(stream: MediaStream, create: () => AudioContext = () => new AudioContext()): SinkElement {
  /** A context that stays on its device through the silence between sentences, as the graph's own does (`KEEP_AWAKE_LEVEL`). */
  const open = (): SinkContext => {
    const made = create();
    const awake = made.createConstantSource();
    awake.offset.value = KEEP_AWAKE_LEVEL;
    awake.connect(made.destination);
    awake.start();
    return made;
  };
  let source: MediaProvider | null = stream;
  let ctx: SinkContext | null = null;
  let node: MediaStreamAudioSourceNode | null = null;
  let playing = false;

  /** The stream reaches the device only while playing: paused, nothing of it does. */
  const connect = () => {
    node?.disconnect();
    node = null;
    if (!playing || !ctx || !source) return;
    node = ctx.createMediaStreamSource(source as MediaStream);
    node.connect(ctx.destination);
  };
  const drop = (old: AudioContext | null) => { void old?.close().catch(() => {}); };

  return {
    get srcObject() { return source; },
    set srcObject(value) {
      source = value;
      connect();
    },
    get paused() { return !playing; },

    async setSinkId(id) {
      const next = open();
      try {
        // '' is the system's own output, which a new context is on already.
        if (id) {
          if (!next.setSinkId) throw new Error('This audio context cannot choose its device.');
          await next.setSinkId(id);
        }
      } catch (error) {
        drop(next);
        throw error;
      }
      const old = ctx;
      ctx = next;
      connect();
      // Not playing, it holds no device open.
      if (!playing) void next.suspend().catch(() => {});
      drop(old);
    },

    async play() {
      playing = true;
      ctx ??= open();
      connect();
      if (ctx.state === 'suspended') await ctx.resume();
    },

    pause() {
      playing = false;
      connect();
      void ctx?.suspend().catch(() => {});
    },
  };
}
