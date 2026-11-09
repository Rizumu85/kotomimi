// @vitest-environment node
// electron/vr-overlay.test.js
//
// Fork: the SteamVR overlay's main-process side, over a stand-in helper and stand-in windows.
import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createVrOverlay, pictureMessage, configMessage, jsonLines } = require('./vr-overlay.js');

describe('the helper’s messages', () => {
  it('frames a picture as kind 2: the overlay, its size, then its pixels', () => {
    const pixels = Buffer.alloc(2 * 3 * 4, 7);
    const m = pictureMessage('strip', 2, 3, pixels);
    expect(m.readUInt32LE(0)).toBe(2);
    expect(m.readUInt32LE(4)).toBe(12 + pixels.length);
    expect(m.readUInt8(8)).toBe(0);
    expect(m.readUInt32LE(12)).toBe(2);
    expect(m.readUInt32LE(16)).toBe(3);
    expect(m.subarray(20)).toEqual(pixels);
  });

  it('frames config as kind 1: its lines', () => {
    const m = configMessage(['strip.below 22', 'strip.on 0']);
    expect(m.readUInt32LE(0)).toBe(1);
    expect(m.subarray(8).toString()).toBe('strip.below 22\nstrip.on 0');
  });

  it('reads the helper’s lines across chunks, and drops what is not JSON', () => {
    const lines = [];
    const feed = jsonLines((l) => lines.push(l));
    feed(Buffer.from('{"t":"status","vr":"wai'));
    feed(Buffer.from('ting"}\nnoise\n{"t":"perf"}\n'));
    expect(lines).toEqual([{ t: 'status', vr: 'waiting' }, { t: 'perf' }]);
  });
});

function fakeWindow(options) {
  const webContents = Object.assign(new EventEmitter(), {
    sent: [],
    inputs: [],
    zoom: 1,
    send(channel, payload) { this.sent.push([channel, payload]); },
    sendInputEvent(e) { this.inputs.push(e); },
    setFrameRate() {},
    setZoomFactor(z) { this.zoom = z; },
  });
  const win = Object.assign(new EventEmitter(), {
    options,
    webContents,
    destroyed: false,
    size: [options.width, options.height],
    isDestroyed() { return this.destroyed; },
    destroy() { this.destroyed = true; this.emit('closed'); },
    show: vi.fn(),
    setContentSize(w, h) { this.size = [w, h]; },
    loadURL: vi.fn(async () => {}),
  });
  return win;
}

function setup({ scale = 1 } = {}) {
  const windows = [];
  function BrowserWindow(options) { const w = fakeWindow(options); windows.push(w); return w; }
  const stdin = new PassThrough();
  const written = [];
  stdin.on('data', (d) => written.push(d));
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdin, stdout, exitCode: null, kill: vi.fn() });
  const spawnHelper = vi.fn(() => child);
  const pushed = [];
  const overlay = createVrOverlay({
    BrowserWindow,
    preload: 'preload.js',
    pageUrl: (s) => `vr.html#${s}`,
    helper: process.execPath,
    push: (channel, payload) => pushed.push([channel, payload]),
    spawnHelper,
    scaleFactor: () => scale,
  });
  const say = (line) => stdout.write(`${JSON.stringify(line)}\n`);
  return { overlay, windows, written, child, spawnHelper, pushed, say };
}

const tick = () => new Promise((r) => setImmediate(r));

describe('createVrOverlay', () => {
  it('runs the helper while asked, and draws the strip only while SteamVR shows it', async () => {
    const t = setup();
    expect(t.overlay.set(true)).toEqual({ vr: 'waiting' });
    expect(t.spawnHelper).toHaveBeenCalledTimes(1);
    expect(t.windows).toHaveLength(0);
    t.say({ t: 'status', vr: 'connected' });
    await tick();
    expect(t.windows.map((w) => w.options.webPreferences.offscreen)).toEqual([true]);
    expect(t.windows.map((w) => w.loadURL.mock.calls[0][0])).toEqual(['vr.html#strip']);
    expect(t.pushed).toContainEqual(['vr:status', { vr: 'connected' }]);
    t.say({ t: 'status', vr: 'waiting' });
    await tick();
    expect(t.windows.every((w) => w.destroyed)).toBe(true);
    t.overlay.set(false);
    expect(t.pushed.at(-1)).toEqual(['vr:status', { vr: 'off' }]);
  });

  it('sends each picture the strip paints, and the state to the strip', async () => {
    const t = setup();
    t.overlay.set(true);
    t.say({ t: 'status', vr: 'connected' });
    await tick();
    const [strip] = t.windows;
    const bitmap = Buffer.alloc(4 * 4 * 4, 1);
    strip.webContents.emit('paint', {}, {}, { getSize: () => ({ width: 4, height: 4 }), toBitmap: () => bitmap });
    await tick();
    const all = Buffer.concat(t.written);
    expect(all.readUInt32LE(0)).toBe(2);
    expect(all.readUInt8(8)).toBe(0);
    t.overlay.state({ phase: 'idle' });
    expect(strip.webContents.sent.at(-1)).toEqual(['vr:state', { phase: 'idle' }]);
    expect(t.overlay.isPage(strip.webContents)).toBe(true);
    expect(t.overlay.isPage({})).toBe(false);
  });

  it('opens the wrist panel as a window of its own, without SteamVR, sized to the page and sharp', async () => {
    const t = setup({ scale: 1 });
    expect(t.overlay.panel(true)).toEqual({ on: true });
    const [panel] = t.windows;
    expect(panel.options).toMatchObject({ frame: false, resizable: false, width: 525, height: 720 });
    expect(panel.options.webPreferences.offscreen).toBeUndefined();
    expect(panel.loadURL.mock.calls[0][0]).toBe('vr.html#wrist');
    expect(t.spawnHelper).not.toHaveBeenCalled();
    t.overlay.resize('wrist', 350, 500);
    expect(panel.size).toEqual([525, 750]);
    t.overlay.state({ phase: 'idle' });
    expect(panel.webContents.sent.at(-1)).toEqual(['vr:state', { phase: 'idle' }]);
    expect(t.overlay.isPage(panel.webContents)).toBe(true);
    // The helper's frame rate goes to it; the strip's window is in another session, whose zoom would size it.
    t.overlay.set(true);
    t.say({ t: 'perf', hz: 90 });
    await tick();
    expect(panel.webContents.sent.at(-1)).toEqual(['vr:perf', { t: 'perf', hz: 90 }]);
    t.say({ t: 'status', vr: 'connected' });
    await tick();
    expect(t.windows[1].options.webPreferences.partition).not.toBe(panel.options.webPreferences.partition);
    // Asked again: the one window, shown.
    t.overlay.panel(true);
    expect(t.windows.filter((w) => w.loadURL.mock.calls[0]?.[0] === 'vr.html#wrist')).toHaveLength(1);
    expect(panel.show).toHaveBeenCalled();
    // Closed from the settings: nothing said back; by the user: the setting is told.
    t.overlay.panel(false);
    expect(panel.destroyed).toBe(true);
    expect(t.pushed.some(([c]) => c === 'vr:panel')).toBe(false);
    t.overlay.panel(true);
    t.windows.at(-1).destroy();
    expect(t.pushed).toContainEqual(['vr:panel', { on: false }]);
  });

  it('opens the panel no larger than the page on a display that already has the pixels', () => {
    const t = setup({ scale: 2 });
    t.overlay.panel(true);
    expect(t.windows[0].options).toMatchObject({ width: 350, height: 480 });
  });

  it('keeps the tuning for the helper’s next start, one line per key', () => {
    const t = setup();
    t.overlay.tune(['strip.below 20']);
    t.overlay.tune(['strip.below 22', 'strip.on 0']);
    t.overlay.set(true);
    const first = Buffer.concat(t.written);
    expect(first.subarray(8).toString()).toBe('strip.below 22\nstrip.on 0');
  });

  it('keeps one picture a page while the helper’s pipe is full, the newest, and sends it on drain', async () => {
    const t = setup();
    t.overlay.set(true);
    t.say({ t: 'status', vr: 'connected' });
    await tick();
    const stdin = t.child.stdin;
    const writes = [];
    stdin.write = (b) => { writes.push(b); return true; };
    Object.defineProperty(stdin, 'writableNeedDrain', { value: true, configurable: true });
    const paint = (n) => t.windows[0].webContents.emit('paint', {}, {}, { getSize: () => ({ width: 1, height: 1 }), toBitmap: () => Buffer.from([n, n, n, n]) });
    paint(1);
    paint(2);
    expect(writes).toHaveLength(0);
    Object.defineProperty(stdin, 'writableNeedDrain', { value: false, configurable: true });
    stdin.emit('drain');
    expect(writes).toHaveLength(1);
    expect(writes[0].subarray(20)).toEqual(Buffer.from([2, 2, 2, 2]));
  });

  it('ends quietly when the helper cannot be started', () => {
    const t = setup();
    t.overlay.set(true);
    t.child.emit('error', new Error('EACCES'));
    expect(t.overlay.status()).toEqual({ vr: 'off' });
  });

  it('says so when this build has no helper', () => {
    const t = setup();
    const overlay = createVrOverlay({ BrowserWindow: vi.fn(), preload: '', pageUrl: () => '', helper: 'Z:/nowhere/kotomimi-vr.exe', push: (c, p) => t.pushed.push([c, p]), spawnHelper: t.spawnHelper });
    expect(overlay.set(true)).toEqual({ vr: 'missing' });
    expect(t.spawnHelper).not.toHaveBeenCalled();
  });
});
