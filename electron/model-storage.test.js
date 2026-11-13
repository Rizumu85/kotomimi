// @vitest-environment node
// electron/model-storage.test.js
//
// Fork: where the downloaded models are kept, and moving them. Real files in a folder of the test's own; the disk's
// free space is what the test says.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const fs = require('fs');
const { createModelStorage, MARGIN } = require('./model-storage.js');

let scratch;
let userData;
beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), 'kt-storage-'));
  userData = path.join(scratch, 'Kotomimi');
  mkdirSync(userData, { recursive: true });
});
afterEach(() => { rmSync(scratch, { recursive: true, force: true }); });

/** A model of `bytes` in an engine's folder. */
const model = (root, kind, name, bytes) => {
  mkdirSync(path.join(root, kind, 'models'), { recursive: true });
  writeFileSync(path.join(root, kind, 'models', name), Buffer.alloc(bytes, 7));
};
/** A disk with `free` bytes left; `dev` decides which folders are one drive. */
const disk = (free) => () => ({ bavail: free, bsize: 1, blocks: free * 4 });

describe('where the models are', () => {
  it('is the app\'s own folder until another is chosen, with what they take and the room left', () => {
    model(userData, 'native-engine', 'asr.gguf', 3000);
    model(userData, 'native-coach', 'gemma.gguf', 2000);
    const storage = createModelStorage({ userData, statfs: disk(10 ** 9), platform: 'linux' });
    expect(storage.status()).toMatchObject({ root: userData, isDefault: true, missing: false, usedBytes: 5000, drive: { freeBytes: 10 ** 9 } });
  });

  // On Windows alone: elsewhere 'D:\' is no whole path, and the plan refuses it before it names anything.
  it.skipIf(process.platform !== 'win32')('names a Windows drive by its letter', () => {
    const storage = createModelStorage({ userData, statfs: disk(10 ** 9), platform: 'win32' });
    expect(storage.plan('D:\\').target).toBe(path.join(path.resolve('D:\\'), 'Kotomimi'));
  });

  it('says a chosen folder that is not there any more is missing (a drive not plugged in)', () => {
    writeFileSync(path.join(userData, 'model-storage.json'), JSON.stringify({ root: path.join(scratch, 'gone') }));
    const storage = createModelStorage({ userData, statfs: disk(10 ** 9), platform: 'linux' });
    expect(storage.status()).toMatchObject({ isDefault: false, missing: true, usedBytes: 0 });
    expect(storage.reset()).toMatchObject({ root: userData, isDefault: true, missing: false });
  });
});

describe('a move, asked first', () => {
  it('says what moves and the room there, and refuses a drive without room for it', () => {
    model(userData, 'native-engine', 'asr.gguf', 3000);
    const target = path.join(scratch, 'D', 'Kotomimi');
    const roomy = createModelStorage({ userData, statfs: disk(10 ** 10), platform: 'linux', files: { ...fs, statSync: diffDrive(target) } });
    expect(roomy.plan(target)).toMatchObject({ target, needBytes: 3000, sameDrive: false });
    expect(roomy.plan(target).error).toBeUndefined();
    const tight = createModelStorage({ userData, statfs: disk(MARGIN + 100), platform: 'linux', files: { ...fs, statSync: diffDrive(target) } });
    expect(tight.plan(target).error).toBe('no_space');
  });

  it('leaves nothing behind in a place looked at and not chosen', () => {
    model(userData, 'native-engine', 'asr.gguf', 3000);
    const target = path.join(scratch, 'elsewhere', 'Kotomimi');
    const storage = createModelStorage({ userData, statfs: disk(10 ** 10), platform: 'linux' });
    expect(storage.plan(target).error).toBeUndefined();
    expect(existsSync(target)).toBe(false);
    // A folder that was there is left as it was.
    mkdirSync(target, { recursive: true });
    expect(storage.plan(target).error).toBeUndefined();
    expect(existsSync(target)).toBe(true);
  });

  it('refuses a folder not named in full: one relative to wherever the app runs from is no place a person chose', () => {
    const storage = createModelStorage({ userData, statfs: disk(10 ** 10), platform: 'linux' });
    expect(storage.plan('kt-storage-test').error).toBe('not_writable');
    expect(existsSync(path.join(process.cwd(), 'kt-storage-test'))).toBe(false);
  });

  it('refuses the folder the models are in, and one inside the folders that move', () => {
    const storage = createModelStorage({ userData, statfs: disk(10 ** 10), platform: 'linux' });
    expect(storage.plan(userData).error).toBe('same');
    expect(storage.plan(path.join(userData, 'native-engine', 'deeper')).error).toBe('inside');
  });
});

describe('a move', () => {
  it('copies every model to another drive, then lets the old folders go, and is the place from then on', async () => {
    model(userData, 'native-engine', 'asr.gguf', 3000);
    model(userData, 'native-translator', 'mt.gguf', 1500);
    const target = path.join(scratch, 'D', 'Kotomimi');
    const storage = createModelStorage({ userData, statfs: disk(10 ** 10), platform: 'linux', files: { ...fs, statSync: diffDrive(target) } });
    const seen = [];
    const after = await storage.move(target, { onProgress: (p) => seen.push(p) });
    expect(after).toMatchObject({ root: target, isDefault: false, usedBytes: 4500 });
    expect(statSync(path.join(target, 'native-engine', 'models', 'asr.gguf')).size).toBe(3000);
    expect(existsSync(path.join(userData, 'native-engine'))).toBe(false);
    expect(seen.at(-1)).toEqual({ copied: 4500, total: 4500 });
    // Read again by an app started afresh.
    expect(createModelStorage({ userData, statfs: disk(10 ** 10), platform: 'linux' }).root()).toBe(target);
    // And back: the default is written as none.
    await createModelStorage({ userData, statfs: disk(10 ** 10), platform: 'linux', files: { ...fs, statSync: diffDrive(target) } }).move(userData);
    expect(existsSync(path.join(userData, 'model-storage.json'))).toBe(false);
    expect(statSync(path.join(userData, 'native-translator', 'models', 'mt.gguf')).size).toBe(1500);
  });

  it('renames on one drive', async () => {
    model(userData, 'native-coach', 'gemma.gguf', 2000);
    model(userData, 'sherpa-engine', 'encoder-480ms.onnx', 1000);
    const target = path.join(scratch, 'Elsewhere');
    const storage = createModelStorage({ userData, statfs: disk(10 ** 10), platform: 'linux' });
    expect(storage.plan(target).sameDrive).toBe(true);
    await storage.move(target);
    expect(statSync(path.join(target, 'native-coach', 'models', 'gemma.gguf')).size).toBe(2000);
    expect(existsSync(path.join(userData, 'native-coach'))).toBe(false);
    expect(statSync(path.join(target, 'sherpa-engine', 'models', 'encoder-480ms.onnx')).size).toBe(1000);
    expect(existsSync(path.join(userData, 'sherpa-engine'))).toBe(false);
  });

  it('stopped halfway, leaves the models where they were and takes back what it copied', async () => {
    model(userData, 'native-engine', 'a.gguf', 3000);
    model(userData, 'native-engine', 'b.gguf', 3000);
    const target = path.join(scratch, 'D', 'Kotomimi');
    // A clock that moves a second each time it is read: every piece copied is told.
    let t = 0;
    const storage = createModelStorage({ userData, statfs: disk(10 ** 10), platform: 'linux', now: () => (t += 1000), files: { ...fs, statSync: diffDrive(target) } });
    const stop = new AbortController();
    const moving = storage.move(target, { signal: stop.signal, onProgress: ({ copied }) => { if (copied > 0) stop.abort(); } });
    await expect(moving).rejects.toMatchObject({ code: 'stopped' });
    expect(storage.root()).toBe(userData);
    expect(statSync(path.join(userData, 'native-engine', 'models', 'a.gguf')).size).toBe(3000);
    expect(existsSync(path.join(target, 'native-engine', 'models', 'a.gguf'))).toBe(false);
    expect(existsSync(path.join(target, 'native-engine', 'models', 'b.gguf'))).toBe(false);
  });

  it('does not write down a folder it could not use', () => {
    const storage = createModelStorage({ userData, statfs: disk(10 ** 10), platform: 'linux', files: { ...fs, mkdirSync: () => { throw new Error('EACCES'); } } });
    expect(storage.plan(path.join(scratch, 'locked')).error).toBe('not_writable');
    expect(readFileSync.bind(null, path.join(userData, 'model-storage.json'))).toThrow();
  });
});

/** `statSync` that puts everything under `target` on another drive. */
function diffDrive(target) {
  return (p, ...rest) => {
    const s = fs.statSync(p, ...rest);
    return path.resolve(p).startsWith(path.resolve(path.dirname(target))) ? Object.assign(Object.create(Object.getPrototypeOf(s)), s, { dev: s.dev + 1 }) : s;
  };
}
