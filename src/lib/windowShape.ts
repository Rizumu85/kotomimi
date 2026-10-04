/**
 * Fork: the window's corners on Windows. Windows 11 rounds a window that has
 * a frame; this one has none, and is transparent — the same window becomes
 * the subtitle overlay — so the system leaves it square, where macOS rounds
 * it anyway. The page rounds itself instead: the app's root is clipped to
 * the radius Windows uses (`App.scss`), with a hairline where the system
 * would draw the window's border.
 *
 * A window that fills the screen — maximized, or full screen — has square
 * corners on Windows too, so the rounding follows the window's size. The
 * subtitle overlay draws its own shape, and is left alone (the style looks
 * for it).
 */
import { isElectron, isWindows } from '../utils/environment';

/** On the page's root while the window's corners are rounded. */
export const ROUNDED_CLASS = 'kt-rounded-window';

/** What a size may fall short of the screen's and still be "all of it": a pixel lost to a fractional display scale. */
const SLACK = 2;

/** The window covers the whole work area, or the whole screen. */
export function fillsScreen(w: Pick<Window, 'innerWidth' | 'innerHeight'> & { screen: Pick<Screen, 'availWidth' | 'availHeight'> } = window): boolean {
  return w.innerWidth >= w.screen.availWidth - SLACK && w.innerHeight >= w.screen.availHeight - SLACK;
}

/** Keeps the root's class in step with the window's size, where the page rounds the window at all. Returns the stop. */
export function watchWindowShape(rounds: boolean = isElectron() && isWindows()): () => void {
  if (!rounds) return () => {};
  const apply = () => document.documentElement.classList.toggle(ROUNDED_CLASS, !fillsScreen());
  apply();
  window.addEventListener('resize', apply);
  return () => {
    window.removeEventListener('resize', apply);
    document.documentElement.classList.remove(ROUNDED_CLASS);
  };
}
