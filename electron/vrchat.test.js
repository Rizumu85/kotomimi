// @vitest-environment node
// electron/vrchat.test.js
//
// Fork: VRChat on the same computer — read from a log written here, asked through a stand-in of its OSCQuery
// service, and told through a socket that only records.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createVRChat, readLine, chatboxMessage, forChatbox, CHATBOX_MOST } = require('./vrchat.js');

const made = [];
afterEach(() => {
  for (const one of made.splice(0)) {
    if (typeof one === 'string') fs.rmSync(one, { recursive: true, force: true });
    else one.stop();
  }
});

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const HEAD = [
  '2026.10.25 23:20:24 Debug      -  Advertising Service VRChat-Client-015F92 of type OSCQuery on 13945',
  '2026.10.25 23:20:24 Debug      -  Advertising Service VRChat-Client-015F92 of type OSC on 9000',
  "2026.10.25 23:20:30 Debug      -  [Video Playback] Attempting to resolve URL 'https://www.youtube.com/watch?v=old'",
].join('\n') + '\n';

function logDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-vrchat-'));
  made.push(dir);
  return dir;
}

describe('readLine', () => {
  it('reads the ports, a video begun and another world, and nothing else', () => {
    expect(readLine(HEAD.split('\n')[0])).toEqual({ kind: 'oscquery', port: 13945 });
    expect(readLine(HEAD.split('\n')[1])).toEqual({ kind: 'osc', port: 9000 });
    expect(readLine(HEAD.split('\n')[2])).toEqual({ kind: 'video', url: 'https://www.youtube.com/watch?v=old' });
    expect(readLine('2026.10.25 23:21:00 Debug      -  [Behaviour] Entering Room: Some World')).toEqual({ kind: 'world' });
    expect(readLine('2026.10.25 23:21:07 Debug      -  uSpeak [1][-1365083630]: Start Microphone: Loopback 1/2 (E2x2)')).toBeNull();
  });
});

describe('the chatbox', () => {
  it('is an OSC message: the address, its types and the text, each padded to four bytes', () => {
    const message = chatboxMessage('hi');
    expect(message.length % 4).toBe(0);
    expect(message.toString('latin1')).toBe('/chatbox/input\0\0,sTF\0\0\0\0hi\0\0');
  });

  it('takes its lines within its length, each on one line, cut at a whole character', () => {
    expect(forChatbox('  a \t b\n\n c  ')).toBe('a b\nc');
    const long = '漢'.repeat(CHATBOX_MOST + 10);
    expect([...forChatbox(long)].length).toBe(CHATBOX_MOST);
    expect(forChatbox(long).endsWith('…')).toBe(true);
  });
});

describe('createVRChat', () => {
  it('learns the ports from the log it finds, and tells of a video and a world only from then on', async () => {
    const dir = logDir();
    const log = path.join(dir, 'output_log_2026-10-25_23-20-18.txt');
    fs.writeFileSync(log, HEAD);
    const pushed = [];
    const vrchat = createVRChat({ push: (channel, payload) => pushed.push([channel, payload]), dir, tailEveryMs: 20, ask: async () => null });
    made.push(vrchat);
    expect(vrchat.state.found).toBe(true);
    expect(pushed.filter(([channel]) => channel === 'vrchat:video')).toEqual([]);
    fs.appendFileSync(log, "2026.10.26 00:38:17 Debug      -  [Video Playback] Attempting to resolve URL 'https://www.youtube.com/watch?v=new'\n");
    fs.appendFileSync(log, '2026.10.26 00:40:00 Debug      -  [Behaviour] Entering Room: Another\n');
    await tick(80);
    expect(pushed.filter(([channel]) => channel !== 'vrchat:state')).toEqual([
      ['vrchat:video', { url: 'https://www.youtube.com/watch?v=new' }],
      ['vrchat:world', {}],
    ]);
  });

  it('asks the mute while it is watched, at the port the log named, and stops when it is not', async () => {
    const dir = logDir();
    fs.writeFileSync(path.join(dir, 'output_log_a.txt'), HEAD);
    const asked = [];
    let muted = true;
    const pushed = [];
    const vrchat = createVRChat({
      push: (channel, payload) => pushed.push([channel, payload]), dir, muteEveryMs: 10,
      ask: async (port, pathname) => { asked.push([port, pathname]); return { VALUE: [muted] }; },
    });
    made.push(vrchat);
    vrchat.watch(true);
    await tick(30);
    expect(asked[0]).toEqual([13945, '/avatar/parameters/MuteSelf']);
    expect(vrchat.state).toEqual({ found: true, connected: true, muted: true });
    muted = false;
    await tick(40);
    expect(vrchat.state.muted).toBe(false);
    vrchat.watch(false);
    const count = asked.length;
    await tick(40);
    expect(asked.length).toBeLessThanOrEqual(count + 1);
  });

  it('is not connected where the service gives no mute: VRChat without OSC, or not running', async () => {
    const dir = logDir();
    fs.writeFileSync(path.join(dir, 'output_log_a.txt'), HEAD);
    const vrchat = createVRChat({ push: () => {}, dir, muteEveryMs: 10, ask: async () => null });
    made.push(vrchat);
    vrchat.watch(true);
    await tick(30);
    expect(vrchat.state).toEqual({ found: true, connected: false, muted: null });
  });

  it('sends a chatbox line to the port the log named', () => {
    const dir = logDir();
    fs.writeFileSync(path.join(dir, 'output_log_a.txt'), HEAD.replace('of type OSC on 9000', 'of type OSC on 9100'));
    const sent = [];
    const vrchat = createVRChat({ push: () => {}, dir, ask: async () => null, udp: () => ({ send: (buf, port, host) => sent.push([buf.toString('latin1'), port, host]), close() {} }) });
    made.push(vrchat);
    vrchat.chatbox('今日はいい天気ですね。');
    expect(sent).toHaveLength(1);
    expect(sent[0][1]).toBe(9100);
    expect(sent[0][2]).toBe('127.0.0.1');
  });
});

describe('createVRChat, at the edges the review found', () => {
  it('reads a line that was being written when the log was first seen, once it is whole', async () => {
    const dir = logDir();
    const log = path.join(dir, 'output_log_a.txt');
    fs.writeFileSync(log, HEAD + "2026.10.26 00:38:17 Debug      -  [Video Playback] Attempting to resolve URL 'https://www.youtube.com/watch?v=hal");
    const pushed = [];
    const vrchat = createVRChat({ push: (channel, payload) => pushed.push([channel, payload]), dir, tailEveryMs: 20, ask: async () => null });
    made.push(vrchat);
    fs.appendFileSync(log, "f'\r\n");
    await tick(80);
    expect(pushed.filter(([channel]) => channel === 'vrchat:video')).toEqual([['vrchat:video', { url: 'https://www.youtube.com/watch?v=half' }]]);
  });

  it('keeps one loop of asking however often it is stopped and started, and drops an answer from before', async () => {
    const dir = logDir();
    fs.writeFileSync(path.join(dir, 'output_log_a.txt'), HEAD);
    let calls = 0;
    const vrchat = createVRChat({
      push: () => {}, dir, muteEveryMs: 10,
      ask: async () => { calls += 1; await tick(15); return { VALUE: [true] }; },
    });
    made.push(vrchat);
    vrchat.watch(true);
    vrchat.watch(false);
    vrchat.watch(true);
    await tick(130);
    vrchat.watch(false);
    // One loop: an answer every 25 ms or so — two loops would be twice that.
    expect(calls).toBeLessThanOrEqual(7);
    expect(vrchat.state.muted).toBe(true);
  });
});
