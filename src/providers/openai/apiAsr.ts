/**
 * Fork: a recognizer that is an API — any server with OpenAI's
 * `POST /audio/transcriptions` (OpenAI itself, Groq, a LocalAI). It stands
 * where this computer's own recognizer stands (`AsrLike`), so the rest of a
 * run does not know the difference: this computer still decides where a
 * sentence ends, with the same voice-activity detector and the same knobs,
 * and each finished stretch of speech goes up as one WAV file and comes back
 * as its text.
 *
 * Nothing is written until a stretch ends — an upload has no partial
 * results — and the texts come back in the order the speech was spoken, one
 * request at a time.
 */
import { realClock, type Clock } from '../../lib/contract/clock';
import type { AsrInit, AsrLike } from '../localInference/engines';

/** The detector's worker, as far as it is used here (`native-vad.worker.ts`: it posts the edges of speech and nothing else). */
export interface VadWorker {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: { data: { type: string; message?: string } }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  terminate(): void;
}

export interface ApiAsrOptions {
  /** OpenAI-style base URL: `https://api.openai.com/v1`, `http://192.168.1.10:8080/v1`. */
  baseUrl: string;
  model: string;
  /** Absent: the server takes no key. */
  key?: string;
  fetch: typeof fetch;
  /** The app's detector by default; a stand-in in tests. */
  vad?: () => VadWorker;
  now?: () => number;
  /** What an upload's time limit is kept on: the session's clock. */
  clock?: Pick<Clock, 'setTimeout'>;
}

/** Audio kept from before the detector says speech began: it says so a moment after the first sound. */
const PRE_ROLL_SECONDS = 0.8;
/** Of the silence that ended a stretch, this much stays on the upload. */
const TAIL_KEPT_SECONDS = 0.3;
/**
 * How long one upload may take, to its text. The uploads go one at a time, so
 * one that never answers — a server stuck loading a model, a computer gone to
 * sleep — would hold every sentence after it, with nothing said.
 */
export const UPLOAD_TIMEOUT_MS = 60_000;

const appVad = (): VadWorker => new Worker(new URL('../../lib/local-inference/workers/native-vad.worker.ts', import.meta.url), { type: 'module' }) as unknown as VadWorker;

/** Where the transcription request goes, for a base URL as typed. */
export function transcriptionsUrl(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}/audio/transcriptions`;
}

/** The language as the API takes it — the two-letter code — or nothing for "detect it". */
export function apiLanguage(language: string): string | undefined {
  const base = language.trim().toLowerCase().split(/[-_]/)[0];
  return base && base !== 'auto' ? base : undefined;
}

/** 16-bit mono PCM as a WAV file. */
export function wavOf(samples: Int16Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(out.buffer);
  const tag = (offset: number, text: string) => { for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i)); };
  tag(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) view.setInt16(44 + i * 2, samples[i], true);
  return out;
}

const joined = (chunks: readonly Int16Array[]): Int16Array => {
  const out = new Int16Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
};

export function createApiAsr(options: ApiAsrOptions): AsrLike {
  const now = options.now ?? (() => Date.now());
  const clock = options.clock ?? realClock;
  const stop = new AbortController();
  let worker: VadWorker | null = null;
  let language: string | undefined;
  let rate = 24000;
  let tailTrimSeconds = 0;
  /** The last moments heard while nobody speaks. */
  let before: Int16Array[] = [];
  let beforeLength = 0;
  /** The stretch being spoken; null while nobody speaks. */
  let speech: Int16Array[] | null = null;
  /** One request at a time, in the order spoken. */
  let queue: Promise<void> = Promise.resolve();

  const asr: AsrLike = {
    onPartialResult: null,
    onResult: null,
    onSpeechStart: null,
    onError: null,
    onFatal: null,

    init(_modelId: string, init: AsrInit) {
      language = apiLanguage(init.language);
      tailTrimSeconds = Math.max(0, (init.vadConfig.minSilenceDuration ?? 0) - TAIL_KEPT_SECONDS);
      return new Promise<void>((resolve, reject) => {
        let ready = false;
        const mine = (options.vad ?? appVad)();
        worker = mine;
        mine.onmessage = ({ data }) => {
          if (data.type === 'ready') {
            ready = true;
            resolve();
          } else if (data.type === 'speech_start') {
            speech = [...before];
            before = [];
            beforeLength = 0;
            asr.onSpeechStart?.();
          } else if (data.type === 'speech_end') {
            const said = speech;
            speech = null;
            if (said) send(joined(said));
          } else if (data.type === 'speech_cancel') {
            // Too short to be speech: what was kept goes back to being the moments before.
            speech = null;
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
    },

    feedAudio(samples, sampleRate) {
      if (!worker) return;
      rate = sampleRate;
      const kept = samples.slice();
      if (speech) {
        speech.push(kept);
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
    },

    dispose() {
      stop.abort();
      worker?.postMessage({ type: 'dispose' });
      worker?.terminate();
      worker = null;
      speech = null;
      before = [];
    },
  };

  /** One stretch of speech, up to the API and back as its text. */
  function send(said: Int16Array) {
    const trimmed = said.subarray(0, Math.max(Math.ceil(0.2 * rate), said.length - Math.round(tailTrimSeconds * rate)));
    const sampleRate = rate;
    queue = queue.then(async () => {
      if (stop.signal.aborted) return;
      const started = now();
      const form = new FormData();
      form.append('file', new Blob([wavOf(trimmed, sampleRate).buffer as ArrayBuffer], { type: 'audio/wav' }), 'speech.wav');
      form.append('model', options.model);
      form.append('response_format', 'json');
      if (language) form.append('language', language);
      // Stopped with the recognizer, or given up on once the time is up: the body's reading included.
      const attempt = new AbortController();
      const onStop = () => attempt.abort();
      stop.signal.addEventListener('abort', onStop, { once: true });
      let late = false;
      const cancelTimer = clock.setTimeout(() => { late = true; attempt.abort(); }, UPLOAD_TIMEOUT_MS);
      try {
        const response = await options.fetch(transcriptionsUrl(options.baseUrl), {
          method: 'POST',
          ...(options.key ? { headers: { Authorization: `Bearer ${options.key}` } } : {}),
          body: form,
          signal: attempt.signal,
        });
        if (!response.ok) {
          const said = (await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
          asr.onError?.(`The speech recognition API answered HTTP ${response.status}${said ? `: ${said}` : ''}`);
          return;
        }
        const text = String(((await response.json()) as { text?: unknown } | null)?.text ?? '').trim();
        if (text) asr.onResult?.({ text, durationMs: Math.round((trimmed.length / sampleRate) * 1000), recognitionTimeMs: now() - started });
      } catch (error) {
        if (stop.signal.aborted) return;
        asr.onError?.(late
          ? `The speech recognition API did not answer within ${UPLOAD_TIMEOUT_MS / 1000} s.`
          : `The speech recognition API could not be reached: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        cancelTimer();
        stop.signal.removeEventListener('abort', onStop);
      }
    });
  }

  return asr;
}
