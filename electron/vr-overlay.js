// electron/vr-overlay.js
//
// Fork: the SteamVR overlay's main-process side (vr-overlay/src/main.cpp). Windows only.
//
// While the main window asks for it (`vr:set`), the helper `kotomimi-vr.exe`
// runs and waits for SteamVR. Once SteamVR is up, two offscreen windows draw
// `vr.html#strip` and `vr.html#wrist`; each new picture goes to the helper's
// stdin, which shows it in the headset. The helper's poke on the wrist panel
// comes back as mouse events into that page; its frame rate and memory lines
// go to the wrist page. What the pages show (`vr:state`) comes from the main
// window; what the wrist asks (`vr:command`) goes back to it.
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

/** The pictures are drawn at twice the pages' CSS size: crisp at reading distance in a headset. */
const ZOOM = 2;
const SURFACES = ['strip', 'wrist'];
const INDEX = { strip: 0, wrist: 1 };
/** Widths before a page has measured itself (src/vr/vr.scss). */
const START_SIZE = { strip: { width: 800, height: 160 }, wrist: { width: 350, height: 480 } };

/** One message to the helper: [u32 kind][u32 length][payload]. */
function message(kind, payload) {
  const head = Buffer.alloc(8);
  head.writeUInt32LE(kind, 0);
  head.writeUInt32LE(payload.length, 4);
  return Buffer.concat([head, payload]);
}

function configMessage(lines) {
  return message(1, Buffer.from(lines.join('\n'), 'utf8'));
}

/** A picture: [u8 overlay][3 pad][u32 width][u32 height] and its BGRA. */
function pictureMessage(surface, width, height, bgra) {
  const head = Buffer.alloc(12);
  head.writeUInt8(INDEX[surface], 0);
  head.writeUInt32LE(width, 4);
  head.writeUInt32LE(height, 8);
  return message(2, Buffer.concat([head, bgra]));
}

/** Splits a stream into lines, each handed to `onLine` parsed (a line that is not JSON is dropped). */
function jsonLines(onLine) {
  let rest = '';
  return (chunk) => {
    rest += chunk.toString('utf8');
    let at;
    while ((at = rest.indexOf('\n')) >= 0) {
      const line = rest.slice(0, at).trim();
      rest = rest.slice(at + 1);
      if (!line) continue;
      try { onLine(JSON.parse(line)); } catch { /* not ours */ }
    }
  };
}

/** The mouse events a poke at (u, v) on a page of `size` makes. */
function pokeEvents(kind, u, v, size) {
  const x = Math.round(u * size.width);
  const y = Math.round(v * size.height);
  if (kind === 'move') return [{ type: 'mouseMove', x, y }];
  if (kind === 'down') return [{ type: 'mouseMove', x, y }, { type: 'mouseDown', x, y, button: 'left', clickCount: 1 }];
  if (kind === 'up') return [{ type: 'mouseUp', x, y, button: 'left', clickCount: 1 }];
  if (kind === 'leave') return [{ type: 'mouseLeave', x, y }];
  return [];
}

function helperFile(app, env = process.env) {
  if (!app.isPackaged && env.KOTOMIMI_VR_HELPER) return env.KOTOMIMI_VR_HELPER;
  if (app.isPackaged) return path.join(process.resourcesPath, 'kotomimi-vr', 'kotomimi-vr.exe');
  return path.join(app.getAppPath(), 'vr-overlay', 'build', 'Release', 'kotomimi-vr.exe');
}

function createVrOverlay({ BrowserWindow, preload, pageUrl, helper, push, spawnHelper = spawn, dumpDir = null, log = () => {} }) {
  let child = null;
  let vr = 'off';
  let state = null;
  const windows = {};
  const sizes = { strip: { ...START_SIZE.strip }, wrist: { ...START_SIZE.wrist } };
  const tuning = [];

  const status = () => ({ vr });
  const setVr = (next) => {
    if (vr === next) return;
    vr = next;
    push('vr:status', status());
    if (vr === 'connected') openWindows();
    else closeWindows();
  };

  const write = (buffer) => {
    if (child && child.stdin.writable) child.stdin.write(buffer);
  };

  const openWindows = () => {
    for (const surface of SURFACES) {
      if (windows[surface] && !windows[surface].isDestroyed()) continue;
      const size = sizes[surface];
      const win = new BrowserWindow({
        show: false,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        width: size.width * ZOOM,
        height: size.height * ZOOM,
        useContentSize: true,
        webPreferences: { offscreen: true, preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      windows[surface] = win;
      win.webContents.setFrameRate(surface === 'wrist' ? 30 : 20);
      win.webContents.on('did-finish-load', () => win.webContents.setZoomFactor(ZOOM));
      let dumped = 0;
      win.webContents.on('paint', (_event, _dirty, image) => {
        const { width, height } = image.getSize();
        if (width === 0 || height === 0) return;
        write(pictureMessage(surface, width, height, image.toBitmap()));
        if (dumpDir) fs.writeFile(path.join(dumpDir, `${surface}-${String(dumped++).padStart(4, '0')}.png`), image.toPNG(), () => {});
      });
      win.on('closed', () => { if (windows[surface] === win) delete windows[surface]; });
      void win.loadURL(pageUrl(surface));
    }
  };

  const closeWindows = () => {
    for (const surface of SURFACES) {
      const win = windows[surface];
      delete windows[surface];
      if (win && !win.isDestroyed()) win.destroy();
    }
  };

  const toPage = (surface, channel, payload) => {
    const win = windows[surface];
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  const onHelper = (line) => {
    if (line.t === 'status') {
      if (line.vr === 'error') log(`SteamVR overlay: ${line.detail || 'error'}`);
      setVr(line.vr === 'connected' ? 'connected' : 'waiting');
    } else if (line.t === 'perf') {
      toPage('wrist', 'vr:perf', line);
    } else if (line.t === 'pointer' && line.o === 'wrist') {
      const win = windows.wrist;
      if (!win || win.isDestroyed()) return;
      for (const event of pokeEvents(line.kind, line.u, line.v, { width: sizes.wrist.width * ZOOM, height: sizes.wrist.height * ZOOM })) win.webContents.sendInputEvent(event);
    } else if (line.t === 'wrist') {
      push('vr:wrist', { shown: line.shown === true });
    }
  };

  const start = () => {
    if (child) return;
    if (!fs.existsSync(helper)) {
      log(`SteamVR overlay: no helper at ${helper}`);
      setVr('missing');
      return;
    }
    const proc = spawnHelper(helper, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    child = proc;
    proc.stdout.on('data', jsonLines(onHelper));
    proc.stdin.on('error', () => {});
    proc.on('exit', () => {
      if (child !== proc) return;
      child = null;
      setVr('off');
    });
    if (tuning.length) write(configMessage(tuning));
    setVr('waiting');
  };

  const stop = () => {
    const proc = child;
    child = null;
    if (proc) {
      proc.stdin.end();
      setTimeout(() => { if (proc.exitCode === null) proc.kill(); }, 3000);
    }
    setVr('off');
  };

  return {
    status,
    set(on) { if (on) start(); else stop(); return status(); },
    state(next) {
      state = next;
      for (const surface of SURFACES) toPage(surface, 'vr:state', state);
    },
    ready(surface) { if (state) toPage(surface, 'vr:state', state); },
    resize(surface, width, height) {
      if (!SURFACES.includes(surface) || !(width > 0 && height > 0 && width <= 2000 && height <= 2000)) return;
      sizes[surface] = { width, height };
      const win = windows[surface];
      if (win && !win.isDestroyed()) win.setContentSize(Math.round(width * ZOOM), Math.round(height * ZOOM));
    },
    /** Lines of the helper's config (`applyConfig` in vr-overlay/src/main.cpp), kept for its next start. */
    tune(lines) {
      for (const line of lines) {
        const key = line.split(' ')[0];
        const at = tuning.findIndex((l) => l.split(' ')[0] === key);
        if (at >= 0) tuning[at] = line; else tuning.push(line);
      }
      write(configMessage(lines));
    },
    isPage(sender) { return SURFACES.some((s) => windows[s] && !windows[s].isDestroyed() && windows[s].webContents === sender); },
    stop,
  };
}

function setupVrOverlay({ ipcMain, BrowserWindow, app, isTrustedSender, getMainWindow, loadsDevServer, platform = process.platform }) {
  const push = (channel, payload) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };
  if (platform !== 'win32') {
    ipcMain.handle('vr:set', () => ({ vr: 'off' }));
    for (const channel of ['vr:state', 'vr:tune', 'vr:command', 'vr:ready', 'vr:size']) ipcMain.handle(channel, () => undefined);
    return { stop() {} };
  }
  const dumpDir = !app.isPackaged && process.env.KOTOMIMI_VR_DUMP ? process.env.KOTOMIMI_VR_DUMP : null;
  if (dumpDir) fs.mkdirSync(dumpDir, { recursive: true });
  const overlay = createVrOverlay({
    BrowserWindow,
    preload: path.join(__dirname, 'preload.js'),
    pageUrl: (surface) => (loadsDevServer()
      ? `http://localhost:5173/vr.html#${surface}`
      : `file://${path.join(app.getAppPath(), 'build', 'vr.html').replace(/\\/g, '/')}#${surface}`),
    helper: helperFile(app),
    push,
    dumpDir,
    log: (text) => console.info(text),
  });
  ipcMain.handle('vr:set', (event, payload) => (isTrustedSender(event.sender) ? overlay.set(Boolean(payload && payload.on)) : undefined));
  ipcMain.handle('vr:state', (event, payload) => { if (isTrustedSender(event.sender) && payload && typeof payload === 'object') overlay.state(payload); });
  ipcMain.handle('vr:tune', (event, payload) => {
    if (!isTrustedSender(event.sender) || !payload || !Array.isArray(payload.lines)) return;
    overlay.tune(payload.lines.filter((l) => typeof l === 'string' && /^[a-z.]+( [-0-9a-z.]+)*$/.test(l)));
  });
  ipcMain.handle('vr:command', (event, payload) => { if (overlay.isPage(event.sender) && payload && typeof payload.type === 'string') push('vr:command', payload); });
  ipcMain.handle('vr:ready', (event, payload) => { if (overlay.isPage(event.sender) && payload) overlay.ready(payload.surface); });
  ipcMain.handle('vr:size', (event, payload) => { if (overlay.isPage(event.sender) && payload) overlay.resize(payload.surface, Number(payload.width), Number(payload.height)); });
  app.on('will-quit', () => overlay.stop());
  return overlay;
}

module.exports = { setupVrOverlay, createVrOverlay, pictureMessage, configMessage, jsonLines, pokeEvents };
