/**
 * Fork: whether this computer looks to be where the app's own models are not reached. They are fetched in the page
 * from Hugging Face alone, and from mainland China Hugging Face does not connect (an exit in Beijing, 2026-10-12);
 * the native engines' models have other sources (electron/fetch-file.js) and are not meant here.
 *
 * A guess by the clock the computer keeps, as the main process orders its addresses by: it only decides whether a
 * line of what to expect is shown, never what can be tried.
 */
const CHINA_ZONES = new Set(['Asia/Shanghai', 'Asia/Chongqing', 'Asia/Harbin', 'Asia/Urumqi', 'PRC']);

export function farFromModels(zone: string | undefined = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; } })()): boolean {
  return zone !== undefined && CHINA_ZONES.has(zone);
}
