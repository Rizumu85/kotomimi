import { afterEach, describe, expect, it, vi } from 'vitest';
import { ease, fillsScreen, playShift, ROUNDED_CLASS, watchWindowShape, whileLarge, type Bounds, type WindowShift } from './windowShape';

const size = (width: number, height: number) => {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
  Object.defineProperty(window, 'screen', { value: { availWidth: 1920, availHeight: 1032 }, configurable: true });
};
const rounded = () => document.documentElement.classList.contains(ROUNDED_CLASS);

afterEach(() => document.documentElement.classList.remove(ROUNDED_CLASS));

describe('the window\'s corners on Windows', () => {
  it('are square for a window that fills the screen, give or take a pixel of display scaling', () => {
    const screen = { availWidth: 1920, availHeight: 1032 };
    expect(fillsScreen({ innerWidth: 1200, innerHeight: 800, screen })).toBe(false);
    expect(fillsScreen({ innerWidth: 1920, innerHeight: 1032, screen })).toBe(true);
    expect(fillsScreen({ innerWidth: 1919, innerHeight: 1031, screen })).toBe(true);
    // Full screen is taller than the work area.
    expect(fillsScreen({ innerWidth: 1920, innerHeight: 1080, screen })).toBe(true);
    // Snapped to half the screen: still a window with corners.
    expect(fillsScreen({ innerWidth: 960, innerHeight: 1032, screen })).toBe(false);
  });

  it('follow the window as it is maximized and restored', () => {
    size(1200, 800);
    const stop = watchWindowShape(true);
    expect(rounded()).toBe(true);
    size(1920, 1032);
    window.dispatchEvent(new Event('resize'));
    expect(rounded()).toBe(false);
    size(1200, 800);
    window.dispatchEvent(new Event('resize'));
    expect(rounded()).toBe(true);
    stop();
    expect(rounded()).toBe(false);
  });

  it('are left to the system where it rounds the window itself, and in a browser', () => {
    size(1200, 800);
    watchWindowShape(false);
    expect(rounded()).toBe(false);
  });
});

describe('a maximize or restore played by the page', () => {
  const HOME = { x: 300, y: 120, width: 1200, height: 800 };
  const WORK = { x: 0, y: 0, width: 1920, height: 1040 };
  const held = () => document.getElementById('kt-window-shift')?.textContent ?? null;
  const root = () => {
    const el = document.createElement('div');
    el.className = 'App';
    document.body.append(el);
    return el;
  };
  /** The main process: every place asked for, and whether the change may be made. */
  const host = () => {
    const places: Bounds[] = [];
    const ready = vi.fn();
    return { places, ready, place: (bounds: Bounds) => { places.push(bounds); } };
  };
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
    document.getElementById('kt-window-shift')?.remove();
  });

  it('eases from one end to the other, and knows what only the larger window meets', () => {
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(0.5)).toBeGreaterThan(0.5);
    for (let t = 0.1; t <= 1; t += 0.1) expect(ease(t)).toBeGreaterThan(ease(t - 0.1));
    expect(whileLarge(HOME, WORK)).toBe('(min-width: 1560px)');
    expect(whileLarge(HOME, WORK, 1.25)).toBe('(min-width: 1950px)');
    // As wide as the screen already: told apart by its height.
    expect(whileLarge({ ...HOME, width: 1920 }, WORK)).toBe('(min-height: 920px)');
    expect(whileLarge({ ...WORK, width: 1900 }, WORK)).toBeNull();
  });

  it('gives the window its full size where it stands, then walks it to the corner as the app grows', async () => {
    vi.useFakeTimers();
    size(1200, 800);
    const el = root();
    const h = host();
    const played = playShift({ kind: 'maximize', from: HOME, to: WORK }, h, el);
    // Laid down before the bounds change, for the larger window alone: the app stays as large as it is, at the top left.
    expect(held()).toBe('@media (min-width: 1560px) { html .App { position: fixed; left: 0; top: 0; width: 1200px; height: 800px; will-change: transform; } }');
    // A change of size about a top left that stays.
    expect(h.places).toEqual([{ x: 300, y: 120, width: 1920, height: 1040 }]);
    size(1920, 1040);
    window.dispatchEvent(new Event('resize'));
    await vi.advanceTimersByTimeAsync(140);
    // Halfway: the window on its way to the corner, at the same size; the app between the two sizes.
    const mid = h.places[h.places.length - 1];
    expect(mid.x).toBeGreaterThan(0);
    expect(mid.x).toBeLessThan(300);
    expect([mid.width, mid.height]).toEqual([1920, 1040]);
    expect(parseFloat(el.style.width)).toBeGreaterThan(1200);
    expect(parseFloat(el.style.width)).toBeLessThan(1920);
    expect(h.ready).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(400);
    await played;
    expect(h.places[h.places.length - 1]).toEqual(WORK);
    // Every step a move alone.
    expect(h.places.every((b) => b.width === 1920 && b.height === 1040)).toBe(true);
    expect(h.ready).toHaveBeenCalledTimes(1);
    // Nothing left behind: the app fills its window by its own style again.
    expect(held()).toBeNull();
    expect(el.getAttribute('style') ?? '').toBe('');
  });

  it('shrinks the app as the window walks to where it goes, and only then lets it take its size', async () => {
    vi.useFakeTimers();
    size(1920, 1040);
    const el = root();
    const h = host();
    const played = playShift({ kind: 'restore', from: WORK, to: HOME }, h, el);
    expect(held()).toContain('width: 1920px; height: 1040px;');
    await vi.advanceTimersByTimeAsync(120);
    expect(parseFloat(el.style.width)).toBeLessThan(1920);
    expect(h.ready).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    // Arrived, still at its full size, the app held at the size it goes to.
    expect(h.places[h.places.length - 1]).toEqual({ x: 300, y: 120, width: 1920, height: 1040 });
    expect(held()).toContain('width: 1200px; height: 800px;');
    expect(el.getAttribute('style') ?? '').toBe('');
    expect(h.ready).toHaveBeenCalledTimes(1);
    // The window never reports its new size: the page lets go all the same.
    await vi.advanceTimersByTimeAsync(1000);
    await played;
    expect(held()).toBeNull();
  });

  it('plays nothing over the subtitle overlay, without an app, or between bounds that hardly differ, and says so at once', async () => {
    const el = root();
    const move: WindowShift = { kind: 'maximize', from: HOME, to: WORK };
    const h = host();
    await playShift({ kind: 'maximize', from: { ...WORK, width: 1910 }, to: WORK }, h, el);
    expect(h.ready).toHaveBeenCalledTimes(1);
    el.innerHTML = '<div class="subtitle-app"></div>';
    await playShift(move, h, el);
    expect(h.ready).toHaveBeenCalledTimes(2);
    await playShift(move, h, null);
    expect(h.ready).toHaveBeenCalledTimes(3);
    expect(h.places).toEqual([]);
    expect(held()).toBeNull();
  });

  it('keeps the corners as they are while it plays, and sets them by the window\'s size after', async () => {
    vi.useFakeTimers();
    size(1200, 800);
    const stop = watchWindowShape(true);
    const el = root();
    const played = playShift({ kind: 'maximize', from: HOME, to: WORK }, host(), el);
    size(1920, 1032);
    window.dispatchEvent(new Event('resize'));
    await vi.advanceTimersByTimeAsync(100);
    // Still growing: still a window with corners.
    expect(rounded()).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    await played;
    expect(rounded()).toBe(false);
    stop();
  });

  it('is told of the change by the main process, and answers it', async () => {
    size(1200, 800);
    const listeners: Record<string, (move: WindowShift) => void> = {};
    const invoke = vi.fn(async () => undefined);
    Object.defineProperty(window, 'electron', {
      value: { invoke, receive: (channel: string, fn: (move: WindowShift) => void) => { listeners[channel] = fn; }, removeListener: (channel: string) => { delete listeners[channel]; } },
      configurable: true,
    });
    const stop = watchWindowShape(true);
    // No app drawn: answered at once.
    listeners['window:shift']({ kind: 'maximize', from: HOME, to: WORK });
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledWith('window:shift-ready');
    stop();
    expect(listeners['window:shift']).toBeUndefined();
    Reflect.deleteProperty(window, 'electron');
  });
});
