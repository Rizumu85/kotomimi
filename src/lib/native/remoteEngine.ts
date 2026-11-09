/**
 * Fork: a recognition engine on another device, as the page uses it — a phone lent to this computer (`android/`),
 * running the engine this computer would download. The main process holds its live recognitions
 * (`electron/remote-engine.js`); this is how the page tells such an engine from any other API, and the recognitions
 * as the recognizer uses them (`NativeBridge`): the same shape as this computer's own engine, asked of the phone's
 * address.
 */
import { nativeStreamEvent, type NativeBridge } from './nativeEngine';
import { phoneKey } from '../lan/phoneKeys';
import { markKnownDevice, useKnownDeviceStore } from '../lan/knownDevices';

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
  return (await engineNode(baseUrl, fetchIt, key, timeoutMs)) !== null;
}

/**
 * The same question, with what the phone lends now: the model it has loaded, which its owner may have changed since
 * the address was written down — blank where its list could not be read — and every recognizer it can be asked for
 * by name (`hear`, the iPad app; empty for a phone that lends its one). Null: no phone's engine is there.
 * `live`: the recognizer that hears while it is spoken (`streams`, the iPad's own), and the languages it has.
 */
export async function engineNode(baseUrl: string, fetchIt: typeof fetch, key?: string, timeoutMs: number = ASK_TIMEOUT_MS): Promise<EngineNode | null> {
  if (!electron() || !/^http:\/\//i.test(baseUrl.trim())) return null;
  await useKnownDeviceStore.getState().hydrate();
  const address = new URL(baseUrl).host;
  const control = new AbortController();
  const waiting = setTimeout(() => control.abort(), timeoutMs);
  try {
    const answer = await fetchIt(modelsUrl(baseUrl), { signal: control.signal, headers: key ? { Authorization: `Bearer ${key}` } : {} });
    markKnownDevice(address, true);
    if (!answer.ok || answer.headers.get(NODE_HEADER) !== ENGINE) {
      return null;
    }
    const list = (await answer.json().catch(() => null)) as { data?: Array<{ id?: unknown }>; hear?: Array<{ id?: unknown; streams?: unknown; languages?: unknown }> } | null;
    const first = list?.data?.[0]?.id;
    const hears = Array.isArray(list?.hear) ? list.hear.flatMap((m) => (typeof m?.id === 'string' && m.id ? [m.id.slice(0, 80)] : [])) : [];
    const streaming = Array.isArray(list?.hear) ? list.hear.find((m) => typeof m?.id === 'string' && m.id && m.streams === true) : undefined;
    const live = streaming ? {
      model: (streaming.id as string).slice(0, 80),
      languages: Array.isArray(streaming.languages) ? streaming.languages.flatMap((l) => (typeof l === 'string' && /^[a-z]{2,3}$/.test(l) ? [l] : [])).slice(0, 40) : [],
    } : undefined;
    return { model: typeof first === 'string' ? first.slice(0, 80) : '', hears, ...(live ? { live } : {}) };
  } catch {
    markKnownDevice(address, false);
    return null;
  } finally {
    clearTimeout(waiting);
  }
}

export interface EngineNode {
  model: string;
  hears: string[];
  live?: { model: string; languages: string[] };
}

/**
 * The live recognitions of the engine at `base`, over IPC. `streamed`: the device hears while it is spoken (`live`
 * above): the main process sends it the sound as it comes (`liveStretch`), not the stretch read again as it grows.
 */
export function remoteBridge(base: string, { streamed = false }: { streamed?: boolean } = {}): NativeBridge {
  return {
    async open(init) {
      const api = electron();
      if (!api) return null;
      try {
        await useKnownDeviceStore.getState().hydrate();
        // The phone's key, where its owner set one (`phoneKeys.ts`): every reading of the stretch carries it.
        const key = phoneKey(base);
        const id = await api.invoke('remote-engine:stream-open', { ...init, base, ...(key ? { key } : {}), ...(streamed ? { streamed: true } : {}) });
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
