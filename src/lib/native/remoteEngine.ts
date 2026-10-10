/**
 * Fork: a recognition engine on another device, as the page uses it — a phone lent to this computer (`android/`),
 * running the engine this computer would download. The main process holds its live recognitions
 * (`electron/remote-engine.js`); this is how the page tells such an engine from any other API, and the recognitions
 * as the recognizer uses them (`NativeBridge`): the same shape as this computer's own engine, asked of the phone's
 * address.
 */
import { nativeStreamEvent, type NativeBridge } from './nativeEngine';

/** What a Kotomimi phone says of itself, on every answer: that what is here is the engine. */
export const NODE_HEADER = 'X-Kotomimi-Node';
const ENGINE = 'engine';
/** An address that has not said what it is in this long is taken for an API like any other. */
const ASK_TIMEOUT_MS = 4000;

interface ElectronApi {
  invoke(channel: string, data?: unknown): Promise<unknown>;
  receive(channel: string, listener: (payload: never) => void): void;
  removeListener(channel: string, listener: (payload: never) => void): void;
}
const electron = (): ElectronApi | undefined => (typeof window === 'undefined' ? undefined : (window as unknown as { electron?: ElectronApi }).electron);

/** `<base>/models`, for a base with or without a slash at its end. */
const modelsUrl = (baseUrl: string) => `${baseUrl.trim().replace(/\/+$/, '')}/models`;

/**
 * Whether what answers at `baseUrl` is a Kotomimi phone's engine: its model list says so in a header. Anything else —
 * no answer, an answer without the header, a page with no main process to hold a recognition — is not, and is read
 * as the API it was named as.
 */
export async function isEngineNode(baseUrl: string, fetchIt: typeof fetch, key?: string, timeoutMs: number = ASK_TIMEOUT_MS): Promise<boolean> {
  if (!electron() || !/^http:\/\//i.test(baseUrl.trim())) return false;
  const control = new AbortController();
  const waiting = setTimeout(() => control.abort(), timeoutMs);
  try {
    const answer = await fetchIt(modelsUrl(baseUrl), { signal: control.signal, headers: key ? { Authorization: `Bearer ${key}` } : {} });
    return answer.ok && answer.headers.get(NODE_HEADER) === ENGINE;
  } catch {
    return false;
  } finally {
    clearTimeout(waiting);
  }
}

/** The live recognitions of the engine at `base`, over IPC. */
export function remoteBridge(base: string): NativeBridge {
  return {
    async open(init) {
      const api = electron();
      if (!api) return null;
      try {
        const id = await api.invoke('remote-engine:stream-open', { ...init, base });
        return Number.isInteger(id) ? (id as number) : null;
      } catch {
        return null;
      }
    },
    write(id, pcm) {
      // A copy of exactly these samples: the message takes the buffer's bytes as they are.
      const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength).slice();
      void electron()?.invoke('remote-engine:stream-audio', { id, pcm: bytes }).catch(() => undefined);
    },
    end(id) { void electron()?.invoke('remote-engine:stream-end', { id }).catch(() => undefined); },
    abort(id) { void electron()?.invoke('remote-engine:stream-abort', { id }).catch(() => undefined); },
    listen(listener) {
      const api = electron();
      if (!api) return () => {};
      const mine = (payload: unknown) => { const event = nativeStreamEvent(payload); if (event) listener(event); };
      api.receive('remote-engine:stream', mine as (payload: never) => void);
      return () => api.removeListener('remote-engine:stream', mine as (payload: never) => void);
    },
  };
}
