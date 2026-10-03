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
  /** Another Kotomimi, or any other server that lists models. */
  kind: 'kotomimi' | 'server';
  /** The computer's name, where it gave one or the network knows one; else blank. */
  name: string;
  /** What the server is, where it could be told (`LocalAI`); else blank. */
  product: string;
  /** How many models it lists; 0 when it would not say without its key. */
  models: number;
  needsKey: boolean;
  /** It runs on this computer. */
  self: boolean;
}

/** The main process's answer, held to its shape: what is no server is dropped. */
export function foundServers(value: unknown): FoundServer[] {
  if (!Array.isArray(value)) return [];
  const out: FoundServer[] = [];
  for (const item of value as Array<Partial<FoundServer> | null>) {
    if (!item || typeof item.address !== 'string' || !/^[\d.]+:\d{1,5}$/.test(item.address)) continue;
    out.push({
      address: item.address,
      kind: item.kind === 'kotomimi' ? 'kotomimi' : 'server',
      name: typeof item.name === 'string' ? item.name.slice(0, 80) : '',
      product: item.product === 'LocalAI' ? 'LocalAI' : '',
      models: Number.isInteger(item.models) && (item.models as number) > 0 ? (item.models as number) : 0,
      needsKey: item.needsKey === true,
      self: item.self === true,
    });
  }
  return out;
}

interface ElectronApi { invoke(channel: string, data?: unknown): Promise<unknown> }
const electron = (): ElectronApi | undefined => (typeof window === 'undefined' ? undefined : (window as unknown as { electron?: ElectronApi }).electron);

/** Whether there is a main process to look: the extension and the web have none. */
export const canFindServers = (): boolean => Boolean(electron());

/** Looks. Never rejects: no answer is no server. */
export async function findServers(): Promise<FoundServer[]> {
  const api = electron();
  if (!api) return [];
  try {
    return foundServers(await api.invoke('lan:discover'));
  } catch {
    return [];
  }
}

/** An address as typed — with a scheme, a path, a trailing slash — as the `host:port` a found server is listed by. */
export function plainAddress(value: string): string {
  return value.trim().replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
}
