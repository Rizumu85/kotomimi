/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { downloadInstaller, checkable } = require('./update-download.js');

const INSTALLER = Buffer.from('an installer, in a few bytes — enough to be cut in two and joined again');
const SHA512 = crypto.createHash('sha512').update(INSTALLER).digest('base64');
const URL_ = 'https://github.com/Rizumu85/kotomimi/releases/download/v9.9.9/Kotomimi-9.9.9.Setup.exe';

let dir;
let dest;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-update-')); dest = path.join(dir, 'Setup.exe'); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const answer = (bytes, status = 200) => new Response(new Uint8Array(bytes), { status });
/** A network: who was asked, and what each host serves from the place asked for. */
const network = (serve) => {
  const asked = [];
  const fetch = async (url, init = {}) => {
    const from = init.headers?.Range ? Number(/bytes=(\d+)-/.exec(init.headers.Range)[1]) : 0;
    asked.push([new URL(url).host, from]);
    return serve(new URL(url).host, from, url);
  };
  return { asked, fetch };
};
const whole = (host, from) => answer(INSTALLER.subarray(from), from > 0 ? 206 : 200);

describe('the installer of an update', () => {
  it('is fetched from GitHub where GitHub answers, and kept when it is what the release describes', async () => {
    const { asked, fetch } = network(whole);
    const progress = [];
    await downloadInstaller({ url: URL_, sha512: SHA512, size: INSTALLER.length, dest, fetch, mirrorFirst: () => false, onProgress: (received, total) => progress.push([received, total]) });
    expect(fs.readFileSync(dest)).toEqual(INSTALLER);
    expect(asked).toEqual([['github.com', 0]]);
    expect(progress.at(-1)).toEqual([INSTALLER.length, INSTALLER.length]);
    expect(fs.existsSync(`${dest}.part`)).toBe(false);
  });

  it('is asked of a relay first where GitHub is not reached, by the release file\'s whole address', async () => {
    const seen = [];
    const { asked, fetch } = network((host, from, url) => { seen.push(url); return whole(host, from); });
    await downloadInstaller({ url: URL_, sha512: SHA512, size: INSTALLER.length, dest, fetch, mirrorFirst: () => true });
    expect(asked).toEqual([['ghfast.top', 0]]);
    expect(seen[0]).toBe(`https://ghfast.top/${URL_}`);
    expect(fs.readFileSync(dest)).toEqual(INSTALLER);
  });

  it('goes on at a relay from what GitHub brought before it broke off', async () => {
    const { asked, fetch } = network((host, from) => (host === 'github.com' ? answer(INSTALLER.subarray(0, 12)) : whole(host, from)));
    await downloadInstaller({ url: URL_, sha512: SHA512, size: INSTALLER.length, dest, fetch, mirrorFirst: () => false });
    expect(fs.readFileSync(dest)).toEqual(INSTALLER);
    expect(asked).toEqual([['github.com', 0], ['github.com', 12], ['ghfast.top', 12]]);
  });

  it('does not keep, and so cannot run, a file a relay made up — the right length or not', async () => {
    const forged = Buffer.from(INSTALLER);
    forged[5] ^= 0xff;
    const { fetch } = network((host, from) => answer(forged.subarray(from), from > 0 ? 206 : 200));
    await expect(downloadInstaller({ url: URL_, sha512: SHA512, size: INSTALLER.length, dest, fetch, mirrorFirst: () => true }))
      .rejects.toThrow('not the one the release describes');
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.existsSync(`${dest}.part`)).toBe(false);
  });

  it('checks what an earlier, stopped download left as well', async () => {
    fs.writeFileSync(`${dest}.part`, Buffer.concat([Buffer.from('not the start of it!'), INSTALLER.subarray(20, 30)]));
    const { asked, fetch } = network(whole);
    await expect(downloadInstaller({ url: URL_, sha512: SHA512, size: INSTALLER.length, dest, fetch, mirrorFirst: () => false })).rejects.toThrow('not the one the release describes');
    expect(asked).toEqual([['github.com', 30]]);
    // The next attempt starts clean, and arrives.
    await downloadInstaller({ url: URL_, sha512: SHA512, size: INSTALLER.length, dest, fetch, mirrorFirst: () => false });
    expect(fs.readFileSync(dest)).toEqual(INSTALLER);
  });

  it('says who was asked when nobody serves it', async () => {
    const { fetch } = network(() => answer([], 404));
    await expect(downloadInstaller({ url: URL_, sha512: SHA512, size: INSTALLER.length, dest, fetch, mirrorFirst: () => false }))
      .rejects.toThrow('github.com: The download answered HTTP 404. · ghfast.top: The download answered HTTP 404.');
  });

  it('asks nobody for a release that does not say what its installer should be', async () => {
    const { asked, fetch } = network(whole);
    expect(checkable({ sha512: SHA512, size: INSTALLER.length })).toBe(true);
    expect(checkable({ sha512: '', size: INSTALLER.length })).toBe(false);
    expect(checkable({ sha512: SHA512 })).toBe(false);
    await expect(downloadInstaller({ url: URL_, dest, fetch })).rejects.toThrow('does not say');
    expect(asked).toEqual([]);
  });
});
