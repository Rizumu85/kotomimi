// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { WebSocketServer } from 'ws';
const require = createRequire(import.meta.url);
const { openSherpa, languageOf, ENGINE, MODELS, RUNTIME, MODEL_ID, createSherpaEngine } = require('./sherpa-engine');

afterEach(() => vi.useRealTimers());

class Socket extends EventEmitter {
  static last;
  readyState = 0;
  bufferedAmount = 0;
  sent = [];
  constructor() { super(); Socket.last = this; }
  send(data) { this.sent.push(data); }
  close() { this.closed = true; }
  terminate() { this.closed = true; }
  open() { this.readyState = 1; this.emit('open'); }
  result(value) { this.emit('message', Buffer.from(JSON.stringify(value))); }
}

describe('the CPU transducer wire', () => {
  it('queues PCM until connected, converts exactly to floats, flushes once, and settles only at EOF', () => {
    const events = [];
    const stream = openSherpa({ port: 1, sampleRate: 16000 }, (e) => events.push(e), Socket);
    const socket = Socket.last;
    const pcm = Buffer.alloc(6);
    [-32768, 0, 16384].forEach((value, i) => pcm.writeInt16LE(value, i * 2));
    stream.write(pcm); stream.end(); stream.end(); socket.open();
    expect([...Array(3)].map((_, i) => socket.sent[0].readFloatLE(i * 4))).toEqual([-1, 0, .5]);
    expect(socket.sent.slice(1)).toEqual(['Done']);
    socket.result({ text: '你好， 世界', is_final: false });
    socket.result({ text: '你好， 世界', is_final: true });
    expect(events).toEqual([{ type: 'partial', text: '你好，世界' }]);
    socket.result({ text: '你好，世界。', is_eof: true });
    socket.result({ text: 'late', is_eof: true });
    expect(events.at(-1)).toEqual({ type: 'done', text: '你好，世界。', language: 'zh' });
    expect(events).toHaveLength(2);
    expect(socket.closed).toBe(true);
  });

  it('reports malformed results, premature closure, invalid rates and backpressure once', () => {
    for (const provoke of [
      (s) => s.emit('message', Buffer.from('bad')),
      (s) => s.result({}),
      (s) => s.emit('close'),
      (s, stream) => { s.bufferedAmount = 2e6; stream.write(Buffer.alloc(2)); },
      (s, stream) => stream.write(Buffer.alloc(1)),
    ]) {
      const events = [];
      const stream = openSherpa({ port: 1, sampleRate: 16000 }, (e) => events.push(e), Socket);
      provoke(Socket.last, stream);
      Socket.last.emit('error', new Error('again'));
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('error');
    }
    const events = [];
    openSherpa({ port: 1, sampleRate: 48000 }, (e) => events.push(e), Socket);
    Socket.last.open();
    expect(events[0].type).toBe('error');
  });

  it('aborts silently and bounds the wait for last words', () => {
    vi.useFakeTimers();
    const events = [];
    const stream = openSherpa({ port: 1, sampleRate: 16000 }, (e) => events.push(e), Socket);
    stream.end(); stream.abort(); Socket.last.open();
    vi.advanceTimersByTime(20000);
    expect(events).toEqual([]);
    const next = openSherpa({ port: 1, sampleRate: 16000 }, (e) => events.push(e), Socket);
    next.end(); vi.advanceTimersByTime(15000);
    expect(events).toEqual([{ type: 'error', message: expect.stringContaining('in time') }]);
  });

  it('speaks the real WebSocket protocol on independent concurrent connections', async () => {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((resolve) => server.once('listening', resolve));
    server.on('connection', (socket) => socket.on('message', (data, binary) => {
      if (binary) {
        expect(data.readFloatLE(0)).toBe(.5);
        socket.send(JSON.stringify({ text: 'Hello', is_eof: false }));
      } else if (String(data) === 'Done') socket.send(JSON.stringify({ text: 'Hello!', is_eof: true }));
    }));
    try {
      const run = () => new Promise((resolve, reject) => {
        const events = [];
        const stream = openSherpa({ port: server.address().port, sampleRate: 16000 }, (event) => {
          events.push(event);
          if (event.type === 'error') reject(new Error(event.message));
          if (event.type === 'done') resolve(events);
        });
        const pcm = Buffer.alloc(2); pcm.writeInt16LE(16384);
        stream.write(pcm); stream.end();
      });
      const results = await Promise.all([run(), run()]);
      for (const events of results) expect(events).toEqual([{ type: 'partial', text: 'Hello' }, { type: 'done', text: 'Hello!', language: 'en' }]);
    } finally { for (const socket of server.clients) socket.terminate(); await new Promise((resolve) => server.close(resolve)); }
  });
});

describe('the pinned sherpa runtime and model', () => {
  it('offers exactly the two native CPU builds and a complete four-file model', () => {
    expect(Object.keys(ENGINE.builds)).toEqual(['win32-x64', 'darwin-arm64']);
    expect(MODELS[MODEL_ID].files).toHaveLength(4);
    expect(MODELS[MODEL_ID].bytes).toBe(614596718);
    for (const part of MODELS[MODEL_ID].files) {
      expect(part.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(part.url).toContain('/689ff18c584d29910da37b6fe904db0c1489c9d1/');
    }
    expect(RUNTIME.launch({ port: 6006 })).toEqual(expect.arrayContaining(['--provider=cpu', '--num-threads=1', '--num-work-threads=1', '--enable-endpoint=false']));
    expect(createSherpaEngine({ dir: '.', platform: 'linux', arch: 'x64' }).status().supported).toBe(false);
  });
  it('labels only text in the two supported scripts, with mixed Chinese retained as Chinese', () => {
    expect(languageOf('你好 VRChat')).toBe('zh');
    expect(languageOf('Hello!')).toBe('en');
    expect(languageOf('123…')).toBeNull();
  });
});
