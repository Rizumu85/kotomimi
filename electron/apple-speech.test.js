// @vitest-environment node
// Fork: the Mac's own speech recognition, through the helper the app ships.
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'events';

const { createAppleSpeech, localeFor, systemHasIt, LOCALES, PREFIX } = require('./apple-speech.js');

const HELPER = '/Applications/Kotomimi.app/Contents/Resources/resources/bin/darwin-arm64/Kotomimi Speech Helper.app/Contents/MacOS/speech-helper';
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A Mac: which locales the system offers and has, every helper started, and what each was given. */
function mac({ platform = 'darwin', release = '26.0.0', offered = ['ja_JP', 'en_US', 'ko_KR', 'zh_CN'], installed = ['ja_JP'], helper = HELPER, helperThere = true } = {}) {
  const world = { started: [], changes: [], events: [], installed: new Set(installed) };
  const spawn = (bin, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.written = [];
    child.stdin = { writable: true, write: (line) => { child.written.push(JSON.parse(line)); return true; }, on: () => {} };
    child.say = (event) => child.stdout.emit('data', `${JSON.stringify(event)}\n`);
    child.finish = (code = 0) => child.emit('exit', code);
    child.kill = () => { child.killed = true; queueMicrotask(() => child.emit('exit', null)); return true; };
    world.started.push({ bin, args, child });
    // What the helper does by itself, for the commands that end by themselves.
    queueMicrotask(() => {
      if (args[0] === 'inventory') {
        child.say({ type: 'inventory', available: true, locales: offered.map((locale) => ({ locale, installed: world.installed.has(locale) })) });
        child.finish();
      } else if (args[0] === 'release') {
        child.say({ type: 'released', locale: args[1] });
        child.finish();
      }
    });
    return child;
  };
  const speech = createAppleSpeech({ helper, platform, release, spawn, exists: () => helperThere, onChange: (status) => world.changes.push(status), onStream: (event) => world.events.push(event) });
  return { world, speech };
}

describe('where the system\'s recognizer is', () => {
  it('is macOS 26 and later — Darwin 25 — and nowhere else', () => {
    expect(systemHasIt('darwin', '25.0.0')).toBe(true);
    expect(systemHasIt('darwin', '26.1.0')).toBe(true);
    expect(systemHasIt('darwin', '24.6.0')).toBe(false);
    expect(systemHasIt('win32', '10.0.26300')).toBe(false);
  });

  it('names a language the system\'s way, by its base, and none it is not offered in', () => {
    expect(localeFor('ja')).toBe('ja_JP');
    expect(localeFor('zh-CN')).toBe('zh_CN');
    expect(localeFor('en-US')).toBe('en_US');
    expect(localeFor('ru')).toBeNull();
    expect(localeFor('')).toBeNull();
    expect(Object.keys(LOCALES)).toContain('ko');
  });

  it('says so on another system, on an older macOS, or in an app built without the helper', async () => {
    for (const patch of [{ platform: 'win32' }, { release: '24.6.0' }, { helper: null }, { helperThere: false }]) {
      const { world, speech } = mac(patch);
      expect(await speech.status()).toMatchObject({ supported: false, engine: 'unsupported', models: {} });
      expect(await speech.start(`${PREFIX}ja`)).toMatchObject({ run: { state: 'stopped' } });
      expect(speech.openStream({ language: 'ja', sampleRate: 16000 })).toBeNull();
      expect(world.started).toEqual([]);
    }
  });
});

describe('its languages, as models', () => {
  it('lists the languages the system offers, each installed or not, asking the system once', async () => {
    const { world, speech } = mac();
    const status = await speech.status();
    expect(status).toMatchObject({ supported: true, engine: 'ready' });
    expect(status.models).toEqual({
      [`${PREFIX}ja`]: { state: 'downloaded', received: 0, total: 0 },
      [`${PREFIX}en`]: { state: 'absent', received: 0, total: 0 },
      [`${PREFIX}ko`]: { state: 'absent', received: 0, total: 0 },
      [`${PREFIX}zh`]: { state: 'absent', received: 0, total: 0 },
    });
    await speech.status();
    expect(world.started.map((s) => s.args)).toEqual([['inventory']]);
  });

  it('has the system fetch a language, with its progress, and knows it installed afterwards', async () => {
    const { world, speech } = mac();
    await speech.status();
    const fetched = speech.download(`${PREFIX}en`);
    await settled();
    const install = world.started.find((s) => s.args[0] === 'install');
    expect(install.args).toEqual(['install', 'en_US']);
    install.child.say({ type: 'progress', fraction: 0.5 });
    expect(world.changes.at(-1).models[`${PREFIX}en`]).toEqual({ state: 'downloading', received: 500, total: 1000 });
    world.installed.add('en_US');
    install.child.say({ type: 'installed', locale: 'en_US' });
    install.child.finish();
    expect((await fetched).models[`${PREFIX}en`]).toEqual({ state: 'downloaded', received: 0, total: 0 });
  });

  it('says why a language could not be fetched, and nothing when the person stopped it', async () => {
    const { world, speech } = mac();
    await speech.status();
    const failing = speech.download(`${PREFIX}ko`);
    await settled();
    const first = world.started.find((s) => s.args[1] === 'ko_KR');
    first.child.say({ type: 'error', message: 'No connection to the asset server' });
    first.child.finish(1);
    expect((await failing).models[`${PREFIX}ko`]).toMatchObject({ state: 'failed', error: 'No connection to the asset server' });

    const stopped = speech.download(`${PREFIX}zh`);
    await settled();
    speech.cancel(`${PREFIX}zh`);
    expect((await stopped).models[`${PREFIX}zh`]).toEqual({ state: 'absent', received: 0, total: 0 });
  });

  it('lets a language go by asking the system to', async () => {
    const { world, speech } = mac();
    await speech.remove(`${PREFIX}ja`);
    expect(world.started.map((s) => s.args)).toContainEqual(['release', 'ja_JP']);
  });
});

describe('a run', () => {
  it('is ready as soon as it is asked for, when the language is installed: there is nothing to start', async () => {
    const { speech } = mac();
    const started = await speech.start(`${PREFIX}ja`);
    expect(started.run).toEqual({ state: 'ready', model: `${PREFIX}ja`, port: 0, tail: '' });
    // Once asked for, it hears every language installed.
    expect(started.up).toEqual(Object.entries(started.models).filter(([, model]) => model.state === 'downloaded').map(([id]) => id));
    expect(started.up).toContain(`${PREFIX}ja`);
    expect((await speech.start(`${PREFIX}en`)).run).toMatchObject({ state: 'failed', model: `${PREFIX}en` });
    expect((await speech.stop()).run).toMatchObject({ state: 'stopped', model: null });
  });
});

describe('a live recognition', () => {
  it('is one helper for one stretch: the sound in as lines, the text out as it is heard, settled, and whole', async () => {
    const { world, speech } = mac();
    await speech.start(`${PREFIX}ja`);
    const id = speech.openStream({ language: 'ja-JP', sampleRate: 16000 });
    const { args, child } = world.started.at(-1);
    expect(args).toEqual(['stream', 'ja_JP']);
    speech.writeStream(id, new Uint8Array([1, 0, 2, 0]));
    expect(child.written).toEqual([{ type: 'audio', pcm: Buffer.from([1, 0, 2, 0]).toString('base64') }]);
    child.say({ type: 'ready' });
    child.say({ type: 'partial', text: 'こんに' });
    child.say({ type: 'delta', text: 'こんにちは。' });
    speech.endStream(id);
    expect(child.written.at(-1)).toEqual({ type: 'end' });
    child.say({ type: 'final', text: 'こんにちは。' });
    child.finish();
    expect(world.events).toEqual([
      { id, type: 'partial', text: 'こんに' },
      { id, type: 'delta', text: 'こんにちは。' },
      { id, type: 'done', text: 'こんにちは。' },
    ]);
    // Over: nothing more is written to it.
    expect(speech.writeStream(id, new Uint8Array(2))).toBe(false);
  });

  it('is not opened for a language the system has no recognizer for, for sound at another rate, or before a run', async () => {
    const { speech } = mac();
    expect(speech.openStream({ language: 'ja', sampleRate: 16000 })).toBeNull();
    await speech.start(`${PREFIX}ja`);
    expect(speech.openStream({ language: 'ru', sampleRate: 16000 })).toBeNull();
    expect(speech.openStream({ language: 'ja', sampleRate: 24000 })).toBeNull();
  });

  it('says so when the helper fails or closes before the end', async () => {
    const { world, speech } = mac();
    await speech.start(`${PREFIX}ja`);
    const refused = speech.openStream({ language: 'ja', sampleRate: 16000 });
    world.started.at(-1).child.say({ type: 'error', message: 'The speech assets for ja_JP are not installed' });
    const cut = speech.openStream({ language: 'ja', sampleRate: 16000 });
    world.started.at(-1).child.finish(1);
    expect(world.events).toEqual([
      { id: refused, type: 'error', message: 'The speech assets for ja_JP are not installed' },
      { id: cut, type: 'error', message: 'The speech recognizer closed before it finished.' },
    ]);
  });

  it('is dropped without a word when aborted, and all of them when the run stops', async () => {
    const { world, speech } = mac();
    await speech.start(`${PREFIX}ja`);
    const one = speech.openStream({ language: 'ja', sampleRate: 16000 });
    const first = world.started.at(-1).child;
    speech.abortStream(one);
    speech.openStream({ language: 'ja', sampleRate: 16000 });
    const second = world.started.at(-1).child;
    await speech.stop();
    await settled();
    expect(first.killed).toBe(true);
    expect(second.killed).toBe(true);
    expect(world.events).toEqual([]);
  });
});
