/** The DOM host belongs to a separate native window; its React tree belongs to the main session. */
let host: HTMLElement | null = null;
const listeners = new Set<() => void>();
export const getSubtitleWindowHost = () => host;
export const subscribeSubtitleWindowHost = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export function setSubtitleWindowHost(next: HTMLElement | null) {
  host = next;
  listeners.forEach((listener) => listener());
}
