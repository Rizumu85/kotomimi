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
