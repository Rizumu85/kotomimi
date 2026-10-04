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
const { keepMaximizeHonest, covers, setExactly } = require('./window-maximize.js');

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
