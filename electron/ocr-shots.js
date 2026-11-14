// electron/ocr-shots.js
//
// Fork: pictures of the VRChat window, collected for training the app's own chat-bubble detector. A developer's
// tool, off unless the environment names a folder (`KOTOMIMI_OCR_SHOTS`): no setting shows it, and a computer that
// does not name one never takes a picture. Windows only, as VRChat is.
//
// While a session runs, the helper (`vr-overlay/src/shot.cpp`) is started every `EVERY_MS`: it takes one picture
// and ends, so nothing of this stays in memory between pictures and the game is asked for one frame at a time. A
// view that has not changed is not written twice, and the folder stops growing at `LIMIT_BYTES`. The pictures show
// other people: they stay in that folder, and nothing here sends them anywhere.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const EVERY_MS = 20_000;
const LIMIT_BYTES = 5 * 1024 ** 3;
/** One picture may take this long; a helper that hangs is ended. */
const HELPER_MS = 10_000;

const two = (n) => String(n).padStart(2, '0');
/** `20261113-201532.jpg`, in local time: the order of the files is the order of the pictures. */
function shotName(at) {
  const d = new Date(at);
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}.jpg`;
}

function helperFile(app, env = process.env) {
  if (!app.isPackaged && env.KOTOMIMI_SHOT_HELPER) return env.KOTOMIMI_SHOT_HELPER;
  if (app.isPackaged) return path.join(process.resourcesPath, 'kotomimi-vr', 'kotomimi-shot.exe');
  return path.join(app.getAppPath(), 'vr-overlay', 'build', 'Release', 'kotomimi-shot.exe');
}

function createOcrShots({ dir, helper, run = execFile, files = fs, clock = { setInterval, clearInterval, now: Date.now }, everyMs = EVERY_MS, limitBytes = LIMIT_BYTES }) {
  let timer = null;
  let taking = false;
  /** The folder's size: read once, then kept by what is written. */
  let bytes = null;
  /** The last picture's signature: what the helper tells a view that has not changed by. */
  let last = '';

  const sizeOf = (file) => { try { return files.statSync(file).size; } catch { return 0; } };

  function take() {
    if (taking || bytes >= limitBytes) return;
    taking = true;
    const file = path.join(dir, shotName(clock.now()));
    run(helper, [file, ...(last ? ['--last', last] : [])], { timeout: HELPER_MS, windowsHide: true }, (error, stdout) => {
      taking = false;
      if (error) return;
      let said;
      try { said = JSON.parse(String(stdout).trim().split('\n').pop()); } catch { return; }
      if (typeof said?.signature === 'string') last = said.signature;
      if (said?.state === 'saved') bytes += sizeOf(file);
    });
  }

  return {
    /** A session began: a picture now and then, until `stop`. */
    start() {
      if (timer !== null) return;
      try {
        files.mkdirSync(dir, { recursive: true });
        if (bytes === null) bytes = files.readdirSync(dir).reduce((n, name) => n + sizeOf(path.join(dir, name)), 0);
      } catch {
        // A folder that cannot be made or read: no pictures, and the session is none the worse.
        return;
      }
      timer = clock.setInterval(take, everyMs);
    },
    stop() {
      if (timer === null) return;
      clock.clearInterval(timer);
      timer = null;
    },
  };
}

/** The collector for this run of the app, or null where none was asked for. */
function setupOcrShots({ app, env = process.env, platform = process.platform }) {
  const dir = env.KOTOMIMI_OCR_SHOTS;
  if (platform !== 'win32' || !dir || !path.isAbsolute(dir)) return null;
  return createOcrShots({ dir, helper: helperFile(app, env) });
}

module.exports = { setupOcrShots, createOcrShots, shotName, EVERY_MS };
