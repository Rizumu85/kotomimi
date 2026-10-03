/**
 * Fork: for a live test, which runs in Node so its sockets and requests are
 * real. The provider's views reach modules that read `window` and
 * `localStorage` as they load; in Node they find these stand-ins. Imported
 * first, by the live tests only.
 */
const scope = globalThis as unknown as Record<string, unknown>;
scope.window ??= globalThis;
if (!scope.localStorage) {
  const kept = new Map<string, string>();
  scope.localStorage = {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => { kept.set(key, String(value)); },
    removeItem: (key: string) => { kept.delete(key); },
    clear: () => kept.clear(),
    key: (index: number) => [...kept.keys()][index] ?? null,
    get length() { return kept.size; },
  };
}
export {};
