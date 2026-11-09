// @vitest-environment node
// electron/remote-engine.test.js
//
// Fork: a recognition engine on another device. No network here: the readings are what the test answers, and the
// window is the real one (`openWindow`), so that what is asked of the other device is what would be.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createRemoteEngine, targetOf, saidFor } = require('./remote-engine.js');

/** Half a second of a tone at 16 kHz, as the page sends it. */
const sound = (seconds = 0.5) => {
  const pcm = Buffer.alloc(Math.round(16000 * seconds) * 2);
  for (let i = 0; i < pcm.length / 2; i += 1) pcm.writeInt16LE(Math.round(Math.sin(i / 8) * 8000), i * 2);
  return pcm;
};

describe('where another device is asked', () => {
  it('is the address the user gave, with the path of a transcription under it', () => {
    expect(targetOf('http://192.168.1.23:8792/v1')).toEqual({ host: '192.168.1.23', port: 8792, pathname: '/v1/audio/transcriptions' });
    expect(targetOf(' http://phone.local:8792/v1/ ')).toEqual({ host: 'phone.local', port: 8792, pathname: '/v1/audio/transcriptions' });
    expect(targetOf('http://10.0.0.5')).toEqual({ host: '10.0.0.5', port: 80, pathname: '/audio/transcriptions' });
  });

  it('is nowhere for what is not a plain http address', () => {
    for (const base of ['', 'not an address', 'https://192.168.1.23:8792/v1', 'file:///c:/x', 'http://user:secret@192.168.1.23/v1', null, undefined]) expect(targetOf(base)).toBeNull();
  });
});

describe('how a model is told the language', () => {
  it('is the way this computer tells the same model', () => {
    expect(saidFor('qwen3-asr-0.6b-q8', 'ja')).toBe('ja');
    expect(saidFor('nemotron-asr-0.6b-q8', 'ja')).toBe('ja-JP');
    expect(saidFor('r2t2-q8', 'ja')).toBe('Japanese');
    // SenseVoice-Small, which a phone lends under the name this computer has it by: its bare code, as before this
    // computer knew the name.
    expect(saidFor('sensevoice-small-q8', 'ja-JP')).toBe('ja');
    expect(saidFor('sensevoice-small-q8', 'zh-TW')).toBe('zh');
  });

  it('is the code as it is for a model this computer does not know, and nothing where no language is given', () => {
    expect(saidFor('some-other-model', 'ko')).toBe('ko');
    expect(saidFor('qwen3-asr-0.6b-q8', '')).toBeUndefined();
  });
});

describe('a recognition on another device', () => {
  it('reads the stretch at the device, and gives the page what it wrote', async () => {
    const asked = [];
    const events = [];
    const engine = createRemoteEngine({
      onStream: (event) => events.push(event),
      read: (request) => { asked.push(request); return { done: Promise.resolve({ ok: true, text: 'こんにちは' }), abort() {} }; },
    });
    const id = engine.openStream({ base: 'http://192.168.1.23:8792/v1', model: 'qwen3-asr-0.6b-q8', language: 'ja', sampleRate: 16000 });
    expect(id).toBe(1);
    expect(engine.writeStream(id, sound())).toBe(true);
    engine.endStream(id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ host: '192.168.1.23', port: 8792, pathname: '/v1/audio/transcriptions', model: 'qwen3-asr-0.6b-q8', language: 'ja', sampleRate: 16000 });
    expect(asked[0].pcm.length).toBe(sound().length);
    expect(events).toEqual([{ id: 1, type: 'done', text: 'こんにちは' }]);
    // Over: nothing more is taken for it.
    expect(engine.writeStream(id, sound())).toBe(false);
  });

  it('tells a model that takes them the dictionary’s words, as this computer’s own engine is told, and drops the list said back', async () => {
    const asked = [];
    const events = [];
    const engine = createRemoteEngine({
      onStream: (event) => events.push(event),
      read: (request) => { asked.push(request); return { done: Promise.resolve({ ok: true, text: 'Rizum、VRC' }), abort() {} }; },
    });
    const id = engine.openStream({ base: 'http://192.168.1.23:8792/v1', model: 'qwen3-asr-1.7b-q8', language: 'zh', sampleRate: 16000, hints: ['Rizum', 'VRC', 7] });
    engine.writeStream(id, sound());
    engine.endStream(id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(asked[0].context).toBe('可能出现的人名和词语：Rizum、VRC');
    // The list itself, with no voice behind it, is nothing heard.
    expect(events).toEqual([{ id, type: 'done', text: '' }]);
    // A model that takes no words is told none.
    const plain = [];
    const other = createRemoteEngine({ read: (request) => { plain.push(request); return { done: Promise.resolve({ ok: true, text: 'x' }), abort() {} }; } });
    const two = other.openStream({ base: 'http://192.168.1.23:8792/v1', model: 'r2t2-q8', language: 'zh', sampleRate: 16000, hints: ['Rizum'] });
    other.writeStream(two, sound());
    other.endStream(two);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(plain[0].context).toBeUndefined();
  });

  it('takes a model’s spaces out of what the device wrote, where this computer does so with its own readings of that model', async () => {
    const texts = (model) => new Promise((resolve) => {
      const events = [];
      const engine = createRemoteEngine({
        onStream: (event) => { events.push(event); if (event.type === 'done') resolve(events.map((one) => one.text)); },
        read: () => ({ done: Promise.resolve({ ok: true, text: '元 は 金持ち の 息子 でし たが。' }), abort() {} }),
      });
      const id = engine.openStream({ base: 'http://192.168.1.23:8792/v1', model, language: 'ja', sampleRate: 16000 });
      engine.writeStream(id, sound());
      engine.endStream(id);
    });
    // The phone takes them out itself; one that did not would still read the same here.
    expect(await texts('sensevoice-small-q8')).toEqual(['元は金持ちの息子でしたが。']);
    // Any other model's text is passed on as it came.
    expect(await texts('qwen3-asr-0.6b-q8')).toEqual(['元 は 金持ち の 息子 でし たが。']);
    expect(await texts('some-other-model')).toEqual(['元 は 金持ち の 息子 でし たが。']);
  });

  it('says so when the device does not answer', async () => {
    const events = [];
    const engine = createRemoteEngine({
      onStream: (event) => events.push(event),
      read: () => ({ done: Promise.resolve({ ok: false, message: 'connect ECONNREFUSED 192.168.1.23:8792' }), abort() {} }),
    });
    const id = engine.openStream({ base: 'http://192.168.1.23:8792/v1', model: 'qwen3-asr-0.6b-q8', language: 'ja', sampleRate: 16000 });
    engine.writeStream(id, sound());
    engine.endStream(id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events.at(-1)).toMatchObject({ id, type: 'error', message: 'connect ECONNREFUSED 192.168.1.23:8792' });
  });

  it('opens none for an address that is not one, or a model that is not named', () => {
    const engine = createRemoteEngine();
    expect(engine.openStream({ base: 'https://example.com/v1', model: 'qwen3-asr-0.6b-q8' })).toBeNull();
    expect(engine.openStream({ base: 'http://192.168.1.23:8792/v1', model: '' })).toBeNull();
    expect(engine.openStream()).toBeNull();
  });

  it('drops every recognition when the page is gone', () => {
    const aborted = [];
    const engine = createRemoteEngine({ window: () => ({ write() {}, end() {}, abort() { aborted.push(true); } }) });
    const first = engine.openStream({ base: 'http://192.168.1.23:8792/v1', model: 'm' });
    const second = engine.openStream({ base: 'http://192.168.1.23:8792/v1', model: 'm' });
    engine.stop();
    expect(aborted).toHaveLength(2);
    expect(engine.writeStream(first, sound())).toBe(false);
    expect(engine.writeStream(second, sound())).toBe(false);
  });
});

describe('a stretch a device hears while it is spoken (the iPad\'s own recognition)', () => {
  const { liveStretch } = require('./remote-engine.js');
  const { EventEmitter } = require('node:events');
  const target = { host: '192.168.4.30', port: 8792, pathname: '/v1/audio/transcriptions', key: 'k3y' };

  /** A WebSocket the test drives: what the stretch sends, and the device's answers. */
  function fakeSocket() {
    const made = [];
    class Socket extends EventEmitter {
      constructor(url, options) { super(); this.url = url; this.options = options; this.sent = []; this.closed = false; made.push(this); }
      send(data) { this.sent.push(data); }
      close() { this.closed = true; }
      say(event) { this.emit('message', Buffer.from(JSON.stringify(event)), false); }
    }
    return { Socket, made };
  }

  it('opens one socket at the device\'s address with its key, and tells it the languages', () => {
    const { Socket, made } = fakeSocket();
    liveStretch({ target, language: 'ja', also: 'en', prefer: 'ja', sampleRate: 16000 }, () => {}, { Socket });
    expect(made[0].url).toBe('ws://192.168.4.30:8792/v1/audio/stream');
    expect(made[0].options.headers).toEqual({ Authorization: 'Bearer k3y' });
    made[0].emit('open');
    expect(JSON.parse(made[0].sent[0])).toEqual({ type: 'open', language: 'ja', also: 'en', prefer: 'ja', sampleRate: 16000 });
  });

  it('holds the sound until the device is ready, then sends it as it comes, and the end after it', () => {
    const { Socket, made } = fakeSocket();
    const stretch = liveStretch({ target, language: 'ja', sampleRate: 16000 }, () => {}, { Socket });
    const socket = made[0];
    socket.emit('open');
    stretch.write(sound(0.1));
    stretch.end();
    expect(socket.sent).toHaveLength(1);
    socket.say({ type: 'ready' });
    expect(socket.sent.slice(1).map((m) => (Buffer.isBuffer(m) ? 'pcm' : JSON.parse(m).type))).toEqual(['pcm', 'end']);
  });

  it('passes on what is heard so far, and ends with the text and the language it was in', () => {
    const { Socket, made } = fakeSocket();
    const events = [];
    liveStretch({ target, language: 'ja', also: 'en', sampleRate: 16000 }, (e) => events.push(e), { Socket });
    const socket = made[0];
    socket.emit('open');
    socket.say({ type: 'ready' });
    socket.say({ type: 'partial', text: 'hello' });
    socket.say({ type: 'delta', text: '' });
    socket.say({ type: 'final', text: 'Hello there.', language: 'en' });
    socket.emit('close');
    expect(events).toEqual([{ type: 'partial', text: 'hello' }, { type: 'done', text: 'Hello there.', language: 'en' }]);
    expect(socket.closed).toBe(true);
  });

  it('ends with an error, once, where the device refuses or goes away first', () => {
    const { Socket, made } = fakeSocket();
    const refused = [];
    liveStretch({ target, language: 'ja', sampleRate: 16000 }, (e) => refused.push(e), { Socket });
    made[0].say({ type: 'error', message: 'Japanese is not downloaded on this device.' });
    made[0].emit('close');
    expect(refused).toEqual([{ type: 'error', message: 'Japanese is not downloaded on this device.' }]);
    const gone = [];
    liveStretch({ target, language: 'ja', sampleRate: 16000 }, (e) => gone.push(e), { Socket });
    made[1].emit('close');
    expect(gone).toEqual([{ type: 'error', message: 'The device closed the stretch before it finished.' }]);
  });

  it('is what the engine opens for a device that streams, and the window for one that does not', () => {
    const asked = [];
    const engine = createRemoteEngine({ live: (args) => { asked.push(args); return { write() {}, end() {}, abort() {} }; }, window: () => { asked.push('window'); return { write() {}, end() {}, abort() {} }; } });
    expect(engine.openStream({ base: 'http://192.168.4.30:8792/v1', model: 'apple-speech', language: 'ja-JP', also: ['en'], prefer: 'ja', sampleRate: 16000, streamed: true })).toBe(1);
    expect(asked[0]).toMatchObject({ language: 'ja', also: 'en', prefer: 'ja', sampleRate: 16000, target: { host: '192.168.4.30', port: 8792 } });
    engine.openStream({ base: 'http://192.168.4.30:8792/v1', model: 'apple-speech', language: 'ja', sampleRate: 16000 });
    expect(asked[1]).toBe('window');
  });

  it('speaks to a real WebSocket server as the iPad answers', async () => {
    const { WebSocketServer } = require('ws');
    const server = new WebSocketServer({ port: 0 });
    const port = server.address().port;
    const got = { headers: null, open: null, bytes: 0 };
    server.on('connection', (socket, request) => {
      got.headers = request.headers;
      socket.on('message', (data, binary) => {
        if (binary) { got.bytes += data.length; return; }
        const message = JSON.parse(String(data));
        if (message.type === 'open') { got.open = message; socket.send(JSON.stringify({ type: 'ready' })); }
        if (message.type === 'end') socket.send(JSON.stringify({ type: 'final', text: 'こんにちは。', language: 'ja' }));
      });
    });
    const done = new Promise((resolve) => {
      const stretch = liveStretch({ target: { host: '127.0.0.1', port, pathname: '/v1/audio/transcriptions', key: 'k3y' }, language: 'ja', sampleRate: 16000 }, (e) => { if (e.type !== 'partial') resolve(e); });
      stretch.write(sound(0.5));
      stretch.end();
    });
    expect(await done).toEqual({ type: 'done', text: 'こんにちは。', language: 'ja' });
    expect(got.headers.authorization).toBe('Bearer k3y');
    expect(got.open).toEqual({ type: 'open', language: 'ja', sampleRate: 16000 });
    expect(got.bytes).toBe(16000);
    await new Promise((resolve) => server.close(resolve));
  });
});
