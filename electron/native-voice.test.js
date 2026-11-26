// @vitest-environment node
/**
 * Fork: the voice engine — audio.cpp's server with a model that speaks, run by the same manager as the recognition
 * engine (`createNativeEngine` with `VOICE_RUNTIME`): how it is started and warmed, how a sentence is asked of it and
 * its sound handed on, and what is fetched for it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createNativeEngine, speakLive, speechRequest, wavSound, wavOf, VOICES, VOICE_RUNTIME, ENGINE } = require('./native-engine.js');

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const ARCHIVE = Buffer.from('an archive of the engine');
const MODEL = Buffer.from('the weights of a voice');
const CATALOG = {
  engine: { version: '1.0.0', builds: { 'win32-x64': { url: 'https://example.test/engine.zip', bytes: ARCHIVE.length, sha256: sha(ARCHIVE), archive: 'engine.zip', exe: 'server.exe', backend: 'vulkan' } } },
  models: { v1: { file: 'v1.gguf', url: 'https://example.test/v1.gguf', bytes: MODEL.length, sha256: sha(MODEL), family: 'qwen3_tts', mode: 'streaming', sampleRate: 24000, speech: { voiceAs: 'voice_id', languageAs: 'language' }, voice: 'vivian' } },
};

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-voice-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const answer = (bytes, status = 200) => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(bytes)); controller.close(); } }), { status });

/** A computer with the voice runtime: what was started, and every sentence asked of it. */
function computer({ sayIt, catalog = CATALOG } = {}) {
  const world = { started: [], said: [] };
  const served = { 'https://example.test/engine.zip': ARCHIVE, 'https://example.test/v1.gguf': MODEL };
  const say = sayIt ?? ((request, onPcm) => {
    const one = { request, aborted: false };
    world.said.push(one);
    let stop;
    const done = new Promise((resolve, reject) => {
      stop = () => reject(new Error('The voice was stopped.'));
      queueMicrotask(() => { if (!one.aborted) { onPcm(Buffer.alloc(480), 24000); resolve({ sampleRate: 24000 }); } });
    });
    return { done, abort() { one.aborted = true; stop(); } };
  });
  const engine = createNativeEngine({
    dir,
    platform: 'win32',
    arch: 'x64',
    catalog,
    runtime: VOICE_RUNTIME,
    say,
    fetch: async (url) => (served[url] ? answer(served[url]) : answer([], 404)),
    spawn: (bin, args, options) => {
      const child = new EventEmitter();
      child.pid = 4242;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => { queueMicrotask(() => child.emit('exit', null)); return true; };
      world.started.push({ bin, args, options, child });
      return child;
    },
    extract: async (archive, into) => { fs.writeFileSync(path.join(into, 'server.exe'), 'exe'); },
    freePort: async () => 45123,
    get: async () => ({ status: 200, body: '{"status":"ok"}' }),
    setPriority: () => {},
    sleep: async () => {},
    readyTimeoutMs: 50,
    warmTimeoutMs: 200,
  });
  return { world, engine };
}

describe('the voice runtime', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([[1, 1], [5, 2], [8, 4], [12, 4]])(
    'on %i logical processors starts with %i threads and warms the model in its own voice', async (logical, threads) => {
    vi.spyOn(os, 'availableParallelism').mockReturnValue(logical);
    const { world, engine } = computer();
    await engine.download('v1');
    const after = await engine.start('v1');
    expect(after.run).toMatchObject({ state: 'ready', model: 'v1', port: 45123 });
    expect(world.started[0].args).toEqual(['--config', 'server.json', '--no-ui', '--threads', String(threads)]);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'models', 'server.json'), 'utf8'))).toEqual({
      host: '127.0.0.1', port: 45123, backend: 'vulkan', device: 0, lazy_load: false,
      models: [{ id: 'v1', family: 'qwen3_tts', path: 'v1.gguf', task: 'tts', mode: 'streaming', session_options: {} }],
    });
    expect(world.said.map((one) => one.request)).toEqual([expect.objectContaining({ port: 45123, model: 'v1', input: 'Hello.', voice: 'vivian', options: { voice_id: 'vivian', language: 'en' }, sampleRate: 24000, whole: false })]);
  });

  it('is warmed in a language its model speaks: a Japanese one with a Japanese word, asked whole', async () => {
    const one = { ...CATALOG.models.v1, family: 'irodori_tts', mode: 'offline', languages: ['ja'], speech: { voiceAs: 'instruct', languageAs: 'language', options: { no_ref: true }, voices: { woman: 'a calm young woman', man: 'a calm man' } }, voice: 'woman' };
    const said = [];
    await VOICE_RUNTIME.warm({ port: 1, id: 'v1', model: one, timeoutMs: 100, say: (request, onPcm) => { said.push(request); onPcm(Buffer.alloc(4), 48000); return { done: Promise.resolve({ sampleRate: 48000 }), abort() {} }; } });
    expect(said).toEqual([expect.objectContaining({ input: 'こんにちは。', whole: true, options: { no_ref: true, instruct: 'a calm young woman', language: 'ja' } })]);
    expect(said[0]).not.toHaveProperty('voice');
  });

  it('is still brought up when the warm-up says nothing: the first sentence is then the slow one', async () => {
    const { engine } = computer({ sayIt: () => ({ done: Promise.reject(new Error('refused')), abort() {} }) });
    await engine.download('v1');
    expect((await engine.start('v1')).run.state).toBe('ready');
  });
});

describe('a sentence asked of the voice engine', () => {
  it('is worded for the model\'s family, and its sound handed on as it comes', async () => {
    const { world, engine } = computer();
    await engine.download('v1');
    await engine.start('v1');
    const heard = [];
    const answer = await engine.speak({ id: 7, model: 'v1', text: '  こんにちは。 ', voice: 'ono_anna', language: 'ja-JP' }, (pcm, rate) => heard.push([pcm.length, rate]));
    expect(answer).toEqual({ ok: true });
    expect(world.said[1].request).toMatchObject({ model: 'v1', input: 'こんにちは。', voice: 'ono_anna', options: { voice_id: 'ono_anna', language: 'ja' } });
    expect(heard).toEqual([[480, 24000]]);
  });

  it('takes the model\'s own voice where none is named, or what is named is no voice\'s name', async () => {
    const { world, engine } = computer();
    await engine.download('v1');
    await engine.start('v1');
    await engine.speak({ id: 1, text: 'Hello.', language: 'en' });
    await engine.speak({ id: 2, text: 'Hello.', voice: '../../etc', language: 'en' });
    expect(world.said.slice(1).map((one) => one.request.voice)).toEqual(['vivian', 'vivian']);
  });

  it('is refused in words while the engine is not up, up with another model, or given nothing to say', async () => {
    const { engine } = computer();
    expect(await engine.speak({ id: 1, model: 'v1', text: 'Hello.', language: 'en' })).toEqual({ error: 'The voice engine is not up with this model.' });
    await engine.download('v1');
    await engine.start('v1');
    expect(await engine.speak({ id: 2, model: 'another', text: 'Hello.', language: 'en' })).toEqual({ error: 'The voice engine is not up with this model.' });
    expect(await engine.speak({ id: 3, model: 'v1', text: '   ', language: 'en' })).toEqual({ error: 'There is nothing to say.' });
  });

  it('is stopped by its id, and with the engine', async () => {
    const hanging = [];
    const { engine } = computer({
      sayIt: (request, onPcm) => {
        // The warm-up is answered; what follows hangs until it is stopped.
        if (request.input === 'Hello.') { onPcm(Buffer.alloc(2), 24000); return { done: Promise.resolve({ sampleRate: 24000 }), abort() {} }; }
        let stop;
        const one = { aborted: false, done: new Promise((_resolve, reject) => { stop = () => reject(new Error('The voice was stopped.')); }), abort() { one.aborted = true; stop(); } };
        hanging.push(one);
        return one;
      },
    });
    await engine.download('v1');
    await engine.start('v1');
    const asked = async (count) => { while (hanging.length < count) await new Promise((r) => setTimeout(r, 1)); };
    const first = engine.speak({ id: 1, model: 'v1', text: 'こんにちは。', language: 'ja' });
    await asked(1);
    engine.stopSpeaking(1);
    expect(await first).toEqual({ error: 'The voice was stopped.' });
    const second = engine.speak({ id: 2, model: 'v1', text: 'こんにちは。', language: 'ja' });
    await asked(2);
    await engine.stop();
    expect(await second).toEqual({ error: 'The voice was stopped.' });
    expect(hanging.map((one) => one.aborted)).toEqual([true, true]);
  });

  it('is made one at a time, in the order asked, and never asked for when stopped while it waits', async () => {
    const open = [];
    const { engine } = computer({
      sayIt: (request, onPcm) => {
        if (request.input === 'Hello.') { onPcm(Buffer.alloc(2), 24000); return { done: Promise.resolve({ sampleRate: 24000 }), abort() {} }; }
        let finish;
        const one = { input: request.input, done: new Promise((resolve) => { finish = () => resolve({ sampleRate: 24000 }); }), abort() {}, finish: () => finish() };
        open.push(one);
        return one;
      },
    });
    await engine.download('v1');
    await engine.start('v1');
    const tick = () => new Promise((r) => setTimeout(r, 5));
    const first = engine.speak({ id: 1, model: 'v1', text: 'one', language: 'en' });
    const second = engine.speak({ id: 2, model: 'v1', text: 'two', language: 'en' });
    const third = engine.speak({ id: 3, model: 'v1', text: 'three', language: 'en' });
    await tick();
    // The second and the third wait for the first.
    expect(open.map((one) => one.input)).toEqual(['one']);
    engine.stopSpeaking(2);
    open[0].finish();
    expect(await first).toEqual({ ok: true });
    expect(await second).toEqual({ error: 'The voice was stopped.' });
    await tick();
    expect(open.map((one) => one.input)).toEqual(['one', 'three']);
    open[1].finish();
    expect(await third).toEqual({ ok: true });
  });
});

describe('the request that speaks', () => {
  /** A server on this computer answering `/v1/audio/speech` as scripted. */
  const serve = (handler) => new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, close: () => new Promise((done) => server.close(done)) }));
  });

  it('asks for raw sound as it is made, and hands on whole samples whatever the pieces\' sizes', async () => {
    let body = '';
    const server = await serve((request, response) => {
      request.setEncoding('utf8');
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        response.writeHead(200, { 'Content-Type': 'audio/pcm;rate=48000' });
        response.write(Buffer.from([1, 0, 2]));
        setTimeout(() => { response.end(Buffer.from([0, 3, 0])); }, 20);
      });
    });
    const pieces = [];
    const { sampleRate } = await speakLive({ port: server.port, model: 'v1', input: 'Hello.', voice: 'vivian', options: { voice_id: 'vivian' }, sampleRate: 24000 }, (pcm, rate) => pieces.push([Buffer.from(pcm), rate])).done;
    await server.close();
    expect(JSON.parse(body)).toEqual({ model: 'v1', input: 'Hello.', voice: 'vivian', stream: true, stream_format: 'audio', response_format: 'pcm', options: { voice_id: 'vivian' } });
    // The rate the answer names, not the model's.
    expect(sampleRate).toBe(48000);
    expect(pieces.every(([pcm]) => pcm.length % 2 === 0)).toBe(true);
    expect(Buffer.concat(pieces.map(([pcm]) => pcm))).toEqual(Buffer.from([1, 0, 2, 0, 3, 0]));
  });

  it('says what the runtime refused, and can be dropped', async () => {
    const refusing = await serve((request, response) => { request.resume(); response.writeHead(400); response.end('{"error":"unknown voice"}'); });
    await expect(speakLive({ port: refusing.port, model: 'v1', input: 'Hello.', sampleRate: 24000 }, () => {}).done).rejects.toThrow(/answered 400.*unknown voice/);
    await refusing.close();

    const silent = await serve((request) => { request.resume(); });
    const one = speakLive({ port: silent.port, model: 'v1', input: 'Hello.', sampleRate: 24000 }, () => {});
    setTimeout(() => one.abort(), 20);
    await expect(one.done).rejects.toThrow('The voice was stopped.');
    await silent.close();
  });
});

describe('what a voice model is asked with', () => {
  it('names a packaged voice by its name, in the request and under the option its family reads, with the language\'s code', () => {
    expect(speechRequest(VOICES['qwen3-tts-1.7b-customvoice-q8'], 'ono_anna', 'ja-JP')).toEqual({ voice: 'ono_anna', options: { voice_id: 'ono_anna', language: 'ja' }, whole: false });
    expect(speechRequest({ speech: { voiceAs: 'voice_id' }, voice: 'vivian' }, undefined, 'en')).toEqual({ voice: 'vivian', options: { voice_id: 'vivian' }, whole: false });
    expect(speechRequest({}, 'x', 'en')).toEqual({ options: {}, whole: false });
  });

  it('tells a model with described voices the words of the one named, and of its first for any other name', () => {
    const irodori = VOICES['irodori-tts-v4.1-small-mf-q8'];
    expect(speechRequest(irodori, 'man', 'ja')).toEqual({ options: { no_ref: true, instruct: irodori.speech.voices.man, language: 'ja' }, whole: true });
    expect(speechRequest(irodori, 'vivian', 'ja').options.instruct).toBe(irodori.speech.voices.woman);
    expect(speechRequest(irodori, 'constructor', 'ja').options.instruct).toBe(irodori.speech.voices.woman);
  });
});

describe('a sentence that comes whole', () => {
  it('rejects a truncated or undersized fmt chunk', () => {
    const wav = wavOf(Buffer.alloc(2), 48000);
    for (const size of [14, wav.length]) {
      wav.writeUInt32LE(size, 16);
      expect(wavSound(wav)).toBeNull();
    }
  });

  const serve = (handler) => new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, close: () => new Promise((done) => server.close(done)) }));
  });

  it('is asked for as a WAV, and handed on in one piece at the rate the WAV names', async () => {
    let body = '';
    const sound = Buffer.from([1, 0, 2, 0, 3, 0]);
    const server = await serve((request, response) => {
      request.setEncoding('utf8');
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => { response.writeHead(200, { 'Content-Type': 'audio/wav' }); response.end(wavOf(sound, 48000)); });
    });
    const pieces = [];
    const { sampleRate } = await speakLive({ port: server.port, model: 'v1', input: 'こんにちは。', options: { no_ref: true }, sampleRate: 24000, whole: true }, (pcm, rate) => pieces.push([Buffer.from(pcm), rate])).done;
    await server.close();
    expect(JSON.parse(body)).toEqual({ model: 'v1', input: 'こんにちは。', response_format: 'wav', options: { no_ref: true } });
    expect(sampleRate).toBe(48000);
    expect(pieces).toEqual([[sound, 48000]]);
  });

  it('is refused in words when what came is no sound that can be read', async () => {
    const server = await serve((request, response) => { request.resume(); response.writeHead(200); response.end('not a wav'); });
    await expect(speakLive({ port: server.port, model: 'v1', input: 'x', sampleRate: 24000, whole: true }, () => {}).done).rejects.toThrow(/no sound that can be read/);
    await server.close();
    expect(wavSound(Buffer.alloc(10))).toBeNull();
  });
});

describe('what is fetched for the voice engine', () => {
  // No speed mode on any backend: the voice keeps up without it, and its memory grows as a run goes.
  it.each(['cuda', 'vulkan', 'metal'])('runs the voice on %s with its own options only', (backend) => {
    const id = 'qwen3-tts-0.6b-base-q8';
    VOICE_RUNTIME.launch({ id, model: VOICES[id], port: 1234, build: { backend }, modelsDir: dir, files: fs });
    const config = JSON.parse(fs.readFileSync(path.join(dir, 'server.json')));
    expect(config.backend).toBe(backend);
    expect(config.models[0].session_options).toEqual({ 'qwen3_tts.voice_prompt_cache_slots': 8 });
  });
  it('is the recognition engine\'s own runtime, and models pinned to a revision with their size and hash', () => {
    expect(ENGINE.builds['win32-x64'].url).toMatch(/audio\.cpp\/releases\/download\/v[\d.]+\//);
    for (const [id, model] of Object.entries(VOICES)) {
      expect(model.url, id).toMatch(/^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\/[0-9a-f]{40}\/[\w./-]+\.gguf$/);
      expect(model.url.endsWith(`/${model.file}`)).toBe(true);
      expect(model.mirror, id).toMatch(/^https:\/\/modelscope\.cn\/models\//);
      expect(model.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(model.bytes).toBeGreaterThan(1e8);
      expect(model.sampleRate).toBeGreaterThanOrEqual(16000);
      expect(model.languages).toContain('ja');
      // A cloning model has no voice of its own; any other is first in one.
      if (model.speech.clone) expect(model.voice).toBeUndefined();
      else expect(typeof model.voice).toBe('string');
      // A model with described voices is first in one of them.
      if (model.speech.voices) expect(Object.keys(model.speech.voices)).toContain(model.voice);
    }
  });
});

describe('a cloning model (fork)', () => {
  const CLONE = { ...CATALOG.models.v1, speech: { clone: true, languageAs: 'language' }, voice: undefined };
  it('speaks on from the recording in the recording\'s own language, and takes only the sound of the voice in any other', () => {
    const mine = { path: 'C:/voices/abc001.wav', text: '今天天气真不错。', language: 'zh-CN' };
    // Its own language: the recording and its words.
    expect(speechRequest(CLONE, 'abc001', 'zh', '哈哈哈哈哈，你也太逗了吧！', mine)).toEqual({
      fields: { voice_ref: mine.path, reference_text: mine.text }, options: { language: 'zh', max_tokens: 119 },
      whole: false, timeoutMs: 180_000,
    });
    // Another: spoken on from, a Chinese recording carries its accent into Japanese.
    expect(speechRequest(CLONE, 'abc001', 'ja-JP', 'あア한𠀀 A12!', mine)).toEqual({
      fields: { voice_ref: mine.path }, options: { language: 'ja', x_vector_only_mode: true, max_tokens: 82 },
      whole: false, timeoutMs: 180_000,
    });
    // A second recording, read in Japanese by someone sure of theirs: Japanese is spoken on from that one.
    const japanese = { path: 'C:/voices/abc002.wav', text: '今日はいい天気ですね。', language: 'ja' };
    expect(speechRequest(CLONE, 'abc002', 'ja', 'はい。', japanese).fields)
      .toEqual({ voice_ref: japanese.path, reference_text: japanese.text });
    // Words not known, or their language: the sound alone, whatever is read.
    expect(speechRequest(CLONE, 'abc001', 'zh', 'A', { ...mine, text: '' }).options)
      .toEqual({ language: 'zh', x_vector_only_mode: true, max_tokens: 53 });
    expect(speechRequest(CLONE, 'abc001', 'zh', '。', { ...mine, language: '' }).fields)
      .toEqual({ voice_ref: mine.path });
  });

  it('is not warmed in a voice it does not have, and says so when asked to speak with no recording', async () => {
    const said = [];
    expect(await VOICE_RUNTIME.warm({ port: 1, id: 'v1', model: CLONE, timeoutMs: 100, say: (request) => { said.push(request); return { done: Promise.resolve({ sampleRate: 24000 }), abort() {} }; } })).toBe(true);
    expect(said).toEqual([]);
    const { world, engine } = computer({ catalog: { ...CATALOG, models: { v1: CLONE } } });
    await engine.download('v1');
    await engine.start('v1');
    expect(world.said).toEqual([]);
    expect(await engine.speak({ id: 1, model: 'v1', text: 'Hello.', language: 'en' })).toEqual({ error: 'This voice model has no recording to speak from.' });
    expect(await engine.speak({ id: 2, model: 'v1', text: 'Hello.', language: 'en', reference: { path: 'C:/voices/abc001.wav', text: 'hi', language: 'en-US' } })).toEqual({ ok: true });
    expect(world.said.map((one) => one.request.fields)).toEqual([{ voice_ref: 'C:/voices/abc001.wav', reference_text: 'hi' }]);
    expect(world.said[0].request.options.max_tokens).toBe(61);
  });

  it('puts the recording at the top of the request, beside its options', async () => {
    const seen = [];
    const server = http.createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => { seen.push(JSON.parse(body)); response.writeHead(200, { 'Content-Type': 'audio/pcm;rate=24000' }); response.end(Buffer.alloc(480)); });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const ref = { path: 'C:/voices/abc001.wav', text: 'hi', language: 'ja' };
      const request = speechRequest(CLONE, 'abc001', 'ja', 'こんにちは。', ref);
      await speakLive({ port: server.address().port, model: 'v1', input: 'こんにちは。', ...request, sampleRate: 24000 }, () => {}).done;
      expect(seen[0]).toMatchObject({ model: 'v1', input: 'こんにちは。', voice_ref: ref.path,
        reference_text: 'hi', stream: true, options: { language: 'ja', max_tokens: 82 } });
      expect(seen[0]).not.toHaveProperty('voice');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
