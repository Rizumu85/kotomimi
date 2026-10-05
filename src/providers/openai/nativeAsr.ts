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
 *
 * Two things measured 2026-10-05 shape how a recognition is closed. The
 * engine writes the end of what it heard only if about a second of silence
 * came before the close: closed right on a voice, it leaves out the last
 * several seconds. So a recognition closed while the speaker is still
 * talking is given that second of silence first. And the model sometimes
 * falls silent — it listens and writes nothing for ten or twenty seconds,
 * then everything at once (one clip of seven, in the engine's own client as
 * well). Closing does not make it write then, and loses what it would have
 * written later; so nothing is done about it but to wait.
 *
 * The engine is given its sound at the 16 kHz it reads, brought down here
 * (`resample.ts`): it would do that itself, less carefully.
 */
import { realClock, type Clock } from '../../lib/contract/clock';
import type { NativeBridge, NativeEngineStatus, NativeStreamEvent } from '../../lib/native/nativeEngine';
import { createResampler, TARGET_RATE, type Resampler } from '../../lib/native/resample';
import type { AsrInit, AsrLike } from '../localInference/engines';
import { apiLanguage, appVad, type VadWorker } from './apiAsr';

export interface NativeAsrOptions {
  /** The engine's live recognitions. */
  bridge: NativeBridge;
  /** Brings the engine up with this recognizer's model, and answers once it is ready — or how it failed. */
  start(): Promise<NativeEngineStatus>;
  /** That model: named with every recognition, for a computer whose native recognizers are more than one engine. */
  model?: string;
  /** The app's detector by default; a stand-in in tests. */
  vad?: () => VadWorker;
  now?: () => number;
  /** What the wait for a recognition's last words is kept on: the session's clock. */
  clock?: Pick<Clock, 'setTimeout'>;
  /** How long one recognition may run, where the engine's own limits are not the default's (`NativeLimits`). */
  limits?: Partial<NativeLimits>;
}

/**
 * How long one recognition runs, in seconds of sound: begun again at a gap
 * between words once it is `rollAfter` long; where the detector cuts, once it
 * is `rollAt` long (0: at every cut); and anywhere at `rollHard`.
 */
export interface NativeLimits {
  rollAfter: number;
  rollAt: number;
  rollHard: number;
  /** How long a closed recognition's last words are waited for, in milliseconds: longer for a model that reads the whole stretch once more at its end. */
  lastWordsMs: number;
}

/** Audio kept from before the detector says speech began: it says so a moment after the first sound. */
const PRE_ROLL_SECONDS = 0.8;
/**
 * The silence the engine needs before a close to write the end of what it heard: with a quarter of a second it left
 * out six seconds of speech, with half a second nothing. Added where the detector's own pause is shorter, and in
 * full where a recognition is closed with the speaker still talking.
 */
const TRAILING_SILENCE_SECONDS = 1;
/** A recognition this long is begun again at the next gap between words… */
export const ROLL_AFTER_SECONDS = 45;
/** …or where the detector cuts, once it is this long, or anywhere at this: the engine's own limit is near two minutes. */
export const ROLL_AT_SECONDS = 60;
export const ROLL_HARD_SECONDS = 90;
/**
 * A gap between words: this long with no sample louder than a tenth of how loud the voice has lately been — or than
 * this (of 32768), for a voice that is very quiet itself.
 */
const GAP_SECONDS = 0.2;
const GAP_PEAK = 600;
const GAP_OF_LEVEL = 0.1;
/** How loud the voice has lately been: the loudest sample, let down by this much with every piece of sound. */
const LEVEL_DECAY = 0.995;
/** How long a closed recognition's last words are waited for. Its sound is already heard: they come at once, or the engine is stuck. */
export const LAST_WORDS_TIMEOUT_MS = 4000;

/** One live recognition, from the stretch that opened it to its last words. */
interface Stream {
  /** Null until the engine has opened it: it opens one at a time. */
  id: number | null;
  /** Brings its sound down to the engine's rate, a piece at a time; null where the engine takes the rate as it is. */
  resampler: Resampler | null;
  opening: boolean;
  /** The sound it is owed while it is not open yet. */
  backlog: Int16Array[];
  /** Everything written so far, and how much of it has gone out as results. */
  text: string;
  emitted: number;
  /** The engine says what it has heard before that is settled (`partial`): what shows is that, not the settled text, which comes late. */
  tentative: boolean;
  /** The last of those: all there is of a recognition whose engine settles nothing before the end, should the end not come. */
  heard: string;
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
  const limits: NativeLimits = { rollAfter: ROLL_AFTER_SECONDS, rollAt: ROLL_AT_SECONDS, rollHard: ROLL_HARD_SECONDS, lastWordsMs: LAST_WORDS_TIMEOUT_MS, ...options.limits };
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
  /** How loud the voice has lately been (`LEVEL_DECAY`). */
  let level = 0;
  /** The detector hears a voice now; and, while it does not but a recognition is open, for how many samples it has not. */
  let voice = false;
  let idle = 0;
  /** The pause that ends a stretch, as the detector was told it. */
  let pauseSeconds = 1.4;

  const secondsOf = (samples: number) => samples / rate;
  const pending = (s: Stream) => s.text.slice(s.emitted);

  /** Sound for a recognition: to the engine once it has it open, kept until then. */
  function give(s: Stream, pcm: Int16Array) {
    s.samples += pcm.length;
    s.pieceSamples += pcm.length;
    const sound = s.resampler ? s.resampler.process(pcm) : pcm;
    if (sound.length === 0) return;
    if (s.id !== null) bridge.write(s.id, sound);
    else s.backlog.push(sound);
  }

  /** A new recognition, taking sound from now on; the engine opens it when it is its turn. */
  function begin(): Stream {
    const resampler = createResampler(rate);
    const s: Stream = { id: null, resampler, opening: false, backlog: [], text: '', emitted: 0, tentative: false, heard: '', samples: 0, pieceSamples: 0, closed: false, closedAt: 0, misfire: false, over: false, cancelWait: null };
    queue.push(s);
    live = s;
    quiet = 0;
    idle = 0;
    advance();
    return s;
  }

  /** The engine takes the oldest recognition, when it has none open. */
  function advance() {
    const head = queue[0];
    if (!head || head.id !== null || head.opening || disposed) return;
    head.opening = true;
    void bridge.open({ language, sampleRate: head.resampler ? TARGET_RATE : rate, ...(options.model ? { model: options.model } : {}) }).then((id) => {
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
      // What was last heard of it, where nothing was settled: better than nothing.
      finish(s, s.text || s.heard);
    }, limits.lastWordsMs);
  }

  /** No more sound for this recognition; `silence` is how much of it to add first, where the voice gave less. */
  function close(s: Stream, silence = padSeconds) {
    if (s.closed) return;
    if (silence > 0) give(s, new Int16Array(Math.round(silence * rate)));
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
    // The engine's own account of the whole: it ends with words no partial carried. Where it differs a little from
    // what was written on the way — a character here and there — it is still read from where the results left off.
    const text = whole.length >= s.text.length ? whole : s.text;
    // An empty result too: it closes what the partials opened.
    asr.onResult?.({ text: s.misfire ? '' : text.slice(s.emitted).trim(), durationMs: Math.round(secondsOf(s.pieceSamples) * 1000), recognitionTimeMs: s.closed ? Math.max(0, now() - s.closedAt) : 0 });
    advance();
  }

  /** The live recognition is closed and another begun at once: the speaker has not stopped, so the silence is added. */
  function roll(s: Stream) {
    close(s, TRAILING_SILENCE_SECONDS);
    begin();
  }

  function onEvent(event: NativeStreamEvent) {
    const s = queue.find((candidate) => candidate.id === event.id);
    if (!s || s.over) return;
    if (event.type === 'partial') {
      s.tentative = true;
      s.heard = event.text;
      // Everything heard so far, as it stands: what follows the results already given, by their length.
      if (!s.misfire) asr.onPartialResult?.(event.text.slice(s.emitted));
    } else if (event.type === 'delta') {
      s.text += event.text;
      if (!s.misfire && !s.tentative) asr.onPartialResult?.(pending(s));
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
      pauseSeconds = init.vadConfig.minSilenceDuration ?? pauseSeconds;
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
            voice = true;
            idle = 0;
            asr.onSpeechStart?.();
            // After a cut the detector made, the recognition is still open: the voice simply goes on.
            if (live) return;
            const s = begin();
            for (const pcm of before) give(s, pcm);
            before = [];
            beforeLength = 0;
          } else if (data.type === 'speech_end') {
            voice = false;
            idle = 0;
            if (!live) return;
            if (data.forced) {
              // Closed here, the engine writes all it heard at once: no result is cut from what is settled so far.
              if (secondsOf(live.samples) >= limits.rollAt) {
                roll(live);
              } else {
                piece(live);
              }
            } else {
              close(live);
            }
          } else if (data.type === 'speech_cancel') {
            voice = false;
            idle = 0;
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
        let peak = 0;
        for (let i = 0; i < kept.length; i += 1) {
          const size = kept[i] < 0 ? -kept[i] : kept[i];
          if (size > peak) peak = size;
        }
        const loud = peak > Math.max(GAP_PEAK, level * GAP_OF_LEVEL);
        level = Math.max(peak, level * LEVEL_DECAY);
        if (age >= limits.rollAfter) {
          quiet = loud ? 0 : quiet + kept.length;
          if (secondsOf(quiet) >= GAP_SECONDS || age >= limits.rollHard) roll(live);
        }
        // Open after a cut of the detector's own, and no voice since: the speaker had just stopped. The pause has passed
        // in what the recognition was given, so it is closed as the detector would have closed it.
        if (!voice && live) {
          idle += kept.length;
          if (secondsOf(idle) >= pauseSeconds) close(live);
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
