/**
 * Fork: this computer's native recognizer — the engine the app downloads and
 * runs beside itself (`electron/native-engine.js`), given the voice as it
 * comes and writing while it listens. It stands where the app's own
 * recognizers stand (`AsrLike`), with the same voice-activity detector and
 * the same knobs deciding where a sentence ends.
 *
 * One stretch of speech is one live recognition: opened when the detector
 * hears a voice, with the moments before it, and closed when the pause it
 * waits for has passed — the pause itself goes to the engine too, which
 * needs a little silence to write its last word. What it has written so far
 * is the partial; what it has at the end is the result.
 *
 * Where the detector cuts a long stretch (its longest turn), the speaker is
 * still talking: what is written so far becomes a result, so that it is
 * translated, but the recognition is not closed — the engine keeps its
 * context, and no word is lost at a seam. Only a recognition that has run
 * for most of a minute is closed and begun again, at a gap between words
 * when there is one: the engine takes about two minutes at most.
 *
 * The engine runs one recognition at a time, so they queue: a stretch that
 * begins while the last one is still being finished keeps its sound until
 * the engine is free.
 */
import { realClock, type Clock } from '../../lib/contract/clock';
import type { NativeBridge, NativeEngineStatus, NativeStreamEvent } from '../../lib/native/nativeEngine';
import type { AsrInit, AsrLike } from '../localInference/engines';
import { apiLanguage, appVad, type VadWorker } from './apiAsr';

export interface NativeAsrOptions {
  /** The engine's live recognitions. */
  bridge: NativeBridge;
  /** Brings the engine up with this recognizer's model, and answers once it is ready — or how it failed. */
  start(): Promise<NativeEngineStatus>;
  /** The app's detector by default; a stand-in in tests. */
  vad?: () => VadWorker;
  now?: () => number;
  /** What the wait for a recognition's last words is kept on: the session's clock. */
  clock?: Pick<Clock, 'setTimeout'>;
}

/** Audio kept from before the detector says speech began: it says so a moment after the first sound. */
const PRE_ROLL_SECONDS = 0.8;
/** The silence the engine needs after the last word to write it; added when the detector's own pause is shorter. */
const TRAILING_SILENCE_SECONDS = 0.3;
/** A recognition this long is begun again at the next gap between words… */
export const ROLL_AFTER_SECONDS = 45;
/** …or where the detector cuts, once it is this long, or anywhere at this: the engine's own limit is near two minutes. */
export const ROLL_AT_SECONDS = 60;
export const ROLL_HARD_SECONDS = 90;
/** A gap between words: this long with no sample louder than this (of 32768). */
const GAP_SECONDS = 0.2;
const GAP_PEAK = 600;
/** How long a closed recognition's last words are waited for. Its sound is already heard: they come at once, or the engine is stuck. */
export const LAST_WORDS_TIMEOUT_MS = 4000;

/** One live recognition, from the stretch that opened it to its last words. */
interface Stream {
  /** Null until the engine has opened it: it opens one at a time. */
  id: number | null;
  opening: boolean;
  /** The sound it is owed while it is not open yet. */
  backlog: Int16Array[];
  /** Everything written so far, and how much of it has gone out as results. */
  text: string;
  emitted: number;
  /** Samples of sound given: in all, and since the last result. */
  samples: number;
  pieceSamples: number;
  /** No more sound comes: the engine is told as soon as it has it open. */
  closed: boolean;
  closedAt: number;
  /** Too short to be speech: whatever is written of it is not kept. */
  misfire: boolean;
  /** Over: by its last words, an error, or the wait running out. */
  over: boolean;
  cancelWait: (() => void) | null;
}

export function createNativeAsr(options: NativeAsrOptions): AsrLike {
  const { bridge } = options;
  const now = options.now ?? (() => Date.now());
  const clock = options.clock ?? realClock;
  let worker: VadWorker | null = null;
  let unlisten: (() => void) | null = null;
  let disposed = false;
  let language = '';
  let rate = 24000;
  let padSeconds = 0;
  /** The last moments heard while nobody speaks. */
  let before: Int16Array[] = [];
  let beforeLength = 0;
  /** The recognitions not over yet, oldest first: the engine has the first. */
  const queue: Stream[] = [];
  /** The one still taking sound; null while nobody speaks. */
  let live: Stream | null = null;
  /** Samples in a row with nothing loud, while the live recognition is old enough to begin again. */
  let quiet = 0;

  const secondsOf = (samples: number) => samples / rate;
  const pending = (s: Stream) => s.text.slice(s.emitted);

  /** Sound for a recognition: to the engine once it has it open, kept until then. */
  function give(s: Stream, pcm: Int16Array) {
    s.samples += pcm.length;
    s.pieceSamples += pcm.length;
    if (s.id !== null) bridge.write(s.id, pcm);
    else s.backlog.push(pcm);
  }

  /** A new recognition, taking sound from now on; the engine opens it when it is its turn. */
  function begin(): Stream {
    const s: Stream = { id: null, opening: false, backlog: [], text: '', emitted: 0, samples: 0, pieceSamples: 0, closed: false, closedAt: 0, misfire: false, over: false, cancelWait: null };
    queue.push(s);
    live = s;
    quiet = 0;
    advance();
    return s;
  }

  /** The engine takes the oldest recognition, when it has none open. */
  function advance() {
    const head = queue[0];
    if (!head || head.id !== null || head.opening || disposed) return;
    head.opening = true;
    void bridge.open({ language, sampleRate: rate }).then((id) => {
      head.opening = false;
      if (head.over || disposed) {
        if (id !== null) bridge.abort(id);
        return;
      }
      if (id === null) {
        // The engine is gone: nothing more will be written, by this recognition or the next.
        for (const s of queue) { s.over = true; s.cancelWait?.(); }
        queue.length = 0;
        live = null;
        asr.onFatal?.('The recognition engine of this computer is not running.');
        return;
      }
      head.id = id;
      for (const pcm of head.backlog) bridge.write(id, pcm);
      head.backlog = [];
      if (head.closed) end(head);
    });
  }

  /** The engine is told a recognition has all its sound; its last words are waited for, not for ever. */
  function end(s: Stream) {
    if (s.id === null) return;
    bridge.end(s.id);
    s.cancelWait = clock.setTimeout(() => {
      if (s.over) return;
      if (s.id !== null) bridge.abort(s.id);
      finish(s, s.text);
    }, LAST_WORDS_TIMEOUT_MS);
  }

  /** No more sound for this recognition. */
  function close(s: Stream) {
    if (s.closed) return;
    if (padSeconds > 0) give(s, new Int16Array(Math.round(padSeconds * rate)));
    s.closed = true;
    s.closedAt = now();
    if (live === s) live = null;
    end(s);
  }

  /** What is written and not yet a result becomes one; the recognition goes on. */
  function piece(s: Stream) {
    const text = pending(s).trim();
    if (!text) return;
    asr.onResult?.({ text, durationMs: Math.round(secondsOf(s.pieceSamples) * 1000), recognitionTimeMs: 0 });
    s.emitted = s.text.length;
    s.pieceSamples = 0;
  }

  /** A recognition is over: the rest of its text is its last result, and the engine takes the next. */
  function finish(s: Stream, whole: string) {
    if (s.over) return;
    s.over = true;
    s.cancelWait?.();
    const at = queue.indexOf(s);
    if (at >= 0) queue.splice(at, 1);
    if (live === s) live = null;
    // The engine's own account of the whole, where it agrees with what has already gone out.
    const text = whole.startsWith(s.text.slice(0, s.emitted)) ? whole : s.text;
    // An empty result too: it closes what the partials opened.
    asr.onResult?.({ text: s.misfire ? '' : text.slice(s.emitted).trim(), durationMs: Math.round(secondsOf(s.pieceSamples) * 1000), recognitionTimeMs: s.closed ? Math.max(0, now() - s.closedAt) : 0 });
    advance();
  }

  /** The live recognition is closed and another begun at once: the speaker has not stopped. */
  function roll(s: Stream) {
    close(s);
    begin();
  }

  function onEvent(event: NativeStreamEvent) {
    const s = queue.find((candidate) => candidate.id === event.id);
    if (!s || s.over) return;
    if (event.type === 'delta') {
      s.text += event.text;
      if (!s.misfire) asr.onPartialResult?.(pending(s));
    } else if (event.type === 'done') {
      finish(s, event.text || s.text);
    } else {
      s.over = true;
      s.cancelWait?.();
      queue.splice(queue.indexOf(s), 1);
      if (live === s) live = null;
      asr.onError?.(event.message);
      advance();
    }
  }

  const asr: AsrLike = {
    onPartialResult: null,
    onResult: null,
    onSpeechStart: null,
    onError: null,
    onFatal: null,

    async init(_modelId: string, init: AsrInit) {
      language = apiLanguage(init.language) ?? '';
      padSeconds = Math.max(0, TRAILING_SILENCE_SECONDS - (init.vadConfig.minSilenceDuration ?? 0));
      unlisten = bridge.listen(onEvent);
      const detector = new Promise<void>((resolve, reject) => {
        let ready = false;
        const mine = (options.vad ?? appVad)();
        worker = mine;
        mine.onmessage = ({ data }) => {
          if (data.type === 'ready') {
            ready = true;
            resolve();
          } else if (data.type === 'speech_start') {
            asr.onSpeechStart?.();
            // After a cut the detector made, the recognition is still open: the voice simply goes on.
            if (live) return;
            const s = begin();
            for (const pcm of before) give(s, pcm);
            before = [];
            beforeLength = 0;
          } else if (data.type === 'speech_end') {
            if (!live) return;
            if (data.forced) {
              piece(live);
              if (secondsOf(live.samples) >= ROLL_AT_SECONDS) roll(live);
            } else {
              close(live);
            }
          } else if (data.type === 'speech_cancel') {
            if (!live) return;
            // Too short to be speech — unless it is the tail of a stretch already heard.
            if (live.emitted === 0 && secondsOf(live.samples) < PRE_ROLL_SECONDS + 2) live.misfire = true;
            close(live);
          } else if (data.type === 'error') {
            if (ready) asr.onError?.(`The voice-activity detector failed: ${data.message ?? 'unknown error'}`);
            else reject(new Error(data.message ?? 'The voice-activity detector could not start.'));
          }
        };
        mine.onerror = (event) => {
          const message = (event as { message?: string } | null)?.message ?? 'The voice-activity detector stopped.';
          if (ready) asr.onFatal?.(message);
          else reject(new Error(message));
        };
        mine.postMessage({
          type: 'init',
          ortWasmBaseUrl: new URL('./wasm/ort/', window.location.href).href,
          vadModelUrl: new URL('./wasm/vad/silero_vad_v5.onnx', window.location.href).href,
          vadConfig: init.vadConfig,
        });
      });
      const engine = options.start().then((status) => {
        if (status.run.state === 'ready') return;
        const said = status.run.tail.trim().split('\n').pop()?.slice(0, 200);
        throw new Error(`The recognition engine of this computer could not start${said ? `: ${said}` : '.'}`);
      });
      // Either failing fails the start; the other's failure is then nobody's to hear.
      detector.catch(() => undefined);
      engine.catch(() => undefined);
      await Promise.all([detector, engine]);
    },

    feedAudio(samples, sampleRate) {
      if (!worker) return;
      rate = sampleRate;
      const kept = samples.slice();
      if (live) {
        give(live, kept);
        const age = secondsOf(live.samples);
        if (age >= ROLL_AFTER_SECONDS) {
          let loud = false;
          for (let i = 0; i < kept.length; i += 1) {
            if (kept[i] > GAP_PEAK || kept[i] < -GAP_PEAK) { loud = true; break; }
          }
          quiet = loud ? 0 : quiet + kept.length;
          if (secondsOf(quiet) >= GAP_SECONDS || age >= ROLL_HARD_SECONDS) roll(live);
        }
      } else {
        before.push(kept);
        beforeLength += kept.length;
        const most = Math.ceil(PRE_ROLL_SECONDS * sampleRate);
        while (before.length > 1 && beforeLength - before[0].length >= most) beforeLength -= before.shift()!.length;
      }
      // The detector gets a copy of its own: the buffer goes with the message.
      const copy = samples.slice();
      worker.postMessage({ type: 'audio', pcm: copy, sampleRate }, [copy.buffer]);
    },

    flush() {
      worker?.postMessage({ type: 'flush' });
      // The turn is over whatever the detector thinks of it: after its own cut it would say nothing.
      if (live) close(live);
    },

    dispose() {
      disposed = true;
      unlisten?.();
      unlisten = null;
      for (const s of queue) {
        s.over = true;
        s.cancelWait?.();
        if (s.id !== null) bridge.abort(s.id);
      }
      queue.length = 0;
      live = null;
      worker?.postMessage({ type: 'dispose' });
      worker?.terminate();
      worker = null;
      before = [];
    },
  };

  return asr;
}
