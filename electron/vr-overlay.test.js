// @vitest-environment node
// electron/vr-overlay.test.js
//
// Fork: the SteamVR overlay's main-process side, over a stand-in helper and stand-in windows.
import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createVrOverlay, pictureMessage, configMessage, jsonLines, pokeEvents } = require('./vr-overlay.js');

describe('the helper’s messages', () => {
  it('frames a picture as kind 2: the overlay, its size, then its pixels', () => {
    const pixels = Buffer.alloc(2 * 3 * 4, 7);
    const m = pictureMessage('wrist', 2, 3, pixels);
    expect(m.readUInt32LE(0)).toBe(2);
    expect(m.readUInt32LE(4)).toBe(12 + pixels.length);
    expect(m.readUInt8(8)).toBe(1);
    expect(m.readUInt32LE(12)).toBe(2);
    expect(m.readUInt32LE(16)).toBe(3);
    expect(m.subarray(20)).toEqual(pixels);
  });

  it('frames config as kind 1: its lines', () => {
    const m = configMessage(['wrist.hand right', 'strip.on 0']);
    expect(m.readUInt32LE(0)).toBe(1);
    expect(m.subarray(8).toString()).toBe('wrist.hand right\nstrip.on 0');
  });

  it('reads the helper’s lines across chunks, and drops what is not JSON', () => {
    const lines = [];
    const feed = jsonLines((l) => lines.push(l));
    feed(Buffer.from('{"t":"status","vr":"wai'));
    feed(Buffer.from('ting"}\nnoise\n{"t":"perf"}\n'));
    expect(lines).toEqual([{ t: 'status', vr: 'waiting' }, { t: 'perf' }]);
  });

  it('turns a poke into mouse events on the page', () => {
    const size = { width: 700, height: 1000 };
    expect(pokeEvents('move', 0.5, 0.25, size)).toEqual([{ type: 'mouseMove', x: 350, y: 250 }]);
    expect(pokeEvents('down', 0.5, 0.25, size).map((e) => e.type)).toEqual(['mouseMove', 'mouseDown']);
    expect(pokeEvents('up', 0.5, 0.25, size)[0]).toMatchObject({ type: 'mouseUp', button: 'left' });
    expect(pokeEvents('leave', 0, 0, size)[0].type).toBe('mouseLeave');
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
    setContentSize(w, h) { this.size = [w, h]; },
    loadURL: vi.fn(async () => {}),
  });
  return win;
}

function setup() {
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
  });
  const say = (line) => stdout.write(`${JSON.stringify(line)}\n`);
  return { overlay, windows, written, child, spawnHelper, pushed, say };
}

const tick = () => new Promise((r) => setImmediate(r));

describe('createVrOverlay', () => {
  it('runs the helper while asked, and draws the pages only while SteamVR shows them', async () => {
    const t = setup();
    expect(t.overlay.set(true)).toEqual({ vr: 'waiting' });
    expect(t.spawnHelper).toHaveBeenCalledTimes(1);
    expect(t.windows).toHaveLength(0);
    t.say({ t: 'status', vr: 'connected' });
    await tick();
    expect(t.windows.map((w) => w.options.webPreferences.offscreen)).toEqual([true, true]);
    expect(t.windows.map((w) => w.loadURL.mock.calls[0][0])).toEqual(['vr.html#strip', 'vr.html#wrist']);
    expect(t.pushed).toContainEqual(['vr:status', { vr: 'connected' }]);
    t.say({ t: 'status', vr: 'waiting' });
    await tick();
    expect(t.windows.every((w) => w.destroyed)).toBe(true);
    t.overlay.set(false);
    expect(t.pushed.at(-1)).toEqual(['vr:status', { vr: 'off' }]);
  });

  it('sends each picture a page paints, and the state to both pages', async () => {
    const t = setup();
    t.overlay.set(true);
    t.say({ t: 'status', vr: 'connected' });
    await tick();
    const [, wrist] = t.windows;
    const bitmap = Buffer.alloc(4 * 4 * 4, 1);
    wrist.webContents.emit('paint', {}, {}, { getSize: () => ({ width: 4, height: 4 }), toBitmap: () => bitmap });
    await tick();
    const all = Buffer.concat(t.written);
    expect(all.readUInt32LE(0)).toBe(2);
    expect(all.readUInt8(8)).toBe(1);
    t.overlay.state({ phase: 'idle' });
    expect(t.windows.map((w) => w.webContents.sent.at(-1))).toEqual([['vr:state', { phase: 'idle' }], ['vr:state', { phase: 'idle' }]]);
    expect(t.overlay.isPage(wrist.webContents)).toBe(true);
    expect(t.overlay.isPage({})).toBe(false);
  });

  it('pokes the wrist page where the helper says, at the picture’s scale', async () => {
    const t = setup();
    t.overlay.set(true);
    t.say({ t: 'status', vr: 'connected' });
    await tick();
    t.overlay.resize('wrist', 350, 500);
    expect(t.windows[1].size).toEqual([700, 1000]);
    t.say({ t: 'pointer', o: 'wrist', kind: 'down', u: 0.5, v: 0.1 });
    await tick();
    expect(t.windows[1].webContents.inputs).toEqual([
      { type: 'mouseMove', x: 350, y: 100 },
      { type: 'mouseDown', x: 350, y: 100, button: 'left', clickCount: 1 },
    ]);
  });

  it('keeps the tuning for the helper’s next start, one line per key', () => {
    const t = setup();
    t.overlay.tune(['wrist.hand right']);
    t.overlay.tune(['wrist.hand left', 'strip.on 0']);
    t.overlay.set(true);
    const first = Buffer.concat(t.written);
    expect(first.subarray(8).toString()).toBe('wrist.hand left\nstrip.on 0');
  });

  it('says so when this build has no helper', () => {
    const t = setup();
    const overlay = createVrOverlay({ BrowserWindow: vi.fn(), preload: '', pageUrl: () => '', helper: 'Z:/nowhere/kotomimi-vr.exe', push: (c, p) => t.pushed.push([c, p]), spawnHelper: t.spawnHelper });
    expect(overlay.set(true)).toEqual({ vr: 'missing' });
    expect(t.spawnHelper).not.toHaveBeenCalled();
  });
});
