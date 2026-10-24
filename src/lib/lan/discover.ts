/**
 * Fork: the devices of the local network whose models this app can use — a
 * Kotomimi sharing its own, or a server that speaks OpenAI's wire (a
 * LocalAI). The main process does the looking (`electron/lan-discover.js`);
 * this is the page's side: the question, and its answer held to its shape.
 * Light on purpose — the wizard and the provider picker both draw it, and
 * neither should load the sharing host for it.
 */

export interface FoundServer {
  /** What goes in the address field: `host:port`. */
  address: string;
  /** Another Kotomimi, a phone that lends its engines (`android/`), or any other server that lists models. */
  kind: 'kotomimi' | 'phone' | 'server';
  /** The computer's name, where it gave one or the network knows one; else blank. */
  name: string;
  /** What the server is, where it could be told (`LocalAI`); else blank. */
  product: string;
  /** How many models it lists; 0 when it would not say without its key. */
  models: number;
  needsKey: boolean;
  /** It runs on this computer. */
  self: boolean;
  /** A phone's: the model it lends to recognize speech with. Absent where it lends text models alone. */
  model?: string;
  /** A phone's: the text models it lends (0.8.0 on), each for a translation or grammar feedback. Absent where none. */
  text?: readonly PhoneTextModel[];
}

/** A text model a phone lends: its id (the desktop's own native id), what it is for, its name, and whether it is loaded now. */
export interface PhoneTextModel {
  id: string;
  kind: 'translate' | 'coach';
  name: string;
  loaded: boolean;
  /**
   * False: the phone has not the memory to load it now, even with its other engines ended (`phoneRoom`), and refuses
   * it (503). Absent where the phone did not say enough to tell.
   */
  fits?: boolean;
}

/**
 * What a phone could give a text model now, in MB: the memory it can have (`memory_mb.available`), and what its
 * engines up hold of their own, which it ends to make room — the recognizer (`data`'s `holds_mb`, counted as up)
 * and the text models loaded. The phone's own reckoning (`Share.ensure`), from its list; null where it gave none
 * (before 0.8.0). Seen 2026-10-23 on a 4 GB phone: Index-Translate 2B keeps 1.5 GB, 1.4 GB could be had, every
 * sentence was refused, and nothing on the desktop said why.
 */
export function phoneRoom(list: unknown): number | null {
  const body = list as { data?: unknown; text?: unknown; memory_mb?: { available?: unknown } } | null;
  const available = body?.memory_mb?.available;
  if (typeof available !== 'number' || !Number.isFinite(available)) return null;
  const held = (m: unknown) => {
    const mb = (m as { holds_mb?: unknown } | null)?.holds_mb;
    return typeof mb === 'number' && Number.isFinite(mb) && mb > 0 ? mb : 0;
  };
  const hearing = Array.isArray(body?.data) ? body.data.reduce((sum: number, m) => sum + held(m), 0) : 0;
  const loaded = Array.isArray(body?.text) ? body.text.reduce((sum: number, m) => sum + ((m as { loaded?: unknown } | null)?.loaded === true ? held(m) : 0), 0) : 0;
  return available + hearing + loaded;
}

/**
 * A phone's `text`, held to its shape (the same reading as `electron/lan-discover.js` `textModels`); with `room`
 * (`phoneRoom`), whether each fits.
 */
export function phoneTextModels(value: unknown, room: number | null = null): PhoneTextModel[] {
  if (!Array.isArray(value)) return [];
  const out: PhoneTextModel[] = [];
  for (const m of value as Array<(Partial<PhoneTextModel> & { holds_mb?: unknown }) | null>) {
    if (!m || typeof m.id !== 'string' || !m.id || (m.kind !== 'translate' && m.kind !== 'coach')) continue;
    if (out.some((seen) => seen.id === m.id)) continue;
    const loaded = m.loaded === true;
    const holds = typeof m.holds_mb === 'number' && Number.isFinite(m.holds_mb) ? m.holds_mb : null;
    out.push({ id: m.id.slice(0, 80), kind: m.kind, name: typeof m.name === 'string' ? m.name.slice(0, 80) : '', loaded, ...(room !== null && holds !== null ? { fits: loaded || holds <= room } : {}) });
    if (out.length >= 16) break;
  }
  return out;
}

/** The main process's answer, held to its shape: what is no server is dropped. */
export function foundServers(value: unknown): FoundServer[] {
  if (!Array.isArray(value)) return [];
  const out: FoundServer[] = [];
  for (const item of value as Array<Partial<FoundServer> | null>) {
    if (!item || typeof item.address !== 'string' || !/^[\d.]+:\d{1,5}$/.test(item.address)) continue;
    const model = typeof item.model === 'string' && item.model ? item.model.slice(0, 80) : '';
    const text = item.kind === 'phone' ? phoneTextModels(item.text) : [];
    // A phone is one that lends something: a recognizer, or a text model.
    const phone = item.kind === 'phone' && (model !== '' || text.length > 0);
    out.push({
      address: item.address,
      kind: item.kind === 'kotomimi' ? 'kotomimi' : phone ? 'phone' : 'server',
      name: typeof item.name === 'string' ? item.name.slice(0, 80) : '',
      product: item.product === 'LocalAI' ? 'LocalAI' : '',
      models: Number.isInteger(item.models) && (item.models as number) > 0 ? (item.models as number) : 0,
      needsKey: item.needsKey === true,
      self: item.self === true,
      ...(phone && model ? { model } : {}),
      ...(phone && text.length ? { text } : {}),
    });
  }
  return out;
}

/** The text models of this kind a phone lends; none for anything else. */
export const phoneLends = (server: Pick<FoundServer, 'kind' | 'text'>, kind: PhoneTextModel['kind']): PhoneTextModel[] => (server.kind === 'phone' ? (server.text ?? []).filter((m) => m.kind === kind) : []);

/** A phone that lends a recognizer: the hearing stage can be given it. */
export const phoneHears = (server: Pick<FoundServer, 'kind' | 'model'>): boolean => server.kind === 'phone' && Boolean(server.model);

interface ElectronApi { invoke(channel: string, data?: unknown): Promise<unknown> }
const electron = (): ElectronApi | undefined => (typeof window === 'undefined' ? undefined : (window as unknown as { electron?: ElectronApi }).electron);

/** Whether there is a main process to look: the extension and the web have none. */
export const canFindServers = (): boolean => Boolean(electron());

/** Looks, a phone that asks for a key asked with the one given for it (`phoneKeys.ts`). Never rejects: no answer is no server. */
export async function findServers(): Promise<FoundServer[]> {
  const api = electron();
  if (!api) return [];
  try {
    const { loadPhoneKeys, phoneKeysNow } = await import('./phoneKeys');
    await loadPhoneKeys();
    return foundServers(await api.invoke('lan:discover', { keys: phoneKeysNow() }));
  } catch {
    return [];
  }
}

/** What a phone that was found is asked at: the address the recognizer is given (`asrApiBaseUrl`), and its text models. */
export const phoneBase = (server: Pick<FoundServer, 'address'>): string => `http://${server.address}/v1`;

/** An address as typed — with a scheme, a path, a trailing slash — as the `host:port` a found server is listed by. */
export function plainAddress(value: string): string {
  return value.trim().replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
}
