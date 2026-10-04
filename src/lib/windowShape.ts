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
 *
 * The same window gets no animation from the system when it is maximized or
 * restored: its bounds jump. The page plays the change instead (`playShift`),
 * told of it by the main process (electron/window-maximize.js) before
 * anything moves: the app is seen changing size, from where it was to where
 * it goes, with no fade.
 *
 * How, follows from what the screen shows when the window's bounds change:
 * the frame already drawn, at the window's new top left, until the page has
 * drawn the next (measured: a frame or two). So a change of bounds is only
 * clean where that is the right picture: a move alone, or a change of size
 * about a top left that stays. The window being transparent, the app can be
 * drawn smaller than its window, and the two are taken apart:
 *
 *  - the window is as large as the larger of the two bounds all through, the
 *    app held at its top left;
 *  - the app's place on the screen is the window's own, moved step by step;
 *  - the app's size is the page's, changed step by step in the same frames.
 *
 * Maximizing, the window first takes its full size where it stands, then
 * walks to the screen's corner while the app grows to fill it. Restoring,
 * the app shrinks while the window walks to where it goes, and only then
 * takes its size. The app is held by a style rule under a media query that
 * only the larger window meets, laid down beforehand: it takes hold in the
 * very frame the window is laid out large, and lets go in the frame it is
 * small again (a `resize` listener is a frame late for both).
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

/** Screen bounds, as the main process hands them over. */
export interface Bounds { x: number; y: number; width: number; height: number }
/** A maximize or a restore about to happen: the window's bounds now, and after. */
export interface WindowShift { kind: 'maximize' | 'restore'; from: Bounds; to: Bounds }
/** The main process, as a change is played: where the window is to be meanwhile, and that the change itself may be made. */
export interface ShiftHost { place: (bounds: Bounds) => void; ready: () => void }

const GROW_MS = 280;
const SHRINK_MS = 240;
/** How long a change of the bounds is waited for before the page carries on without it. */
const RESIZE_WAIT_MS = 400;
/** Bounds that differ by less than this on both sides are not worth playing. */
const WORTH_PX = 40;
const STYLE_ID = 'kt-window-shift';

/** `cubic-bezier(0.3, 0, 0.2, 1)`: a soft start and a long settle, as a window on macOS zooms. */
export function ease(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const curve = (a: number, b: number, u: number) => ((1 - 3 * b + 3 * a) * u + (3 * b - 6 * a)) * u * u + 3 * a * u;
  let low = 0;
  let high = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (low + high) / 2;
    if (curve(0.3, 0.2, mid) < t) low = mid; else high = mid;
  }
  return curve(0, 1, (low + high) / 2);
}

/**
 * The media condition the window meets at the size of `large` and not at that of `small`: halfway between the two,
 * on the side they differ most, `scale` page pixels to one of the screen's. Null where they hardly differ.
 */
export function whileLarge(small: Bounds, large: Bounds, scale = 1): string | null {
  const wider = large.width - small.width;
  const taller = large.height - small.height;
  if (Math.max(wider, taller) < WORTH_PX) return null;
  return wider >= taller
    ? `(min-width: ${Math.round((small.width + wider / 2) * scale)}px)`
    : `(min-height: ${Math.round((small.height + taller / 2) * scale)}px)`;
}

const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
/** The window has changed size, or is not going to. */
const resized = () => new Promise<void>((resolve) => {
  const done = () => { window.removeEventListener('resize', done); clearTimeout(timer); resolve(); };
  const timer = setTimeout(done, RESIZE_WAIT_MS);
  window.addEventListener('resize', done);
});

/** A change is being played: the corners stay as they are until it is over. */
let shifting = false;
/** The corners follow the window's size (`watchWindowShape`). */
let watching = false;
const applyShape = () => {
  if (watching && !shifting) document.documentElement.classList.toggle(ROUNDED_CLASS, !fillsScreen());
};

/**
 * Plays a maximize or a restore on the app's root. `host.ready` is called
 * exactly once, when the change itself may be made: at once where nothing is
 * played — no root, the subtitle overlay, reduced motion, or bounds that
 * hardly differ.
 */
export async function playShift(move: WindowShift, host: ShiftHost, root: HTMLElement | null = document.querySelector<HTMLElement>('.App')): Promise<void> {
  const [small, large] = move.kind === 'maximize' ? [move.from, move.to] : [move.to, move.from];
  // The page's pixels to one of the screen's: the page may be zoomed.
  const scale = window.innerWidth / move.from.width || 1;
  const gate = whileLarge(small, large, scale);
  const still = !root || !gate || root.querySelector('.subtitle-app') || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (still) {
    host.ready();
    return;
  }
  const style = document.createElement('style');
  style.id = STYLE_ID;
  document.getElementById(STYLE_ID)?.remove();
  // The app at the window's top left, at the size of these bounds, while the window is the larger one. `will-change`
  // makes it the frame of its own fixed parts (the hairline round it), which would otherwise go round the window.
  const hold = (size: Bounds) => {
    style.textContent = `@media ${gate} { html .App { position: fixed; left: 0; top: 0; width: ${size.width * scale}px; height: ${size.height * scale}px; will-change: transform; } }`;
  };
  let told = false;
  const tell = () => { if (!told) { told = true; host.ready(); } };
  const between = (a: number, b: number, p: number) => a + (b - a) * p;
  /** The app from the size and place of one bounds to those of the other: its size here, its place by the window. */
  const run = async (from: Bounds, to: Bounds, duration: number) => {
    const start = await frame();
    for (let now = start; ; now = await frame()) {
      const t = Math.min(1, (now - start) / duration);
      const p = ease(t);
      root.style.width = `${between(from.width, to.width, p) * scale}px`;
      root.style.height = `${between(from.height, to.height, p) * scale}px`;
      host.place({ x: Math.round(between(from.x, to.x, p)), y: Math.round(between(from.y, to.y, p)), width: large.width, height: large.height });
      if (t >= 1) return;
    }
  };
  shifting = true;
  try {
    if (move.kind === 'maximize') {
      hold(small);
      document.head.append(style);
      host.place({ x: small.x, y: small.y, width: large.width, height: large.height });
      await resized();
      if (window.matchMedia?.(gate).matches ?? true) await run(small, large, GROW_MS);
    } else {
      document.documentElement.classList.add(ROUNDED_CLASS);
      hold(large);
      document.head.append(style);
      await run(large, small, SHRINK_MS);
      hold(small);
    }
  } finally {
    root.style.width = '';
    root.style.height = '';
    if (move.kind === 'maximize') style.remove();
    tell();
    if (move.kind === 'restore') {
      // The window takes its size now: the rule lets go by itself in the frame it does.
      await resized();
      await frame();
      style.remove();
    }
    shifting = false;
    applyShape();
  }
}

/**
 * Keeps the root's class in step with the window's size, and plays the window's maximize and restore, where the
 * page rounds the window at all. Returns the stop.
 */
export function watchWindowShape(rounds: boolean = isElectron() && isWindows()): () => void {
  if (!rounds) return () => {};
  watching = true;
  applyShape();
  window.addEventListener('resize', applyShape);
  const bridge = (window as Partial<Window>).electron;
  const host: ShiftHost = {
    place: (bounds) => { void bridge?.invoke('window:shift-place', bounds); },
    ready: () => { void bridge?.invoke('window:shift-ready'); },
  };
  const onShift = (move: WindowShift) => { void playShift(move, host); };
  bridge?.receive('window:shift', onShift);
  return () => {
    watching = false;
    window.removeEventListener('resize', applyShape);
    bridge?.removeListener('window:shift', onShift);
    document.documentElement.classList.remove(ROUNDED_CLASS);
  };
}
