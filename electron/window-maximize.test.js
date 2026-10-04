// @vitest-environment node
// electron/window-maximize.test.js
//
// Fork: a maximized window that can be put back on a scaled display. The
// window here behaves as Electron's transparent window does on Windows:
// `maximize()` sets its bounds to the work area — a pixel off, as a
// fractional scale leaves them — and `isMaximized()` compares them exactly.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { keepMaximizeHonest, pageShift, covers, setExactly, sane } = require('./window-maximize.js');

const WORK = { x: 0, y: 0, width: 1897, height: 1028 };
const HOME = { x: 300, y: 120, width: 1200, height: 800 };

/**
 * A transparent window on a display scaled so that its maximized bounds miss the work area by `off` pixels, and
 * that comes out `off` wider and twice that taller than the bounds it is given.
 */
function scaledWindow(off = 1) {
  const win = {
    bounds: { ...HOME },
    restore: null,
    getBounds: () => ({ ...win.bounds }),
    setBounds: (b) => { win.bounds = { ...b, width: b.width + off, height: b.height + 2 * off }; },
    // Electron's own: exact comparison, and a restore that only acts on a window it thinks maximized.
    isMaximized: () => win.bounds.x === WORK.x && win.bounds.y === WORK.y && win.bounds.width === WORK.width && win.bounds.height === WORK.height,
    maximize: () => { win.restore = { ...win.bounds }; win.bounds = { x: WORK.x, y: WORK.y, width: WORK.width + off, height: WORK.height + 2 * off }; },
    unmaximize: () => { if (native(win)) win.bounds = { ...win.restore }; },
  };
  return win;
}
// The stand-in's own "is it maximized", by the exact comparison, whatever has been put over it since.
const native = (win) => win.bounds.x === WORK.x && win.bounds.y === WORK.y && win.bounds.width === WORK.width && win.bounds.height === WORK.height;

describe('a maximized window on a scaled display', () => {
  it('is stuck without help: Electron does not know it is maximized, and maximizes it again', () => {
    const win = scaledWindow();
    win.maximize();
    expect(win.isMaximized()).toBe(false);
    win.unmaximize();
    expect(win.getBounds().width).toBe(1898);
  });

  it('knows it is maximized, and goes back to where it was', () => {
    const win = scaledWindow();
    expect(keepMaximizeHonest(win, () => WORK, 'win32')).toBe(true);
    expect(win.isMaximized()).toBe(false);
    win.maximize();
    expect(win.isMaximized()).toBe(true);
    win.unmaximize();
    expect(win.getBounds()).toEqual(HOME);
    expect(win.isMaximized()).toBe(false);
    // And again, and again: it does not creep, though the display rounds every size it is given upwards.
    for (let i = 0; i < 5; i++) {
      win.maximize();
      win.unmaximize();
    }
    expect(win.getBounds()).toEqual(HOME);
  });

  it('is a window again once it has been moved or resized: the next maximize starts over', () => {
    const win = scaledWindow();
    keepMaximizeHonest(win, () => WORK, 'win32');
    win.maximize();
    win.setBounds({ x: 200, y: 100, width: 1000, height: 700 });
    const moved = win.getBounds();
    expect(win.isMaximized()).toBe(false);
    win.maximize();
    expect(win.isMaximized()).toBe(true);
    win.unmaximize();
    expect(win.getBounds()).toEqual(moved);
  });

  it('leaves a display that scales evenly as it was: Electron\'s own answer and its own restore', () => {
    const win = scaledWindow(0);
    keepMaximizeHonest(win, () => WORK, 'win32');
    win.maximize();
    expect(win.isMaximized()).toBe(true);
    win.unmaximize();
    expect(win.getBounds()).toEqual(HOME);
  });

  it('changes nothing off Windows, where the system maximizes the window itself', () => {
    const win = scaledWindow();
    const own = win.maximize;
    expect(keepMaximizeHonest(win, () => WORK, 'darwin')).toBe(false);
    expect(win.maximize).toBe(own);
  });

  it('gives a window the size asked for, where the display adds to it, and leaves a size limit alone', () => {
    const win = scaledWindow(2);
    setExactly(win, HOME);
    expect(win.getBounds()).toEqual(HOME);
    // A minimum size is no rounding: asked for less, the window stays at its limit, and is not pushed further.
    const limited = { bounds: { ...HOME }, sets: 0, getBounds: () => ({ ...limited.bounds }), setBounds: (b) => { limited.sets++; limited.bounds = { ...b, width: Math.max(b.width, 800), height: Math.max(b.height, 600) }; } };
    setExactly(limited, { x: 0, y: 0, width: 400, height: 300 });
    expect(limited.sets).toBe(1);
    expect(limited.getBounds()).toEqual({ x: 0, y: 0, width: 800, height: 600 });
  });

  it('takes a few pixels either way for covering the work area, and no more', () => {
    expect(covers({ x: -1, y: 0, width: 1898, height: 1030 }, WORK)).toBe(true);
    expect(covers({ x: 0, y: 0, width: 1894, height: 1025 }, WORK)).toBe(true);
    expect(covers({ x: 0, y: 0, width: 1800, height: 1028 }, WORK)).toBe(false);
    expect(covers({ x: 60, y: 0, width: 1897, height: 1028 }, WORK)).toBe(false);
  });
});

describe('a change of the window played by the page', () => {
  /** A page that is told of every change and answers when the test says so. */
  const page = (there = true, put = () => {}) => {
    const timers = [];
    const told = [];
    const shifts = pageShift((move) => { told.push(move); return there; }, {
      put,
      later: (fn) => { timers.push(fn); return timers.length; },
      cancel: (n) => { if (n) timers[n - 1] = () => {}; },
    });
    return { ...shifts, told, timeout: () => timers.forEach((fn) => fn()) };
  };

  it('waits for the page before the bounds change, both ways, and tells it from where to where', () => {
    const win = scaledWindow();
    const p = page();
    keepMaximizeHonest(win, () => WORK, 'win32', p.shift);
    win.maximize();
    expect(p.told).toEqual([{ kind: 'maximize', from: HOME, to: WORK }]);
    // Not yet moved, and already on its way: a second press meanwhile does not turn it round.
    expect(win.getBounds()).toEqual(HOME);
    expect(win.isMaximized()).toBe(true);
    win.unmaximize();
    win.maximize();
    expect(p.told).toHaveLength(1);
    p.ready();
    expect(win.getBounds().width).toBe(1898);
    expect(win.isMaximized()).toBe(true);

    win.unmaximize();
    expect(p.told[1]).toEqual({ kind: 'restore', from: win.getBounds(), to: HOME });
    expect(win.isMaximized()).toBe(false);
    expect(win.getBounds().width).toBe(1898);
    p.ready();
    expect(win.getBounds()).toEqual(HOME);
    // An answer nobody is waiting for changes nothing.
    p.ready();
    expect(win.getBounds()).toEqual(HOME);
  });

  it('does not wait for a page that never answers, nor for one that is not there', () => {
    const win = scaledWindow();
    const silent = page();
    keepMaximizeHonest(win, () => WORK, 'win32', silent.shift);
    win.maximize();
    silent.timeout();
    expect(win.getBounds().width).toBe(1898);
    // Its answer, late: the change is not made twice.
    win.setBounds(HOME);
    silent.ready();
    expect(win.getBounds().width).toBe(HOME.width + 1);

    const other = scaledWindow();
    keepMaximizeHonest(other, () => WORK, 'win32', page(false).shift);
    other.maximize();
    expect(other.getBounds().width).toBe(1898);
  });

  it('lets the page move the window while it plays, and not otherwise', () => {
    const win = scaledWindow(0);
    const p = page(true, (bounds) => win.setBounds(bounds));
    keepMaximizeHonest(win, () => WORK, 'win32', p.shift);
    const step = { x: 100, y: 40, width: 1897, height: 1028 };
    p.place(step);
    expect(win.getBounds()).toEqual(HOME);
    win.maximize();
    p.place(step);
    expect(win.getBounds()).toEqual(step);
    // Not bounds: left alone.
    p.place({ x: 0.5, y: 0, width: 100, height: 100 });
    p.place({ x: 0, y: 0, width: 0, height: 100 });
    p.place(null);
    expect(win.getBounds()).toEqual(step);
    p.ready();
    p.place(HOME);
    expect(win.getBounds()).toEqual(WORK);
    expect(sane(HOME)).toBe(true);
    expect(sane({ ...HOME, width: NaN })).toBe(false);
  });

  it('puts the window back where it was though the page has moved it meanwhile', () => {
    const win = scaledWindow();
    const p = page(true, (bounds) => win.setBounds(bounds));
    keepMaximizeHonest(win, () => WORK, 'win32', p.shift);
    win.maximize();
    p.ready();
    win.unmaximize();
    // The page has walked the window to where it goes, still at its full size: it no longer fills the screen.
    p.place({ x: HOME.x, y: HOME.y, width: 1897, height: 1028 });
    p.ready();
    expect(win.getBounds()).toEqual(HOME);
    expect(win.isMaximized()).toBe(false);
  });

  it('plays nothing where there is nothing to change', () => {
    const win = scaledWindow();
    const p = page();
    keepMaximizeHonest(win, () => WORK, 'win32', p.shift);
    win.unmaximize();
    expect(p.told).toEqual([]);
    expect(win.getBounds()).toEqual(HOME);
  });

  it('leaves a window that is gone by the time the page answers', () => {
    const win = scaledWindow();
    const p = page();
    keepMaximizeHonest(win, () => WORK, 'win32', p.shift);
    win.maximize();
    win.isDestroyed = () => true;
    p.ready();
    expect(win.getBounds()).toEqual(HOME);
  });
});
