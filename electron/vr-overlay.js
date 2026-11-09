// electron/vr-overlay.js
//
// Fork: the SteamVR overlay's main-process side (vr-overlay/src/main.cpp). Windows only.
//
// While the main window asks for it (`vr:set`), the helper `kotomimi-vr.exe`
// runs and waits for SteamVR. Once SteamVR is up, an offscreen window draws
// `vr.html#strip`; each new picture goes to the helper's stdin, which shows it
// in the headset.
//
// The wrist panel, `vr.html#wrist`, is a small window on the desktop, open
// while the main window asks for it (`vr:panel`): a wrist tool such as
// XSOverlay adds it as a window and carries it on a wrist, presses included.
// It opens at the panel's size, at one and a half device pixels a CSS pixel,
// crisp in a headset; its top row moves it. The helper's frame rate and memory
// lines go to it. What the pages show (`vr:state`) comes from the main window;
// what the panel asks (`vr:command`) goes back to it.
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

/** The strip's pictures are drawn at twice the page's CSS size: crisp at reading distance in a headset. */
const ZOOM = 2;
/** The panel window's device pixels per CSS pixel: a wrist tool's picture of it is that sharp. */
const PANEL_PIXELS = 1.5;
const INDEX = { strip: 0 };
/** Sizes before a page has measured itself (src/vr/vr.scss). */
const START_SIZE = { strip: { width: 800, height: 160 }, wrist: { width: 350, height: 480 } };
/**
 * Each page in a session of its own (in memory): Chromium keeps one zoom for every page of an origin in a session, and
 * the strip's would size the panel, both being vr.html.
 */
const PARTITION = { strip: 'kotomimi-vr-strip', wrist: 'kotomimi-vr-panel' };
/** The panel's own background (`--sk-bg-base`, dark), shown before the page paints. */
const PANEL_BACKGROUND = '#1a1a1a';

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

function helperFile(app, env = process.env) {
  if (!app.isPackaged && env.KOTOMIMI_VR_HELPER) return env.KOTOMIMI_VR_HELPER;
  if (app.isPackaged) return path.join(process.resourcesPath, 'kotomimi-vr', 'kotomimi-vr.exe');
  return path.join(app.getAppPath(), 'vr-overlay', 'build', 'Release', 'kotomimi-vr.exe');
}

function createVrOverlay({ BrowserWindow, preload, pageUrl, helper, push, spawnHelper = spawn, scaleFactor = () => 1, dumpDir = null, log = () => {} }) {
  let child = null;
  let vr = 'off';
  let state = null;
  /** The strip's offscreen window, while SteamVR shows it. */
  let strip = null;
  /** The wrist panel's window, while asked for. */
  let panel = null;
  let panelZoom = 1;
  const sizes = { strip: { ...START_SIZE.strip }, wrist: { ...START_SIZE.wrist } };
  const tuning = [];

  const status = () => ({ vr });
  const setVr = (next) => {
    if (vr === next) return;
    vr = next;
    push('vr:status', status());
    if (vr === 'connected') openStrip();
    else closeStrip();
  };

  const write = (buffer) => {
    if (child && child.stdin.writable) child.stdin.write(buffer);
  };
  // A picture waits while the pipe is full, and a newer one takes its place: what the helper has not read is never
  // more than one picture.
  let waiting = null;
  const sendPicture = (buffer) => {
    if (!child || !child.stdin.writable) return;
    if (child.stdin.writableNeedDrain) { waiting = buffer; return; }
    child.stdin.write(buffer);
  };
  const drain = () => {
    const buffer = waiting;
    waiting = null;
    if (buffer) sendPicture(buffer);
  };

  const alive = (win) => Boolean(win && !win.isDestroyed());

  const openStrip = () => {
    if (alive(strip)) return;
    {
      const surface = 'strip';
      const size = sizes.strip;
      const win = new BrowserWindow({
        show: false,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        width: size.width * ZOOM,
        height: size.height * ZOOM,
        useContentSize: true,
        webPreferences: { offscreen: true, partition: PARTITION.strip, preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      strip = win;
      win.webContents.setFrameRate(20);
      win.webContents.on('did-finish-load', () => win.webContents.setZoomFactor(ZOOM));
      let dumped = 0;
      win.webContents.on('paint', (_event, _dirty, image) => {
        const { width, height } = image.getSize();
        if (width === 0 || height === 0) return;
        sendPicture(pictureMessage(surface, width, height, image.toBitmap()));
        if (dumpDir) fs.writeFile(path.join(dumpDir, `${surface}-${String(dumped++).padStart(4, '0')}.png`), image.toPNG(), () => {});
      });
      win.on('closed', () => { if (strip === win) strip = null; });
      void win.loadURL(pageUrl(surface));
    }
  };

  const closeStrip = () => {
    const win = strip;
    strip = null;
    if (alive(win)) win.destroy();
  };

  const panelContent = () => ({ width: Math.round(sizes.wrist.width * panelZoom), height: Math.round(sizes.wrist.height * panelZoom) });

  const openPanel = () => {
    if (alive(panel)) { panel.show(); return; }
    // As sharp on any display: one and a half device pixels a CSS pixel, never smaller than the page.
    panelZoom = Math.max(1, PANEL_PIXELS / (scaleFactor() || 1));
    const { width, height } = panelContent();
    const win = new BrowserWindow({
      title: 'Kotomimi',
      width,
      height,
      useContentSize: true,
      frame: false,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      backgroundColor: PANEL_BACKGROUND,
      webPreferences: { partition: PARTITION.wrist, preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    panel = win;
    win.webContents.on('did-finish-load', () => win.webContents.setZoomFactor(panelZoom));
    // Closed otherwise (Alt+F4, the app quitting): the main window is told, and shows it closed.
    win.on('closed', () => {
      if (panel !== win) return;
      panel = null;
      push('vr:panel', { on: false });
    });
    void win.loadURL(pageUrl('wrist'));
  };

  const closePanel = () => {
    const win = panel;
    panel = null;
    if (alive(win)) win.destroy();
  };

  const toPage = (surface, channel, payload) => {
    const win = surface === 'strip' ? strip : panel;
    if (alive(win)) win.webContents.send(channel, payload);
  };

  const onHelper = (line) => {
    if (line.t === 'status') {
      if (line.vr === 'error') log(`SteamVR overlay: ${line.detail || 'error'}`);
      setVr(line.vr === 'connected' ? 'connected' : 'waiting');
    } else if (line.t === 'perf') {
      toPage('wrist', 'vr:perf', line);
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
    proc.stdin.on('drain', drain);
    const ended = () => {
      if (child !== proc) return;
      child = null;
      waiting = null;
      setVr('off');
    };
    proc.on('exit', ended);
    proc.on('error', (error) => { log(`SteamVR overlay: the helper failed: ${error.message}`); ended(); });
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
    /** The wrist panel's window, opened or closed. */
    panel(on) { if (on) openPanel(); else closePanel(); return { on: alive(panel) }; },
    state(next) {
      state = next;
      toPage('strip', 'vr:state', state);
      toPage('wrist', 'vr:state', state);
    },
    ready(surface) { if (state) toPage(surface, 'vr:state', state); },
    resize(surface, width, height) {
      if (!(surface in sizes) || !(width > 0 && height > 0 && width <= 2000 && height <= 2000)) return;
      sizes[surface] = { width, height };
      if (surface === 'strip' && alive(strip)) strip.setContentSize(Math.round(width * ZOOM), Math.round(height * ZOOM));
      if (surface === 'wrist' && alive(panel)) { const c = panelContent(); panel.setContentSize(c.width, c.height); }
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
    isPage(sender) { return [strip, panel].some((win) => alive(win) && win.webContents === sender); },
    stop() { stop(); closePanel(); },
  };
}

function setupVrOverlay({ ipcMain, BrowserWindow, scaleFactor, app, isTrustedSender, getMainWindow, loadsDevServer, platform = process.platform }) {
  const push = (channel, payload) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };
  if (platform !== 'win32') {
    ipcMain.handle('vr:set', () => ({ vr: 'off' }));
    ipcMain.handle('vr:panel', () => ({ on: false }));
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
    scaleFactor,
    dumpDir,
    log: (text) => console.info(text),
  });
  ipcMain.handle('vr:set', (event, payload) => (isTrustedSender(event.sender) ? overlay.set(Boolean(payload && payload.on)) : undefined));
  ipcMain.handle('vr:panel', (event, payload) => (isTrustedSender(event.sender) ? overlay.panel(Boolean(payload && payload.on)) : undefined));
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

module.exports = { setupVrOverlay, createVrOverlay, pictureMessage, configMessage, jsonLines };
