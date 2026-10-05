/**
 * Fork: the native recognition engine, as the page sees it — the main process
 * fetches it, runs it and holds its live recognitions
 * (`electron/native-engine.js`); this is the questions, their answers held to
 * their shape, and the changes as they come. Light on purpose: the settings
 * and the session both read it.
 */

export type NativeModelState = 'absent' | 'downloading' | 'verifying' | 'downloaded' | 'failed';
export type NativeRunState = 'stopped' | 'starting' | 'warming' | 'ready' | 'failed';

export interface NativeModelStatus {
  state: NativeModelState;
  /** Bytes on disk, and of the whole file. */
  received: number;
  total: number;
  /** Why the download failed, in the main process's words. */
  error?: string;
}

export interface NativeEngineStatus {
  /** The runtime is published for this system. */
  supported: boolean;
  engine: 'unsupported' | 'absent' | 'downloading' | 'ready';
  engineBytes: number;
  models: Record<string, NativeModelStatus>;
  run: { state: NativeRunState; model: string | null; port: number; tail: string };
}

export const NO_NATIVE_ENGINE: NativeEngineStatus = {
  supported: false,
  engine: 'unsupported',
  engineBytes: 0,
  models: {},
  run: { state: 'stopped', model: null, port: 0, tail: '' },
};

const MODEL_STATES: readonly NativeModelState[] = ['absent', 'downloading', 'verifying', 'downloaded', 'failed'];
const RUN_STATES: readonly NativeRunState[] = ['stopped', 'starting', 'warming', 'ready', 'failed'];
const ENGINE_STATES: readonly NativeEngineStatus['engine'][] = ['unsupported', 'absent', 'downloading', 'ready'];
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);

/** The main process's answer, held to its shape: anything else is "no engine here". */
export function nativeEngineStatus(value: unknown): NativeEngineStatus {
  const answer = value as Partial<NativeEngineStatus> | null;
  if (!answer || typeof answer !== 'object' || !ENGINE_STATES.includes(answer.engine as NativeEngineStatus['engine'])) return NO_NATIVE_ENGINE;
  const models: Record<string, NativeModelStatus> = {};
  for (const [id, raw] of Object.entries((answer.models ?? {}) as Record<string, Partial<NativeModelStatus> | null>).slice(0, 50)) {
    if (!raw || !MODEL_STATES.includes(raw.state as NativeModelState)) continue;
    models[id] = { state: raw.state as NativeModelState, received: count(raw.received), total: count(raw.total), ...(typeof raw.error === 'string' && raw.error ? { error: raw.error.slice(0, 300) } : {}) };
  }
  const run = (answer.run ?? {}) as Partial<NativeEngineStatus['run']>;
  return {
    supported: answer.supported === true,
    engine: answer.engine as NativeEngineStatus['engine'],
    engineBytes: count(answer.engineBytes),
    models,
    run: {
      state: RUN_STATES.includes(run.state as NativeRunState) ? (run.state as NativeRunState) : 'stopped',
      model: typeof run.model === 'string' && run.model ? run.model : null,
      port: Number.isInteger(run.port) && (run.port as number) > 0 && (run.port as number) < 65536 ? (run.port as number) : 0,
      tail: typeof run.tail === 'string' ? run.tail.slice(0, 4000) : '',
    },
  };
}

interface ElectronApi {
  invoke(channel: string, data?: unknown): Promise<unknown>;
  receive(channel: string, listener: (payload: never) => void): void;
  removeListener(channel: string, listener: (payload: never) => void): void;
}
const electron = (): ElectronApi | undefined => (typeof window === 'undefined' ? undefined : (window as unknown as { electron?: ElectronApi }).electron);

export type NativeEngineAction = 'get' | 'download' | 'cancel' | 'remove' | 'start' | 'stop';

/**
 * The two engines the main process runs this way, by the name their channels
 * go by: the one that hears (audio.cpp), and the one that translates
 * (llama.cpp's server).
 */
export type NativeEngineName = 'native-engine' | 'native-translator';

/** Asks the main process; resolves with the state of things, which says what failed. Never rejects. */
export async function askNativeEngine(action: NativeEngineAction, id?: string, engine: NativeEngineName = 'native-engine'): Promise<NativeEngineStatus> {
  const api = electron();
  if (!api) return NO_NATIVE_ENGINE;
  try {
    return nativeEngineStatus(await api.invoke(`${engine}:${action}`, id === undefined ? undefined : { id }));
  } catch {
    return NO_NATIVE_ENGINE;
  }
}

/** Its state as it changes — a download's progress, a start's steps. Returns the way to stop listening. */
export function onNativeEngineStatus(listener: (status: NativeEngineStatus) => void, engine: NativeEngineName = 'native-engine'): () => void {
  const api = electron();
  if (!api) return () => {};
  const mine = (payload: unknown) => listener(nativeEngineStatus(payload));
  api.receive(`${engine}:status`, mine as (payload: never) => void);
  return () => api.removeListener(`${engine}:status`, mine as (payload: never) => void);
}

/**
 * What a live recognition says: a piece of text that will not change, the whole of it at its end, or why it failed —
 * and, from a recognizer that has one (the Mac's), everything heard so far as it stands now, before it is settled.
 */
export type NativeStreamEvent =
  | { id: number; type: 'delta'; text: string }
  | { id: number; type: 'partial'; text: string }
  | { id: number; type: 'done'; text: string }
  | { id: number; type: 'error'; message: string };

/** The live recognitions of the engine, as the recognizer uses them (`src/providers/openai/nativeAsr.ts`). */
export interface NativeBridge {
  /** Opens one: its id, or null while the engine is not ready. */
  open(init: { language: string; sampleRate: number }): Promise<number | null>;
  write(id: number, pcm: Int16Array): void;
  /** The sound is over: the rest of the text follows, then `done`. */
  end(id: number): void;
  abort(id: number): void;
  listen(listener: (event: NativeStreamEvent) => void): () => void;
}

/** A stream event from the main process, held to its shape; null for anything else. */
export function nativeStreamEvent(value: unknown): NativeStreamEvent | null {
  const event = value as { id?: unknown; type?: unknown; text?: unknown; message?: unknown } | null;
  if (!event || typeof event !== 'object' || !Number.isInteger(event.id)) return null;
  const id = event.id as number;
  if (event.type === 'delta' && typeof event.text === 'string') return { id, type: 'delta', text: event.text };
  if (event.type === 'partial' && typeof event.text === 'string') return { id, type: 'partial', text: event.text };
  if (event.type === 'done') return { id, type: 'done', text: typeof event.text === 'string' ? event.text : '' };
  if (event.type === 'error') return { id, type: 'error', message: typeof event.message === 'string' ? event.message.slice(0, 300) : 'The engine failed.' };
  return null;
}

/** The engine's live recognitions over IPC. */
export const ipcNativeBridge: NativeBridge = {
  async open(init) {
    const api = electron();
    if (!api) return null;
    try {
      const id = await api.invoke('native-engine:stream-open', init);
      return Number.isInteger(id) ? (id as number) : null;
    } catch {
      return null;
    }
  },
  write(id, pcm) {
    // A copy of exactly these samples: the message takes the buffer's bytes as they are.
    const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength).slice();
    void electron()?.invoke('native-engine:stream-audio', { id, pcm: bytes }).catch(() => undefined);
  },
  end(id) { void electron()?.invoke('native-engine:stream-end', { id }).catch(() => undefined); },
  abort(id) { void electron()?.invoke('native-engine:stream-abort', { id }).catch(() => undefined); },
  listen(listener) {
    const api = electron();
    if (!api) return () => {};
    const mine = (payload: unknown) => { const event = nativeStreamEvent(payload); if (event) listener(event); };
    api.receive('native-engine:stream', mine as (payload: never) => void);
    return () => api.removeListener('native-engine:stream', mine as (payload: never) => void);
  },
};
