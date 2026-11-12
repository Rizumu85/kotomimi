import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fixture from '../src/lib/subtitle/__fixtures__/capture.json';

const { writeSubtitleCapture, setupSubtitleCaptureHandler } = createRequire(import.meta.url)('./subtitle-capture.js');
let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'kotomimi-capture-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const { startedAt, durationMs, truncated, frames, language } = fixture;
const payload = { startedAt, durationMs, truncated, frames, language };
const now = new Date(2026, 10, 11, 12, 34, 56, 789);
const write = (extra = {}) => writeSubtitleCapture({ userData: dir, payload, appVersion: 'actual-version', platform: 'win32', now, showItemInFolder: vi.fn(), ...extra });

describe('subtitle capture save', () => {
  it('writes exactly the caption minute and authoritative metadata, then reveals the local-time file', async () => {
    const reveal = vi.fn((file) => expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ ...fixture, appVersion: 'actual-version' }));
    const result = await write({ showItemInFolder: reveal });
    expect(result).toEqual({ ok: true, path: join(dir, 'subtitle-captures', '20261111-123456-789.json') });
    expect(reveal).toHaveBeenCalledWith(result.path);
    expect(JSON.parse(readFileSync(result.path, 'utf8'))).not.toHaveProperty('audio');
  });

  it('never overwrites an existing capture, including concurrent saves', async () => {
    const results = await Promise.all([write(), write()]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(new Set(results.map((result) => result.path)).size).toBe(2);
  });

  it.each([null, { ...payload, path: '../escape.json' }, { ...payload, frames: [{ at: 0, state: { ...frames[0].state, audio: [1] } }] }, { ...payload, frames: [] }])('rejects invalid IPC content without writing', async (bad) => {
    expect(await write({ payload: bad })).toMatchObject({ ok: false, error: expect.any(String) });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('returns an IO failure instead of rejecting or revealing a nonexistent file', async () => {
    writeFileSync(join(dir, 'subtitle-captures'), 'blocked');
    const reveal = vi.fn();
    expect(await write({ showItemInFolder: reveal })).toMatchObject({ ok: false, error: expect.any(String) });
    expect(reveal).not.toHaveBeenCalled();
  });

  it('registers the allowlisted channel and refuses other windows', async () => {
    const handlers = new Map();
    const sender = {};
    const shell = { showItemInFolder: vi.fn() };
    setupSubtitleCaptureHandler({ ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
      app: { getPath: (name) => { expect(name).toBe('userData'); return dir; }, getVersion: () => 'main-version' },
      shell, isTrustedSender: (value) => value === sender });
    const save = handlers.get('subtitle:save-capture');
    expect(await save({ sender: {} }, payload)).toMatchObject({ ok: false });
    expect(readdirSync(dir)).toEqual([]);
    const result = await save({ sender }, payload);
    expect(JSON.parse(readFileSync(result.path, 'utf8'))).toMatchObject({ appVersion: 'main-version', platform: process.platform });
    expect(shell.showItemInFolder).toHaveBeenCalledWith(result.path);
    const main = readFileSync(join(__dirname, 'main.js'), 'utf8');
    expect(main).toContain('setupSubtitleCaptureHandler({ ipcMain, app, shell, isTrustedSender: (sender) => sender === mainWindow?.webContents })');
  });
});
