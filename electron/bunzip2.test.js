// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bunzip2 = require('./bunzip2.js');
const { untar, systemTar } = require('./native-engine.js');
const HELLO = 'QlpoOTFBWSZTWcHAgOIAAAFBAAAQAkSgADDNAMNGKZcXckU4UJDBwIDi';
const EMPTY = 'QlpoORdyRThQkAAAAAA=';
const MULTIBLOCK = 'QlpoMTFBWSZTWS+VPfUAAF8BgD///4AwAZgAFABiNNNGhQAYjTTRoFJVQA0HoCcKU4Ht5SqA5qqYYlAdFKaMVQHVSmGlUB2qUwxVAd1KaNKoDwpTDSqA+VKYaVQH0qpoxKA5KUw0qgPtVTDEoDkpTRiqA/FKYaVQH6pbAMMVQH8pTRpVAcKqYYlAc1KaMVQHRVTRiUB1UphiqA7KU0YqgO9SmjFUB4UphpVAeFKaMVQH+YoKyTKaz0kCsLADAAgMAf///AGADMAAoAMRppo0KADEaaaNApKqAGIwE5lU5jKUB0kLRlSA6lUw1SgOxK2EYZSgO5VNGUoDwVTDKUB5KpoylAfRVNGUoD7kLDKkB+FU0ZSgOEhaMqQHEqmGkqHHQKpyKpoylAfpVMNUoD+KphlKA5yFoypAdCqYapQHWQsMqQHYqmjVKA7lUw1SgPBVMMpQHkqmjKUBwKphqlAf5igrJMprLIddfwAXXjAwB///8AYAMwACgAxGmmjQoAMRppo0CkqoAND0BOEqcRoqA5oLDBQHRKmjCoDqlTDJUB2SphhUB3Spo0VAeEqYaKgPhKmGioD5QWjBQH0lTDRUB9oLDBQHJKmjCoD8SphkqA/UqYYVAfyVNGioDhBYYKA5pUw1UU2iUl0QWjBQHVKmGFQHZKmjRUB3SpowqA8JUw0VAeITlhLyjCoD/MUFZJlNZoqqsZQAADQGAP///gCAAMUAGI000aCKoDQNGAkibQqWbmGBw8nRTxievxJmUYFSzcw/i7kinChIWXvmM4A=';

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-bunzip2-')); });
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

function paths(bytes) {
  const source = path.join(dir, 'engine.tar.bz2');
  const destination = path.join(dir, 'engine.tar');
  fs.writeFileSync(source, bytes);
  return { source, destination };
}

describe('bunzip2', () => {
  it.each([
    ['hello', HELLO, Buffer.from('hello\n')],
    ['empty', EMPTY, Buffer.alloc(0)],
  ])('decompresses the %s fixture exactly', async (_, compressed, expected) => {
    const { source, destination } = paths(Buffer.from(compressed, 'base64'));
    await bunzip2(source, destination);
    expect(fs.readFileSync(destination)).toEqual(expected);
  });

  it('decompresses several blocks exactly and gives the event loop time between them', async () => {
    const { source, destination } = paths(Buffer.from(MULTIBLOCK, 'base64'));
    const expected = Buffer.from(Array.from({ length: 300000 }, (_, i) => 97 + ((i * 7 + (i >> 9)) % 23)));
    const yielded = vi.spyOn(globalThis, 'setImmediate');
    await bunzip2(source, destination);
    const actual = fs.readFileSync(destination);
    expect(actual).toEqual(expected);
    expect(crypto.createHash('sha256').update(actual).digest('hex')).toBe('8910267a2c19845a0bee5cdcd457d3c9e83317d83b06474de5d17fb55462029e');
    expect(yielded.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it('expands the final run-length layer beyond the block size', async () => {
    // One million copies of "a", compressed with libbz2 at level 9.
    const { source, destination } = paths(Buffer.from('QlpoOTFBWSZTWZe+3DgAB6iBQKAAAAIACCAAMMwJqmmVJDapSQ8XckU4UJCXvtw4', 'base64'));
    await bunzip2(source, destination);
    expect(fs.readFileSync(destination)).toEqual(Buffer.alloc(1000000, 97));
  });

  it.each(['not bzip2', 'truncated', 'flipped data', 'block CRC', 'combined CRC', 'randomised'])('rejects %s', async (damage) => {
    let bytes = Buffer.from(HELLO, 'base64');
    if (damage === 'not bzip2') bytes = Buffer.from('not a bzip2 file');
    if (damage === 'truncated') bytes = bytes.subarray(0, bytes.length - 5);
    if (damage === 'flipped data') bytes[30] ^= 1;
    if (damage === 'block CRC') bytes[10] ^= 1;
    if (damage === 'combined CRC') bytes[bytes.length - 1] ^= 1;
    if (damage === 'randomised') bytes[14] |= 128;
    const { source, destination } = paths(bytes);
    await expect(bunzip2(source, destination)).rejects.toThrow(
      damage === 'block CRC' ? /block CRC/ : damage === 'combined CRC' ? /combined CRC/ : Error,
    );
  });
});

describe('untar', () => {
  it.each([false, true])('decompresses on Windows and removes the tar (tar fails: %s)', async (fails) => {
    const { source, destination } = paths(Buffer.from(HELLO, 'base64'));
    const into = path.join(dir, 'engine');
    fs.mkdirSync(into);
    const decompress = vi.fn(bunzip2);
    const failure = new Error('tar failed');
    const run = vi.fn((program, args, options, done) => {
      expect(program).toBe(systemTar('win32'));
      expect(args).toEqual(['-xf', path.relative(into, destination), '-C', '.']);
      expect(options).toEqual({ cwd: into, windowsHide: true });
      expect(fs.readFileSync(destination, 'utf8')).toBe('hello\n');
      done(fails ? failure : null);
    });
    const unpacking = untar(source, into, { platform: 'win32', run, decompress });
    if (fails) await expect(unpacking).rejects.toBe(failure);
    else await unpacking;
    expect(decompress).toHaveBeenCalledWith(source, destination);
    expect(run).toHaveBeenCalledOnce();
    expect(fs.existsSync(destination)).toBe(false);
    expect(fs.existsSync(source)).toBe(true);
  });

  it('removes a partial tar when decompression fails, without starting tar', async () => {
    const bytes = Buffer.from(HELLO, 'base64');
    bytes[bytes.length - 1] ^= 1;
    const { source, destination } = paths(bytes);
    const run = vi.fn();
    await expect(untar(source, dir, { platform: 'win32', run })).rejects.toThrow(/CRC/);
    expect(run).not.toHaveBeenCalled();
    expect(fs.existsSync(destination)).toBe(false);
  });

  it.each([
    ['win32', 'engine.zip'], ['win32', 'engine.tar.gz'],
    ['darwin', 'engine.tar.bz2'], ['linux', 'engine.tar.bz2'],
  ])('leaves %s %s to the system tar', async (platform, name) => {
    const archive = path.join(dir, name);
    const decompress = vi.fn();
    const run = vi.fn((program, args, options, done) => done(null));
    await untar(archive, dir, { platform, run, decompress });
    expect(decompress).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith(systemTar(platform), ['-xf', name, '-C', '.'], { cwd: dir, windowsHide: true }, expect.any(Function));
  });
});
