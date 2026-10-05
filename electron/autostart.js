// Fork: starting with the computer, in the background.
//
// Off unless the person turns it on. When on, signing in to Windows starts
// the app with no window: nothing appears, and the first time the app is
// opened — a second launch shows the window the first one made — what takes
// long after a boot is already done: this computer's recognition engine has
// loaded its model.
//
// A computer that has just started is busy, and every program that starts
// with it wants the disk and the graphics card at once. So a start in the
// background does its heavy work late: the engine waits for a quiet minute
// (`quiet`) before it loads — unless the person opens the window first, which
// ends the wait at once.
//
// Windows only, and only installed: the entry names the launcher the
// installer keeps one folder above the app's own, which starts whichever
// version is newest (Electron's own advice for apps Squirrel updates). macOS
// asks for a notarized app before it honours a login item.
const path = require('path');

/** What a start in the background is told apart by. */
const HIDDEN_FLAG = '--hidden';
/** How long a start in the background leaves the computer to its own starting. */
const QUIET_MS = 60_000;

function createAutostart({ app, platform = process.platform, execPath = process.execPath, argv = process.argv, exists, quietMs = QUIET_MS, setTimer = setTimeout }) {
  const launcher = path.win32.resolve(path.win32.dirname(execPath), '..', path.win32.basename(execPath));
  const supported = platform === 'win32' && app.isPackaged === true && exists(launcher);
  const item = { path: launcher, args: [HIDDEN_FLAG] };
  const startedHidden = supported && argv.includes(HIDDEN_FLAG);

  let wake = () => {};
  /** Resolves when heavy work may begin: at once for an ordinary start. */
  const quiet = startedHidden
    ? new Promise((resolve) => {
      wake = resolve;
      const timer = setTimer(resolve, quietMs);
      timer?.unref?.();
    })
    : Promise.resolve();

  const get = () => {
    if (!supported) return { supported: false, enabled: false };
    try {
      return { supported: true, enabled: app.getLoginItemSettings(item).openAtLogin === true };
    } catch {
      return { supported: true, enabled: false };
    }
  };

  return {
    supported,
    /** This start was the computer's, with no window to show. */
    startedHidden,
    quiet,
    /** The person is here: nothing waits any longer. */
    wake: () => wake(),
    get,
    set(enabled) {
      if (supported) {
        try {
          app.setLoginItemSettings({ openAtLogin: enabled === true, ...item });
        } catch { /* the answer below says what came of it */ }
      }
      return get();
    },
  };
}

module.exports = { createAutostart, HIDDEN_FLAG, QUIET_MS };
