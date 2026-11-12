// @vitest-environment node
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
const { createSessionRecording, setupSessionRecordingHandlers, retain, resample } = createRequire(import.meta.url)('./session-recording.js');
let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kotomimi-recording-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const make = () => createSessionRecording({ userData: dir, appVersion: 'test-version', platform: 'win32' });
const start = (r, at = Date.now()) => { r.start({ startedAt: at, metadata: { provider: 'test' } }); return at; };
const folder = (r) => path.join(r.root, fs.readdirSync(r.root)[0]);

describe('session recording files', () => {
  it('places chunks by arrival minus duration, fills gaps and pads all tracks to one end', () => {
    const r = make(), at = start(r);
    r.write({ kind: 'pcm', leg: 'speaker', pcm: new Int16Array(2400).fill(1200), rate: 24000, ms: 100 });
    r.write({ kind: 'pcm', leg: 'speaker', pcm: new Int16Array(4800).fill(-2000), rate: 48000, ms: 400 });
    r.end({ endedAt: at + 600, durationMs: 600 });
    const file = fs.readFileSync(path.join(folder(r), 'speaker.wav'));
    expect(file.toString('ascii', 0, 4)).toBe('RIFF');
    expect(file.readUInt32LE(4)).toBe(file.length - 8);
    expect(file.readUInt32LE(24)).toBe(16000);
    expect(file.readUInt16LE(22)).toBe(1);
    expect(file.readUInt16LE(34)).toBe(16);
    expect(file.readUInt32LE(40)).toBe(19200);
    const samples = Array.from({ length: 9600 }, (_, i) => file.readInt16LE(44 + i * 2));
    expect(samples.slice(0, 1600).every((n) => n === 1200)).toBe(true);
    expect(samples.slice(1600, 4800).every((n) => n === 0)).toBe(true);
    expect(samples.slice(4800, 6400).every((n) => n === -2000)).toBe(true);
    expect(samples.slice(6400).every((n) => n === 0)).toBe(true);
    for (const leg of ['participant', 'raw']) {
      const silent = fs.readFileSync(path.join(folder(r), `${leg}.wav`));
      expect(silent.length).toBe(file.length);
      expect(silent.subarray(44).every((n) => n === 0)).toBe(true);
    }
    const meta = JSON.parse(fs.readFileSync(path.join(folder(r), 'session.json')));
    expect(meta).toMatchObject({ startedAt: at, endedAt: at + 600, appVersion: 'test-version', platform: 'win32', sampleRate: 16000 });
  });

  it('averages samples when resampling, snaps jitter, and trims pre-start audio', () => {
    const result = resample(Int16Array.from([0, 300, 600, 900, 1200, 1500]), 48000);
    expect([result.readInt16LE(0), result.readInt16LE(2)]).toEqual([300, 1200]);
    const r = make(), at = start(r);
    r.write({ kind: 'pcm', leg: 'raw', pcm: new Int16Array(2400).fill(10), rate: 24000, ms: 50 });
    r.write({ kind: 'pcm', leg: 'raw', pcm: new Int16Array(2400).fill(20), rate: 24000, ms: 155 });
    r.end({ endedAt: at + 160, durationMs: 160 });
    const file = fs.readFileSync(path.join(folder(r), 'raw.wav'));
    expect(file.readInt16LE(44)).toBe(10);
    expect(file.readInt16LE(44 + 800 * 2)).toBe(20);
    expect(file.readInt16LE(44 + 2399 * 2)).toBe(20);
    expect(file.readInt16LE(44 + 2400 * 2)).toBe(0);
  });

  it('writes lines incrementally and finds a completed older session by the line wall time', () => {
    const r = make(), at = start(r);
    r.write({ kind: 'line', data: { stage: 'source', entryId: 'x', sourceText: 'hello' } });
    expect(fs.readFileSync(path.join(folder(r), 'lines.jsonl'), 'utf8')).toContain('hello');
    r.end({ endedAt: at + 100, durationMs: 100 });
    const older = folder(r);
    start(r, at + 1000);
    r.end({ endedAt: at + 1100, durationMs: 100 });
    const mark = { wallTime: at + 50, leg: 'speaker', entryId: 'x', sourceText: 'hello', translationText: 'hi', markedAt: at + 2000 };
    expect(r.mark(mark)).toEqual({ ok: true });
    expect(JSON.parse(fs.readFileSync(path.join(older, 'marks.jsonl'), 'utf8'))).toEqual(mark);
    expect(r.mark({ ...mark, wallTime: at + 500 })).toMatchObject({ ok: false, reason: 'not-recorded' });
  });

  it('does not assign lines to an unclosed recording from a previous process', () => {
    const root = path.join(dir, 'session-recordings', 'crashed');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'session.json'), JSON.stringify({ startedAt: 1, endedAt: null }));
    expect(make().mark({ wallTime: 2, markedAt: 3, leg: 'speaker', entryId: 'x', sourceText: '', translationText: '' }))
      .toMatchObject({ ok: false, reason: 'not-recorded' });
  });
});

describe('retention', () => {
  it('removes sessions older than seven days, then oldest first to the size limit', () => {
    const now = Date.now();
    const root = path.join(dir, 'session-recordings');
    for (const [name, age] of [['expired', 8], ['old', 6], ['new', 1]]) {
      const child = path.join(root, name);
      fs.mkdirSync(child, { recursive: true });
      fs.writeFileSync(path.join(child, 'session.json'), JSON.stringify({ startedAt: now - age * 86400000, endedAt: now - age * 86400000 + 1 }));
      fs.writeFileSync(path.join(child, 'raw.wav'), Buffer.alloc(1024));
    }
    retain(root, now, 1200);
    expect(fs.readdirSync(root)).toEqual(['new']);
  });
  it('uses the actual 2 GB default budget without loading audio', () => {
    const r = make(), at = start(r);
    r.end({ endedAt: at + 1, durationMs: 1 });
    const fd = fs.openSync(path.join(folder(r), 'raw.wav'), 'r+');
    fs.ftruncateSync(fd, 2 * 1024 ** 3); fs.closeSync(fd);
    retain(r.root, at);
    expect(fs.readdirSync(r.root)).toEqual([]);
  });
});

it('registers trusted IPC handlers and validates renderer input at the boundary', async () => {
  const handlers = new Map(), shell = { openPath: vi.fn(async () => '') };
  const main = new EventEmitter();
  setupSessionRecordingHandlers({ ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    app: { getPath: () => dir, getVersion: () => 'test' }, shell, isTrustedSender: (s) => s === main });
  const call = (op, payload, sender = main) => handlers.get(`session-recording:${op}`)({ sender }, payload);
  expect(await call('start', {}, 'child')).toMatchObject({ ok: false });
  expect(await call('start', { startedAt: NaN, metadata: {} })).toMatchObject({ ok: false });
  const at = Date.now();
  expect(await call('start', { startedAt: at, metadata: {} })).toEqual({ ok: true });
  expect(await call('write', { kind: 'pcm', leg: '../escape', pcm: new Int16Array(10), rate: 24000, ms: 20 })).toMatchObject({ ok: false });
  expect(await call('write', { kind: 'pcm', leg: 'speaker', pcm: new Uint8Array(10), rate: 24000, ms: 20 })).toMatchObject({ ok: false });
  expect(await call('end', { endedAt: at + 1, durationMs: 1 })).toEqual({ ok: true });
  expect(await call('open')).toEqual({ ok: true });
  expect(shell.openPath).toHaveBeenCalledWith(path.join(dir, 'session-recordings'));
  expect(await call('start', { startedAt: at + 2, metadata: {} })).toEqual({ ok: true });
  main.emit('render-process-gone');
  expect(await call('start', { startedAt: at + 3, metadata: {} })).toEqual({ ok: true });
  expect(await call('end', { endedAt: at + 4, durationMs: 1 })).toEqual({ ok: true });
});
