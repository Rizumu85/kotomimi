// @vitest-environment node
// electron/native-engines.test.js
//
// Fork: a Mac's two native recognizers, joined (`joinEngines`). The engines
// here are stand-ins that answer as the real ones do: the system's own
// recognition, ready as soon as it is asked, and the runtime the app
// downloads, which has to be fetched and brought up.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { joinEngines } = require('./native-engines.js');

const STOPPED = { state: 'stopped', model: null, port: 0, tail: '' };
const downloaded = { state: 'downloaded', received: 1, total: 1 };
const absent = { state: 'absent', received: 0, total: 1 };

/** An engine with these models, in the shape both real ones have; `log` takes what it was asked. */
function standIn(name, { models, engine = 'ready', supported = true, log }) {
  return (tell) => {
    const self = { tell, state: { supported, engine, engineBytes: 0, models: { ...models }, run: STOPPED, up: [] }, streams: [], next: 1 };
    const status = () => ({ ...self.state, models: { ...self.state.models }, run: { ...self.state.run } });
    const said = (what, id) => { log.push(`${name}.${what}${id === undefined ? '' : `(${id})`}`); };
    self.engine = {
      status: async () => status(),
      download: async (id) => { said('download', id); self.state.engine = 'ready'; self.state.models[id] = downloaded; tell.onChange(status()); return status(); },
      cancel: async (id) => { said('cancel', id); return status(); },
      remove: async (id) => { said('remove', id); self.state.models[id] = absent; return status(); },
      start: async (id) => { said('start', id); self.state.run = { state: 'ready', model: id, port: 0, tail: '' }; self.state.up = [id]; tell.onChange(status()); return status(); },
      stop: async () => { said('stop'); self.state.run = STOPPED; return status(); },
      openStream: (init) => { if (self.state.run.state !== 'ready') return null; const id = self.next++; self.streams.push({ id, init, written: [], ended: false, aborted: false }); return id; },
      writeStream: (id, pcm) => { self.streams.find((s) => s.id === id).written.push(pcm); return true; },
      endStream: (id) => { self.streams.find((s) => s.id === id).ended = true; return true; },
      abortStream: (id) => { self.streams.find((s) => s.id === id).aborted = true; return true; },
    };
    standIn.made[name] = self;
    return self.engine;
  };
}
standIn.made = {};

/** A Mac: the system's recognition with Japanese installed and English not, and the runtime with its one model. */
function mac({ runtime = 'ready', model = downloaded, system = true } = {}) {
  const world = { log: [], changes: [], events: [], timers: [], now: 0 };
  const engine = joinEngines([
    standIn('apple', { supported: system, engine: system ? 'ready' : 'unsupported', models: system ? { 'apple-speech:ja': downloaded, 'apple-speech:en': absent } : {}, log: world.log }),
    standIn('runtime', { engine: runtime, models: { 'qwen3-asr-1.7b-q8': model }, log: world.log }),
  ], {
    onChange: (status) => world.changes.push(status),
    onStream: (event) => world.events.push(event),
    now: () => world.now,
    setTimer: (run, ms) => { const timer = { run, ms }; world.timers.push(timer); return timer; },
    clearTimer: (timer) => { world.timers = world.timers.filter((one) => one !== timer); },
    idleMs: 1000,
  });
  return { world, engine, apple: standIn.made.apple, runtime: standIn.made.runtime };
}

describe('two native recognizers as one', () => {
  it('lists the models of both, the system\'s first, and is ready wherever either can run', async () => {
    const { engine } = mac();
    const status = await engine.status();
    expect(status).toMatchObject({ supported: true, engine: 'ready', run: STOPPED });
    expect(Object.keys(status.models)).toEqual(['apple-speech:ja', 'apple-speech:en', 'qwen3-asr-1.7b-q8']);
    expect(status.models['qwen3-asr-1.7b-q8'].state).toBe('downloaded');
    // An older system has only the runtime's model, and is still an engine.
    const older = await mac({ system: false }).engine.status();
    expect(older).toMatchObject({ supported: true, engine: 'ready' });
    expect(Object.keys(older.models)).toEqual(['qwen3-asr-1.7b-q8']);
  });

  it('counts a model as downloaded only with the runtime that runs it', async () => {
    // The file is there, the runtime is not: there is still something to fetch.
    expect((await mac({ runtime: 'absent' }).engine.status()).models['qwen3-asr-1.7b-q8'].state).toBe('absent');
    // The runtime is on its way: so is the model that waits for it.
    expect((await mac({ runtime: 'downloading', model: absent }).engine.status()).models['qwen3-asr-1.7b-q8'].state).toBe('downloading');
    // The system's models are never touched by the runtime's state.
    expect((await mac({ runtime: 'absent' }).engine.status()).models['apple-speech:ja'].state).toBe('downloaded');
  });

  it('asks each model\'s own engine, and answers with the whole', async () => {
    const { world, engine } = mac({ runtime: 'absent', model: absent });
    const after = await engine.download('qwen3-asr-1.7b-q8');
    expect(world.log).toEqual(['runtime.download(qwen3-asr-1.7b-q8)']);
    expect(after.models['qwen3-asr-1.7b-q8'].state).toBe('downloaded');
    expect(after.models['apple-speech:ja'].state).toBe('downloaded');
    await engine.download('apple-speech:en');
    await engine.remove('qwen3-asr-1.7b-q8');
    await engine.cancel('nothing-of-either');
    expect(world.log.slice(1)).toEqual(['apple.download(apple-speech:en)', 'runtime.remove(qwen3-asr-1.7b-q8)']);
    // A change either engine tells is told as the whole.
    expect(world.changes.at(-1).models).toHaveProperty(['apple-speech:ja']);
    expect(world.changes.at(-1).models).toHaveProperty(['qwen3-asr-1.7b-q8']);
  });

  it('runs the one started last, and leaves the other up: someone may still be listening through it', async () => {
    const { world, engine } = mac();
    expect((await engine.start('qwen3-asr-1.7b-q8')).run).toMatchObject({ state: 'ready', model: 'qwen3-asr-1.7b-q8' });
    const both = await engine.start('apple-speech:ja');
    expect(both.run).toMatchObject({ state: 'ready', model: 'apple-speech:ja' });
    // Both can be asked now, whichever was started last.
    expect(both.up).toEqual(['apple-speech:ja', 'qwen3-asr-1.7b-q8']);
    expect(world.log).toEqual(['runtime.start(qwen3-asr-1.7b-q8)', 'apple.start(apple-speech:ja)']);
    // Everything is stopped when the page says so.
    expect((await engine.stop()).run).toEqual(STOPPED);
    expect(world.log.slice(2).sort()).toEqual(['apple.stop', 'runtime.stop']);
  });

  it('opens a recognition on the engine of the model it names, under an id of its own', async () => {
    const { world, engine, apple, runtime } = mac();
    await engine.start('qwen3-asr-1.7b-q8');
    await engine.start('apple-speech:ja');
    const mine = engine.openStream({ language: 'ja', sampleRate: 16000, model: 'apple-speech:ja' });
    const theirs = engine.openStream({ language: 'ru', sampleRate: 16000, model: 'qwen3-asr-1.7b-q8' });
    // Each engine counts its own from one: the page never sees two alike.
    expect([apple.streams[0].id, runtime.streams[0].id]).toEqual([1, 1]);
    expect(mine).not.toBe(theirs);
    expect(runtime.streams[0].init).toMatchObject({ language: 'ru', model: 'qwen3-asr-1.7b-q8' });
    engine.writeStream(theirs, 'sound');
    engine.endStream(theirs);
    expect(runtime.streams[0]).toMatchObject({ written: ['sound'], ended: true });
    expect(apple.streams[0]).toMatchObject({ written: [], ended: false });
    // What each engine says of its recognition reaches the page under the page's id.
    runtime.tell.onStream({ id: 1, type: 'partial', text: 'при' });
    apple.tell.onStream({ id: 1, type: 'delta', text: 'こん' });
    runtime.tell.onStream({ id: 1, type: 'done', text: 'привет' });
    expect(world.events).toEqual([{ id: theirs, type: 'partial', text: 'при' }, { id: mine, type: 'delta', text: 'こん' }, { id: theirs, type: 'done', text: 'привет' }]);
    // Done is done: nothing more of it is passed on, or sent to it.
    runtime.tell.onStream({ id: 1, type: 'delta', text: 'late' });
    expect(world.events).toHaveLength(3);
    expect(engine.writeStream(theirs, 'more')).toBe(false);
    engine.abortStream(mine);
    expect(apple.streams[0].aborted).toBe(true);
  });

  it('opens one that names no model on the engine started last, and none while nothing runs', async () => {
    const { engine, apple } = mac();
    expect(engine.openStream({ language: 'ja', sampleRate: 16000 })).toBeNull();
    await engine.start('apple-speech:ja');
    expect(engine.openStream({ language: 'ja', sampleRate: 16000 })).toEqual(expect.any(Number));
    expect(apple.streams).toHaveLength(1);
    // The engine of the model named is not up: no recognition, rather than another model's.
    expect(engine.openStream({ language: 'ru', sampleRate: 16000, model: 'qwen3-asr-1.7b-q8' })).toBeNull();
  });

  it('lets go of an engine left up once nobody has listened through it for a while', async () => {
    const { world, engine } = mac();
    await engine.start('qwen3-asr-1.7b-q8');
    await engine.start('apple-speech:ja');
    const id = engine.openStream({ language: 'ru', sampleRate: 16000, model: 'qwen3-asr-1.7b-q8' });
    world.now = 5000;
    // A recognition is open on it: it stays.
    world.timers.shift().run();
    expect(world.log).not.toContain('runtime.stop');
    engine.abortStream(id);
    // Just used: it stays a while longer.
    world.timers.shift().run();
    expect(world.log).not.toContain('runtime.stop');
    world.now = 7000;
    world.timers.shift().run();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(world.log).toContain('runtime.stop');
    // The one started last is never let go that way.
    expect(world.log).not.toContain('apple.stop');
    expect(world.timers).toHaveLength(0);
  });
});
