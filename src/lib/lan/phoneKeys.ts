/**
 * Fork: the access keys of phones that ask for one (`android/`, 0.9.1 on). A phone lends its engines to anyone on its
 * Wi-Fi unless its owner sets a key on it; then every request must carry that key (`Authorization: Bearer`), and an
 * answer without it is 401, still naming the phone (`X-Kotomimi-Node: engine`), so a search lists it as a phone that
 * wants one. The key is typed here once, for that phone's address, and every request to the phone carries it: the
 * search (`findServers`), hearing (`apiAsr.ts`, `remoteEngine.ts`), the text stages (`textModel.ts`, `phoneText.ts`)
 * and the watch (`phoneWatch.ts`). Kept in the settings, by address (`host:port`), as the shared computer's key is.
 * No key is the default, on the phone and here.
 */
const SETTING = 'settings.lan.phoneKeys';
const keys = new Map<string, string>();
let loaded: Promise<void> | null = null;

/** An address as kept: `host:port`, however it was written (`discover.ts` `plainAddress`; repeated, not imported, as the search imports this). */
const plainAddress = (value: string): string => value.trim().replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '').toLowerCase();

/** A key as a header can carry it: printable ASCII with no space, at most 128 of it; anything else is no key. */
export const phoneKeyOf = (value: string): string => (/^[\x21-\x7e]{1,128}$/.test(value.trim()) ? value.trim() : '');

/** The key of the phone at an address or a base URL (`http://192.168.1.23:8792/v1`); blank where none was given. */
export const phoneKey = (addressOrBase: string): string => keys.get(plainAddress(addressOrBase)) ?? '';

/** Every key known now, by address: what the search is handed. */
export const phoneKeysNow = (): Record<string, string> => Object.fromEntries(keys);

/** Reads the keys from the settings, once. Never rejects: no settings is no keys. */
export function loadPhoneKeys(): Promise<void> {
  loaded ??= (async () => {
    try {
      const { ServiceFactory } = await import('../../services/ServiceFactory');
      const stored = await ServiceFactory.getSettingsService().getSetting<unknown>(SETTING, {});
      if (stored && typeof stored === 'object') {
        for (const [address, key] of Object.entries(stored as Record<string, unknown>)) {
          const kept = typeof key === 'string' ? phoneKeyOf(key) : '';
          if (kept) keys.set(plainAddress(address), kept);
        }
      }
    } catch {
      /* No settings service (a test, the web): no keys. */
    }
  })();
  return loaded;
}

/** Keeps a phone's key, or forgets it when blank. */
export async function setPhoneKey(address: string, key: string): Promise<void> {
  await loadPhoneKeys();
  const at = plainAddress(address);
  const kept = phoneKeyOf(key);
  if (kept) keys.set(at, kept);
  else keys.delete(at);
  try {
    const { persistSetting } = await import('../../services/persistSetting');
    await persistSetting(SETTING, phoneKeysNow());
  } catch {
    /* Kept for this run, where it cannot be stored. */
  }
}

/** For tests: forgets every key. */
export function clearPhoneKeys(): void {
  keys.clear();
  loaded = Promise.resolve();
}
