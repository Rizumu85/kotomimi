// @vitest-environment node
// Fork: starting with the computer, in the background.
import { describe, expect, it, vi } from 'vitest';

const { createAutostart, HIDDEN_FLAG, QUIET_MS } = require('./autostart.js');

const EXE = 'C:\\Users\\me\\AppData\\Local\\Kotomimi\\app-0.42.231\\Kotomimi.exe';
const LAUNCHER = 'C:\\Users\\me\\AppData\\Local\\Kotomimi\\Kotomimi.exe';

/** An app that keeps its login item as Windows would. */
function fakeApp(packaged = true) {
  let item = null;
  return {
    isPackaged: packaged,
    setLoginItemSettings: vi.fn((settings) => { item = settings.openAtLogin ? settings : null; }),
    getLoginItemSettings: vi.fn((asked) => ({ openAtLogin: Boolean(item) && item.path === asked.path && JSON.stringify(item.args) === JSON.stringify(asked.args) })),
  };
}

const made = (patch = {}) => {
  const app = patch.app ?? fakeApp();
  const timers = [];
  const autostart = createAutostart({ app, platform: 'win32', execPath: EXE, argv: [EXE], exists: (file) => file === LAUNCHER, setTimer: (fn, ms) => { timers.push({ fn, ms }); return {}; }, ...patch });
  return { app, autostart, timers };
};

describe('starting with the computer', () => {
  it('is off until asked for, and names the launcher above the app\'s own folder, with the mark of a start in the background', () => {
    const { app, autostart } = made();
    expect(autostart.get()).toEqual({ supported: true, enabled: false });
    expect(autostart.set(true)).toEqual({ supported: true, enabled: true });
    expect(app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true, path: LAUNCHER, args: [HIDDEN_FLAG] });
    expect(autostart.set(false)).toEqual({ supported: true, enabled: false });
  });

  it('is not offered off Windows, from a checkout, or where the installer left no launcher', () => {
    for (const patch of [{ platform: 'darwin' }, { app: fakeApp(false) }, { exists: () => false }]) {
      const { app, autostart } = made(patch);
      expect(autostart.get()).toEqual({ supported: false, enabled: false });
      expect(autostart.set(true)).toEqual({ supported: false, enabled: false });
      expect(app.setLoginItemSettings).not.toHaveBeenCalled();
    }
  });

  it('answers off when Windows cannot be asked', () => {
    const app = fakeApp();
    app.getLoginItemSettings = () => { throw new Error('registry'); };
    expect(made({ app }).autostart.get()).toEqual({ supported: true, enabled: false });
  });
});

describe('a start in the background', () => {
  it('is told by its mark, and leaves the computer a quiet minute before heavy work', async () => {
    const { autostart, timers } = made({ argv: [EXE, HIDDEN_FLAG] });
    expect(autostart.startedHidden).toBe(true);
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(QUIET_MS);
    let begun = false;
    void autostart.quiet.then(() => { begun = true; });
    await Promise.resolve();
    expect(begun).toBe(false);
    timers[0].fn();
    await autostart.quiet;
    expect(begun).toBe(true);
  });

  it('ends the wait at once when the person opens the window', async () => {
    const { autostart } = made({ argv: [EXE, HIDDEN_FLAG] });
    let begun = false;
    void autostart.quiet.then(() => { begun = true; });
    autostart.wake();
    await autostart.quiet;
    expect(begun).toBe(true);
  });

  it('is no such thing for an ordinary start: nothing waits', async () => {
    const { autostart, timers } = made();
    expect(autostart.startedHidden).toBe(false);
    expect(timers).toHaveLength(0);
    await autostart.quiet;
    // The mark means nothing where the feature is not offered.
    expect(made({ argv: [EXE, HIDDEN_FLAG], platform: 'darwin' }).autostart.startedHidden).toBe(false);
  });
});
