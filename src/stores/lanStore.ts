/**
 * Fork: sharing this computer's models on the local network — whether it is
 * on, where it listens, and what the settings show of it. The host itself
 * (`src/lib/lan`) is loaded only when sharing is first turned on: it pulls
 * in the engines, which a user who never shares need not load. The settings
 * service is imported when first used, as `annotationStore` does and for the
 * same reason.
 */
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { FIREWALL_UNKNOWN, LAN_DEFAULT_PORT, type LanFirewall } from '../lib/lan/protocol';
import type { LanHost } from '../lib/lan/host';

export type LanStatus =
  | { state: 'off' }
  | { state: 'starting' }
  | { state: 'on'; port: number; addresses: string[] }
  /** `code` is the system's own (`EADDRINUSE`), where it gave one. */
  | { state: 'error'; code: string | null; message: string };

interface LanState {
  enabled: boolean;
  port: number;
  /** Blank: no key is asked of a caller. */
  key: string;
  status: LanStatus;
  /** Sockets open now: devices being transcribed for. */
  clients: number;
  /** Whether the system's firewall lets other devices in, read each time sharing starts. */
  firewall: LanFirewall;
  /** The system is asking the user, or being read. */
  firewallBusy: boolean;
  /** The user asked for the port to be let through, and it is still shut. */
  firewallDeclined: boolean;
  /** Lets the port through the system's firewall; the system asks the user first. */
  allowFirewall(): Promise<void>;
  setEnabled(on: boolean): Promise<void>;
  /** A new port or key restarts the sharing when it is on. */
  setPort(port: number): Promise<void>;
  setKey(key: string): Promise<void>;
  /** Called once at app boot (`src/routes/Home.tsx`): sharing left on is started again. */
  hydrate(): Promise<void>;
}

type Field = 'enabled' | 'port' | 'key';
const KEY = (field: Field) => `settings.common.lan.${field}`;
export const validLanPort = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1024 && value <= 65535;

const NO_FIREWALL = { firewall: FIREWALL_UNKNOWN, firewallBusy: false, firewallDeclined: false };

export const useLanStore = create<LanState>()(
  subscribeWithSelector((set, get) => {
    let host: LanHost | null = null;
    /** One change at a time: a start still in flight finishes before the next begins. */
    let chain: Promise<void> = Promise.resolve();
    const persist = async (field: Field, value: boolean | number | string) => {
      const { persistSetting } = await import('../services/persistSetting');
      await persistSetting(KEY(field), value);
    };
    /** Reads the firewall for the port now shared. An answer for a sharing since stopped or restarted is dropped. */
    const readFirewall = async (action: 'status' | 'allow') => {
      const asked = get().status;
      if (asked.state !== 'on') return;
      set({ firewallBusy: true });
      const { askLanFirewall } = await import('../lib/lan/appHost');
      const firewall = await askLanFirewall(action);
      if (get().status !== asked) return;
      set({ firewall, firewallBusy: false, firewallDeclined: action === 'allow' && firewall.state === 'blocked' });
    };
    const apply = (): Promise<void> => {
      chain = chain.then(async () => {
        const { enabled, port, key } = get();
        try {
          if (!enabled) {
            if (host) await host.stop();
            set({ status: { state: 'off' }, clients: 0, ...NO_FIREWALL });
            return;
          }
          set({ status: { state: 'starting' }, ...NO_FIREWALL });
          const [{ createAppLanHost }, { lanModelsLoaded }] = await Promise.all([import('../lib/lan/appHost'), import('../lib/lan/appModels')]);
          host ??= createAppLanHost((clients) => set({ clients }));
          if (!host) {
            set({ status: { state: 'error', code: 'unsupported', message: 'Sharing needs the desktop app.' } });
            return;
          }
          await lanModelsLoaded();
          const started = await host.start({ port, key });
          set({ status: started.ok ? { state: 'on', port: started.port, addresses: started.addresses } : { state: 'error', code: started.code, message: started.message } });
          // Not awaited: sharing is on whatever the firewall says, and the answer takes a moment.
          if (started.ok) void readFirewall('status');
        } catch (cause) {
          set({ status: { state: 'error', code: null, message: cause instanceof Error ? cause.message : String(cause) } });
        }
      });
      return chain;
    };
    return {
      enabled: false,
      port: LAN_DEFAULT_PORT,
      key: '',
      status: { state: 'off' },
      clients: 0,
      ...NO_FIREWALL,
      allowFirewall: () => readFirewall('allow'),
      setEnabled: async (on) => {
        if (get().enabled === on) return;
        set({ enabled: on });
        void persist('enabled', on);
        await apply();
      },
      setPort: async (port) => {
        if (!validLanPort(port) || port === get().port) return;
        set({ port });
        void persist('port', port);
        if (get().enabled) await apply();
      },
      setKey: async (key) => {
        const trimmed = key.trim();
        if (trimmed === get().key) return;
        set({ key: trimmed });
        void persist('key', trimmed);
        if (get().enabled) await apply();
      },
      hydrate: async () => {
        const { ServiceFactory } = await import('../services/ServiceFactory');
        const service = ServiceFactory.getSettingsService();
        const [enabled, port, key] = await Promise.all([
          service.getSetting<unknown>(KEY('enabled'), false),
          service.getSetting<unknown>(KEY('port'), LAN_DEFAULT_PORT),
          service.getSetting<unknown>(KEY('key'), ''),
        ]);
        // A key of digits comes back from storage as a number: it is still the key that was typed.
        set({ enabled: enabled === true, port: validLanPort(port) ? port : LAN_DEFAULT_PORT, key: typeof key === 'string' || typeof key === 'number' ? String(key) : '' });
        if (get().enabled) await apply();
      },
    };
  }),
);
