/**
 * Fork: what a voice stage is asked through on this page (`src/providers/openai/voice.ts`): the browser's decoder,
 * this computer's voice engine over IPC (`electron/native-engine.js`, the `native-voice` channels), and Microsoft
 * Edge's online voices (`src/lib/edge-tts`).
 */
import { SAMPLE_RATE } from '../contract/adapter';
import { EdgeTtsConnection } from '../edge-tts/EdgeTtsConnection';
import { float32ToInt16 } from '../../utils/audio-conversion';
import type { VoiceDeps } from '../../providers/openai/voice';

interface ElectronApi {
  invoke(channel: string, data?: unknown): Promise<unknown>;
  receive(channel: string, listener: (payload: never) => void): void;
  removeListener(channel: string, listener: (payload: never) => void): void;
}
const electron = (): ElectronApi | undefined => (typeof window === 'undefined' ? undefined : (window as unknown as { electron?: ElectronApi }).electron);

/** Any container the browser decodes, first channel, at the contract's rate: the offline context resamples as it decodes. */
export async function decodeToContract(bytes: ArrayBuffer): Promise<Int16Array> {
  const buffer = await new OfflineAudioContext(1, 1, SAMPLE_RATE).decodeAudioData(bytes);
  return float32ToInt16(buffer.getChannelData(0));
}

let speakIds = 0;

/** A piece of sound from the voice engine, held to its shape; null for anything else. */
export function voiceAudioEvent(value: unknown): { id: number; sampleRate: number; pcm: Int16Array } | null {
  const event = value as { id?: unknown; sampleRate?: unknown; pcm?: unknown } | null;
  if (!event || typeof event !== 'object' || !Number.isInteger(event.id) || !Number.isInteger(event.sampleRate)) return null;
  const rate = event.sampleRate as number;
  if (rate < 8000 || rate > 96000 || !(event.pcm instanceof Uint8Array) || event.pcm.byteLength < 2) return null;
  // A copy on an even boundary: the message's bytes may start anywhere in their buffer.
  const bytes = event.pcm.slice(0, event.pcm.byteLength - (event.pcm.byteLength % 2));
  return { id: event.id as number, sampleRate: rate, pcm: new Int16Array(bytes.buffer, 0, bytes.byteLength / 2) };
}

/** This computer's voice engine: the main process asks it, and hands on the sound as it is made. */
const speakNative: VoiceDeps['native'] = async (request, onPcm, signal) => {
  const api = electron();
  if (!api) throw new Error('This build has no voice engine.');
  const id = ++speakIds;
  const mine = (payload: unknown) => {
    const event = voiceAudioEvent(payload);
    if (event && event.id === id && !signal.aborted) onPcm(event.pcm, event.sampleRate);
  };
  const stop = () => { void api.invoke('native-voice:speak-stop', { id }).catch(() => undefined); };
  api.receive('native-voice:audio', mine as (payload: never) => void);
  signal.addEventListener('abort', stop, { once: true });
  try {
    if (signal.aborted) throw new Error('The voice was stopped.');
    const answer = (await api.invoke('native-voice:speak', { id, ...request })) as { ok?: unknown; error?: unknown } | null;
    if (!answer || answer.ok !== true) throw new Error(typeof answer?.error === 'string' && answer.error ? answer.error.slice(0, 300) : 'The voice engine did not answer.');
  } finally {
    signal.removeEventListener('abort', stop);
    api.removeListener('native-voice:audio', mine as (payload: never) => void);
  }
};

/** One sentence from Edge, whole. */
function edgeOnce(request: { text: string; voice: string }, signal: AbortSignal): Promise<ArrayBuffer> {
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const connection = new EdgeTtsConnection();
    const chunks: Uint8Array[] = [];
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', stop);
      connection.dispose();
      fn();
    };
    const stop = () => settle(() => reject(new Error('The voice was stopped.')));
    if (signal.aborted) { stop(); return; }
    signal.addEventListener('abort', stop, { once: true });
    connection.generate(
      { text: request.text, voice: request.voice },
      (chunk) => { chunks.push(chunk); },
      () => settle(() => {
        const whole = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
        let at = 0;
        for (const chunk of chunks) { whole.set(chunk, at); at += chunk.length; }
        resolve(whole.buffer);
      }),
      (error) => settle(() => reject(new Error(error))),
    ).catch((error: unknown) => settle(() => reject(error instanceof Error ? error : new Error(String(error)))));
  });
}

/**
 * Edge's requests go one at a time: its connection sets a one-shot header rule per host for the upgrade, and two
 * at once would take each other's. A request it does not answer is asked once more (about one in twelve, measured
 * 2026-11-17).
 */
let edgeTurn: Promise<unknown> = Promise.resolve();
/** The first try is given this long: a sentence comes whole within a second or two, or not at all. */
const EDGE_FIRST_TRY_MS = 8000;
const speakEdge: VoiceDeps['edge'] = (request, signal) => {
  const mine = edgeTurn.then(async () => {
    // Given up while it waited its turn: nothing is asked, and whoever is next does not wait for it.
    if (signal.aborted) throw new Error('The voice was stopped.');
    const first = new AbortController();
    const stop = () => first.abort();
    signal.addEventListener('abort', stop, { once: true });
    const limit = setTimeout(stop, EDGE_FIRST_TRY_MS);
    try {
      return await edgeOnce(request, first.signal);
    } catch (error) {
      if (signal.aborted) throw error;
      return edgeOnce(request, signal);
    } finally {
      clearTimeout(limit);
      signal.removeEventListener('abort', stop);
    }
  });
  edgeTurn = mine.catch(() => undefined);
  return mine;
};

export const liveVoiceDeps: Pick<VoiceDeps, 'decode' | 'native' | 'edge'> = {
  decode: decodeToContract,
  native: speakNative,
  edge: speakEdge,
};
