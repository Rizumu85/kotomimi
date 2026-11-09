/**
 * The durable registry of LAN devices the user has discovered.
 *
 * Discovery is a snapshot, while a stage selection is a durable choice. This
 * registry keeps the device's self-reported capabilities and form between
 * snapshots and marks missing devices unreachable.
 */
import { create } from 'zustand';
import { ServiceFactory } from '../../services/ServiceFactory';
import { persistSetting } from '../../services/persistSetting';
import { describeCause, reportWarning } from '../diagnostics/report';
import { plainAddress, foundServers, type FoundServer } from './discover';

const SETTING = 'settings.lan.knownDevices';
const MAX_DEVICES = 64;

export interface KnownDevice extends FoundServer {
  /** True when the last probe or stage request answered. */
  reachable: boolean;
  /** The last time this device answered, in epoch milliseconds. */
  lastSeenAt: number | null;
}

const addressOf = (value: string): string => plainAddress(value);
const sameAddress = (device: KnownDevice, address: string): boolean => addressOf(device.address) === addressOf(address);
const normalise = (device: FoundServer, now = Date.now()): KnownDevice => ({ ...device, address: addressOf(device.address), reachable: true, lastSeenAt: now });

/** Merge one discovery result into a registry, replacing stale capabilities. */
export function mergeKnownDevices(existing: readonly KnownDevice[], found: readonly FoundServer[], now = Date.now()): KnownDevice[] {
  const out = existing.map((device) => ({ ...device, reachable: false }));
  for (const candidate of found) {
    const at = out.findIndex((device) => addressOf(device.address) === addressOf(candidate.address));
    const next = normalise(candidate, now);
    if (at >= 0) out[at] = next;
    else out.push(next);
  }
  return out.slice(-MAX_DEVICES);
}

function updateReachability(devices: readonly KnownDevice[], address: string, reachable: boolean): KnownDevice[] {
  const wanted = addressOf(address);
  return devices.map((device) => sameAddress(device, wanted) ? { ...device, reachable } : device);
}

interface KnownDeviceState {
  devices: KnownDevice[];
  hydrated: boolean;
  hydrate(): Promise<void>;
  reconcile(found: readonly FoundServer[], now?: number): void;
  markReachable(address: string, reachable: boolean): void;
}

const write = (devices: readonly KnownDevice[]): void => { void persistSetting(SETTING, devices); };

export const useKnownDeviceStore = create<KnownDeviceState>((set, get) => ({
  devices: [],
  hydrated: false,
  hydrate: async () => {
    if (get().hydrated) return;
    try {
      const raw = await ServiceFactory.getSettingsService().getSetting<unknown>(SETTING, []);
      const records = Array.isArray(raw) ? raw.flatMap((item) => {
        const found = foundServers([item])[0];
        if (!found || !item || typeof item !== 'object') return [];
        const value = item as Record<string, unknown>;
        return [{ ...found, reachable: value.reachable === true, lastSeenAt: typeof value.lastSeenAt === 'number' ? value.lastSeenAt : null }];
      }) : [];
      set({ devices: records, hydrated: true });
    } catch (cause) {
      reportWarning('KnownDevices', `Could not load known LAN devices: ${describeCause(cause)}`, { cause, dedupeKey: 'known-devices.load' });
      set({ hydrated: true });
    }
  },
  reconcile: (found, now = Date.now()) => {
    const devices = mergeKnownDevices(get().devices, found, now);
    set({ devices });
    write(devices);
  },
  markReachable: (address, reachable) => {
    const before = get().devices;
    const devices = updateReachability(before, address, reachable);
    if (devices.every((device, index) => device.reachable === before[index]?.reachable)) return;
    set({ devices });
    write(devices);
  },
}));

export const knownDevicesNow = (): readonly KnownDevice[] => useKnownDeviceStore.getState().devices;
export const knownDevice = (address: string): KnownDevice | undefined => {
  const wanted = addressOf(address);
  return knownDevicesNow().find((device) => sameAddress(device, wanted));
};
export const markKnownDevice = (address: string, reachable: boolean): void => useKnownDeviceStore.getState().markReachable(address, reachable);

/** A stable label for notices and diagnostics; the UI can choose its localized form. */
export const knownDeviceLabel = (address: string): { address: string; name: string; kind: KnownDevice['kind']; tablet: boolean } => {
  const device = knownDevice(address);
  return { address: device?.address ?? addressOf(address), name: device?.name ?? '', kind: device?.kind ?? 'phone', tablet: device?.tablet === true };
};

export function resetKnownDevicesForTests(): void { useKnownDeviceStore.setState({ devices: [], hydrated: false }); }

