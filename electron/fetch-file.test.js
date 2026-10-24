/**
 * @vitest-environment node
 */
// Fork: which of a file's addresses is asked first.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { pullWhole, quickestFirst, TRIAL_WORTH } = require('./fetch-file.js');

const GITHUB = 'https://github.com/o/r/releases/download/v1/file.bin';
const RELAY = `https://ghfast.top/${GITHUB}`;
const OTHER = `https://gh-proxy.com/${GITHUB}`;

/** An answer that brings `count` bytes, `each` at a time with `everyMs` between: stopped when its request is. */
const trickle = (count, each, everyMs, signal) => {
  let sent = 0;
  let timer = null;
  const body = new ReadableStream({
    start(controller) {
      signal?.addEventListener('abort', () => { clearTimeout(timer); try { controller.error(new Error('aborted')); } catch { /* closed already */ } }, { once: true });
    },
    pull(controller) {
      if (sent >= count) { controller.close(); return undefined; }
      return new Promise((resolve) => {
        timer = setTimeout(() => {
          const size = Math.min(each, count - sent);
          sent += size;
          try { controller.enqueue(new Uint8Array(size)); } catch { /* cancelled meanwhile */ }
          resolve();
        }, everyMs);
      });
    },
    cancel() { clearTimeout(timer); },
  });
  return new Response(body, { status: 206 });
};

/** A network where each host brings so many bytes every ten milliseconds, or does as `odd` says. */
const network = (speeds, odd = {}) => {
  const asked = [];
  const fetch = async (url, init = {}) => {
    const host = new URL(url).host;
    asked.push([host, init.headers?.Range ?? '']);
    if (odd[host]) return odd[host](init);
    const [from, to] = /bytes=(\d+)-(\d*)/.exec(init.headers.Range).slice(1).map(Number);
    return trickle(to - from + 1, speeds[host], 10, init.signal);
  };
  return { asked, fetch };
};

describe('which address of a file is asked first', () => {
  it('is the one that brings the most in the time, whatever order they were guessed in', async () => {
    const { asked, fetch } = network({ 'ghfast.top': 500, 'gh-proxy.com': 2_000, 'github.com': 20_000 });
    const order = await quickestFirst({ sources: [RELAY, OTHER, GITHUB], from: 4_000, bytes: 10_000_000, fetch, trialBytes: 40_000, trialMs: 2_000, restMs: 60 });
    expect(order).toEqual([GITHUB, OTHER, RELAY]);
    // Each is asked for the same stretch, from where the download stands.
    expect(asked).toEqual([['ghfast.top', 'bytes=4000-43999'], ['gh-proxy.com', 'bytes=4000-43999'], ['github.com', 'bytes=4000-43999']]);
  });

  it('keeps the guessed order among those that brought nothing: a page, a refusal, no answer', async () => {
    const never = (init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    const page = () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } });
    const { fetch } = network({ 'gh-proxy.com': 5_000 }, { 'ghfast.top': never, 'github.com': page });
    const order = await quickestFirst({ sources: [RELAY, GITHUB, OTHER], bytes: 10_000_000, fetch, trialBytes: 20_000, trialMs: 1_000, restMs: 40 });
    expect(order).toEqual([OTHER, RELAY, GITHUB]);
  });

  it('is over when the time is up though nobody has brought its share', async () => {
    const { fetch } = network({ 'ghfast.top': 10, 'github.com': 30 });
    const began = Date.now();
    const order = await quickestFirst({ sources: [RELAY, GITHUB], bytes: 10_000_000, fetch, trialBytes: 1_000_000, trialMs: 150, restMs: 50 });
    expect(Date.now() - began).toBeLessThan(1_000);
    expect(order).toEqual([GITHUB, RELAY]);
  });
});

describe('a file fetched from several addresses', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-fetch-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const serving = (asked) => async (url, init = {}) => {
    const from = init.headers?.Range ? Number(/bytes=(\d+)-/.exec(init.headers.Range)[1]) : 0;
    asked.push(new URL(url).host);
    return new Response(new Uint8Array(64 - from), { status: from > 0 ? 206 : 200 });
  };

  it('is begun at the quickest address when it is large, and at the first one given when it is small', async () => {
    const tried = [];
    const trial = async ({ sources, from, bytes }) => { tried.push([sources.length, from, bytes]); return [...sources].reverse(); };
    // (The file itself is small here: what counts as large is said to the download, not served.)
    const asked = [];
    await pullWhole({ sources: [RELAY, GITHUB], part: path.join(dir, 'small.part'), bytes: 64, fetch: serving(asked), trial });
    expect(tried).toEqual([]);
    expect(asked).toEqual(['ghfast.top']);
    expect(TRIAL_WORTH).toBeGreaterThan(1024 * 1024);

    const large = [];
    await pullWhole({ sources: [RELAY, GITHUB], part: path.join(dir, 'large.part'), bytes: 64, fetch: serving(large), trial, trialWorth: 32 });
    expect(tried).toEqual([[2, 0, 64]]);
    expect(large).toEqual(['github.com']);
  });

  it('asks nobody twice to find the quickest of one address', async () => {
    const tried = [];
    const asked = [];
    await pullWhole({ sources: [GITHUB], part: path.join(dir, 'one.part'), bytes: 64, fetch: serving(asked), trial: async (given) => { tried.push(given); return given.sources; } });
    expect(tried).toEqual([]);
    expect(asked).toEqual(['github.com']);
  });
});
