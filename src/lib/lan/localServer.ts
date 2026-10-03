/**
 * Fork: the LocalAI installed on this computer, as the page sees it — the
 * main process finds, starts and stops it (`electron/local-server.js`); this
 * is the question, its answer held to its shape, and the changes as they
 * come. Light on purpose: the title bar reads it.
 */

export type LocalServerState = 'absent' | 'stopped' | 'starting' | 'running' | 'external' | 'failed';

export interface LocalServerStatus {
  installed: boolean;
  /** `running`: started by this app. `external`: up, started by something else, and not this app's to stop. */
  state: LocalServerState;
  port: number;
  /** The models it lists while it is up. */
  models: string[];
  /** Its last words, when it would not start. */
  tail: string;
}

export const NO_LOCAL_SERVER: LocalServerStatus = { installed: false, state: 'absent', port: 8080, models: [], tail: '' };

const STATES: readonly LocalServerState[] = ['absent', 'stopped', 'starting', 'running', 'external', 'failed'];

/** The main process's answer, held to its shape: anything else is "none installed". */
export function localServerStatus(value: unknown): LocalServerStatus {
  const answer = value as Partial<LocalServerStatus> | null;
  if (!answer || typeof answer !== 'object' || !STATES.includes(answer.state as LocalServerState)) return NO_LOCAL_SERVER;
  return {
    installed: answer.installed === true,
    state: answer.state as LocalServerState,
    port: Number.isInteger(answer.port) && (answer.port as number) > 0 && (answer.port as number) < 65536 ? (answer.port as number) : 8080,
    models: Array.isArray(answer.models) ? answer.models.filter((m): m is string => typeof m === 'string').slice(0, 200) : [],
    tail: typeof answer.tail === 'string' ? answer.tail.slice(0, 4000) : '',
  };
}

/** One Realtime pipeline of the LocalAI: the recognizer and the text model it names. */
export interface LocalPipeline { name: string; transcription: string; llm: string }

/** Its pipelines, and the models each stage could name instead. */
export interface LocalPipelines {
  pipelines: LocalPipeline[];
  recognizers: string[];
  translators: string[];
  /** After a change: whether it took, and LocalAI's words when it did not. */
  ok?: boolean;
  error?: string;
}

export const NO_PIPELINES: LocalPipelines = { pipelines: [], recognizers: [], translators: [] };

const names = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v !== '').slice(0, 200) : []);

/** The main process's answer, held to its shape. */
export function localPipelines(value: unknown): LocalPipelines {
  const answer = value as Partial<LocalPipelines> | null;
  if (!answer || typeof answer !== 'object') return NO_PIPELINES;
  const pipelines = (Array.isArray(answer.pipelines) ? answer.pipelines : [])
    .filter((p): p is LocalPipeline => Boolean(p) && typeof p.name === 'string' && p.name !== '')
    .map((p) => ({ name: p.name, transcription: typeof p.transcription === 'string' ? p.transcription : '', llm: typeof p.llm === 'string' ? p.llm : '' }));
  return {
    pipelines,
    recognizers: names(answer.recognizers),
    translators: names(answer.translators),
    ...(typeof answer.ok === 'boolean' ? { ok: answer.ok } : {}),
    ...(typeof answer.error === 'string' && answer.error ? { error: answer.error.slice(0, 400) } : {}),
  };
}

interface ElectronApi {
  invoke(channel: string, data?: unknown): Promise<unknown>;
  receive(channel: string, listener: (payload: never) => void): void;
  removeListener(channel: string, listener: (payload: never) => void): void;
}
const electron = (): ElectronApi | undefined => (typeof window === 'undefined' ? undefined : (window as unknown as { electron?: ElectronApi }).electron);

/** `get` asks again whether it is up; `start` and `stop` resolve once it is, or is not. Never rejects. */
export async function askLocalServer(action: 'get' | 'start' | 'stop'): Promise<LocalServerStatus> {
  const api = electron();
  if (!api) return NO_LOCAL_SERVER;
  try {
    return localServerStatus(await api.invoke(`local-server:${action}`));
  } catch {
    return NO_LOCAL_SERVER;
  }
}

/** Its pipelines as they are now. Never rejects. */
export async function askLocalPipelines(): Promise<LocalPipelines> {
  const api = electron();
  if (!api) return NO_PIPELINES;
  try {
    return localPipelines(await api.invoke('local-server:pipelines'));
  } catch {
    return NO_PIPELINES;
  }
}

/** Names another recognizer or text model in a pipeline. Never rejects: a failure is `ok: false` with why. */
export async function setLocalPipeline(name: string, change: { transcription?: string; llm?: string }): Promise<LocalPipelines> {
  const api = electron();
  if (!api) return { ...NO_PIPELINES, ok: false, error: 'Not available here.' };
  try {
    return localPipelines(await api.invoke('local-server:set-pipeline', { name, ...change }));
  } catch (cause) {
    return { ...NO_PIPELINES, ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

/** Every change of its state, as it happens. Returns the unsubscribe. */
export function onLocalServerStatus(listener: (status: LocalServerStatus) => void): () => void {
  const api = electron();
  if (!api) return () => {};
  const handler = (payload: never) => listener(localServerStatus(payload));
  api.receive('local-server:status', handler);
  return () => api.removeListener('local-server:status', handler);
}
