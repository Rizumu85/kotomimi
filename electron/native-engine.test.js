// @vitest-environment node
// electron/native-engine.test.js
//
// Fork: the native recognition engine, fetched and run by the app. No network
// and no runtime here: the downloads are bytes the test holds, the process a
// recorder, and the port answers what the test says it does. Only the files
// are real, in a folder of their own, and one test talks to a real socket on
// this computer for the shape of a live recognition.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createNativeEngine, openLive, languageName, systemTar, ENGINE, MODELS, LLAMA, TRANSLATORS, LLAMA_RUNTIME } = require('./native-engine.js');

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const ARCHIVE = Buffer.from('an archive of the engine');
const MODEL = Buffer.from('the weights of a model, in a few bytes — enough to be cut in two');
const CATALOG = {
  engine: { version: '1.0.0', builds: { 'win32-x64': { url: 'https://example.test/engine.zip', bytes: ARCHIVE.length, sha256: sha(ARCHIVE), archive: 'engine.zip', exe: 'server.exe', backend: 'vulkan' } } },
  models: { m1: { file: 'm1.gguf', url: 'https://example.test/m1.gguf', bytes: MODEL.length, sha256: sha(MODEL), family: 'fam', mode: 'streaming', options: { 'fam.step': '160' } } },
};

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-native-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

/** A response whose body arrives in the pieces given. */
const answer = (pieces, status = 200) => new Response(new ReadableStream({
  start(controller) { for (const piece of pieces) controller.enqueue(new Uint8Array(piece)); controller.close(); },
}), { status });

/** A computer: what the network serves, every process started, and whether the port answers. */
function computer({ platform = 'win32', arch = 'x64', served = { 'https://example.test/engine.zip': ARCHIVE, 'https://example.test/m1.gguf': MODEL }, fetch: ownFetch, healthy = true, warmEvent = { type: 'done', text: '' } } = {}) {
  const world = { requests: [], started: [], changes: [], streamEvents: [], lives: [], priorities: [], healthy };
  const fetchIt = ownFetch ?? (async (url, init = {}) => {
    world.requests.push({ url, range: init.headers?.Range });
    const whole = served[url];
    if (!whole) return answer([], 404);
    const from = init.headers?.Range ? Number(/bytes=(\d+)-/.exec(init.headers.Range)[1]) : 0;
    return answer([whole.subarray(from)], from > 0 ? 206 : 200);
  });
  const spawn = (bin, args, options) => {
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { child.killed = true; queueMicrotask(() => child.emit('exit', null)); return true; };
    world.started.push({ bin, args, options, child });
    return child;
  };
  const live = (target, onEvent) => {
    const stream = { target, written: [], ended: false, aborted: false, onEvent, write(pcm) { stream.written.push(pcm); }, end() { stream.ended = true; if (world.lives.indexOf(stream) === 0 && warmEvent) queueMicrotask(() => onEvent(warmEvent)); }, abort() { stream.aborted = true; } };
    world.lives.push(stream);
    return stream;
  };
  const engine = createNativeEngine({
    dir,
    platform,
    arch,
    catalog: CATALOG,
    fetch: fetchIt,
    spawn,
    live,
    extract: async (archive, into) => { world.extracted = fs.readFileSync(archive); fs.writeFileSync(path.join(into, 'server.exe'), 'exe'); },
    freePort: async () => 45123,
    get: async (port, pathname) => { world.asked = `${port}${pathname}`; return world.healthy ? { status: 200, body: '{"status":"ok"}' } : null; },
    setPriority: (pid, priority) => world.priorities.push([pid, priority]),
    sleep: async () => {},
    onChange: (status) => world.changes.push(status),
    onStream: (event) => world.streamEvents.push(event),
    readyTimeoutMs: 50,
    warmTimeoutMs: 200,
  });
  return { world, engine };
}

const modelFile = () => path.join(dir, 'models', 'm1.gguf');
const exeFile = () => path.join(dir, 'engine-1.0.0', 'server.exe');

describe('what is fetched', () => {
  it('is fixed by address, size and hash, for the platforms the runtime is published for', () => {
    for (const build of Object.values(ENGINE.builds)) {
      expect(build.url).toMatch(/^https:\/\/github\.com\/0xShug0\/audio\.cpp\/releases\/download\/v[\d.]+\//);
      expect(build.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(build.bytes).toBeGreaterThan(1_000_000);
    }
    expect(Object.keys(ENGINE.builds).sort()).toEqual(['darwin-arm64', 'win32-x64']);
    for (const model of Object.values(MODELS)) {
      // A revision, never a branch: the file behind the address cannot change.
      expect(model.url).toMatch(/^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\/[0-9a-f]{40}\//);
      expect(model.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(model.file).toMatch(/^[\w.-]+\.gguf$/);
    }
  });

  it('offers a model only on the systems it names: a system left with none is not offered the runtime either', async () => {
    const elsewhere = createNativeEngine({ dir, platform: 'darwin', arch: 'arm64', fetch: async () => { throw new Error('nothing is fetched'); } });
    expect(MODELS['r2t2-q8'].platforms).toEqual(['win32-x64']);
    expect(elsewhere.status()).toMatchObject({ supported: false, engine: 'unsupported', models: {} });
    const here = createNativeEngine({ dir, platform: 'win32', arch: 'x64', fetch: async () => { throw new Error('nothing is fetched'); } });
    expect(here.status()).toMatchObject({ supported: true, models: { 'r2t2-q8': { state: 'absent' } } });
  });

  it('says so where the runtime is not published, and fetches nothing there', async () => {
    const { world, engine } = computer({ platform: 'linux' });
    expect(engine.status()).toMatchObject({ supported: false, engine: 'unsupported' });
    await engine.download('m1');
    expect(world.requests).toEqual([]);
  });
});

describe('the tool that unpacks the runtime', () => {
  it('is the system tar by its full path: another tar first on the PATH reads a drive letter as a host', () => {
    expect(systemTar('win32', { SystemRoot: 'D:\\Win' })).toBe('D:\\Win\\System32\\tar.exe');
    expect(systemTar('win32', {})).toBe('C:\\Windows\\System32\\tar.exe');
    expect(systemTar('darwin', {})).toBe('/usr/bin/tar');
  });
});

describe('the translation runtime', () => {
  it('is fixed the same way: the server by its release, each model by a revision of its makers own repository', () => {
    expect(Object.keys(LLAMA.builds).sort()).toEqual(['darwin-arm64', 'win32-x64']);
    for (const build of Object.values(LLAMA.builds)) {
      expect(build.url).toMatch(/^https:\/\/github\.com\/ggml-org\/llama\.cpp\/releases\/download\/b\d+\//);
      expect(build.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(build.exe).toMatch(/llama-server(\.exe)?$/);
    }
    expect(Object.keys(TRANSLATORS)).toEqual(['index-translate-2b', 'hy-mt2-1.8b', 'hy-mt1.5-1.8b']);
    for (const model of Object.values(TRANSLATORS)) {
      expect(model.url).toMatch(/^https:\/\/huggingface\.co\/(IndexTeam|tencent)\/[^/]+\/resolve\/[0-9a-f]{40}\//);
      expect(model.url.endsWith(`/${model.file}`)).toBe(true);
      expect(model.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(model.bytes).toBeGreaterThan(1_000_000_000);
    }
  });

  it('is started on one model by its file, on this computer alone, and warmed by one short answer', async () => {
    const posted = [];
    const { world, engine } = computer();
    const translator = createNativeEngine({
      dir,
      platform: 'win32',
      arch: 'x64',
      catalog: CATALOG,
      runtime: LLAMA_RUNTIME,
      fetch: async (url) => answer([url.endsWith('.zip') ? ARCHIVE : MODEL]),
      spawn: (bin, args, options) => { const child = new EventEmitter(); child.pid = 7; child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => { queueMicrotask(() => child.emit('exit', null)); return true; }; world.started.push({ bin, args, options, child }); return child; },
      extract: async (archive, into) => { fs.writeFileSync(path.join(into, 'server.exe'), 'exe'); },
      freePort: async () => 45200,
      get: async () => ({ status: 200, body: '{"status":"ok"}' }),
      post: async (port, pathname, body) => { posted.push({ port, pathname, body }); return { status: 200, body: '{}' }; },
      setPriority: () => {},
      sleep: async () => {},
    });
    void engine;
    await translator.download('m1');
    const status = await translator.start('m1');
    expect(status.run).toMatchObject({ state: 'ready', model: 'm1', port: 45200 });
    expect(world.started[0].args).toEqual(['-m', 'm1.gguf', '--host', '127.0.0.1', '--port', '45200', '-ngl', '99', '-c', '4096', '--no-webui']);
    expect(world.started[0].options.cwd).toBe(path.join(dir, 'models'));
    // No config file of the other runtime's is written.
    expect(fs.existsSync(path.join(dir, 'models', 'server.json'))).toBe(false);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ port: 45200, pathname: '/v1/chat/completions', body: { max_tokens: 4 } });
    await translator.stop();
  });
});

describe('a download', () => {
  it('fetches the runtime, unpacks it, then the model — each kept only once it hashes right', async () => {
    const { world, engine } = computer();
    expect(engine.status()).toMatchObject({ supported: true, engine: 'absent', models: { m1: { state: 'absent', total: MODEL.length } } });
    const after = await engine.download('m1');
    expect(world.requests.map((r) => r.url)).toEqual(['https://example.test/engine.zip', 'https://example.test/m1.gguf']);
    expect(world.extracted.equals(ARCHIVE)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'engine-1.0.0', 'engine.zip'))).toBe(false);
    expect(fs.readFileSync(modelFile()).equals(MODEL)).toBe(true);
    expect(after).toMatchObject({ engine: 'ready', models: { m1: { state: 'downloaded' } } });
    // It was told on the way: the runtime, then the model, each as it is checked.
    expect(world.changes.some((s) => s.engine === 'downloading')).toBe(true);
    expect(world.changes.some((s) => s.models.m1.state === 'downloading')).toBe(true);
    expect(world.changes.some((s) => s.models.m1.state === 'verifying')).toBe(true);
  });

  it('goes on from where a stopped one left off', async () => {
    const { world, engine } = computer();
    fs.mkdirSync(path.join(dir, 'models'), { recursive: true });
    fs.writeFileSync(`${modelFile()}.part`, MODEL.subarray(0, 20));
    await engine.download('m1');
    expect(world.requests.find((r) => r.url.endsWith('m1.gguf')).range).toBe('bytes=20-');
    expect(fs.readFileSync(modelFile()).equals(MODEL)).toBe(true);
  });

  it('starts over when the server sends the whole file where a rest was asked for', async () => {
    const fetch = async (url, init = {}) => answer([url.endsWith('.zip') ? ARCHIVE : MODEL], 200);
    const { engine } = computer({ fetch });
    fs.mkdirSync(path.join(dir, 'models'), { recursive: true });
    fs.writeFileSync(`${modelFile()}.part`, MODEL.subarray(0, 20));
    await engine.download('m1');
    expect(fs.readFileSync(modelFile()).equals(MODEL)).toBe(true);
  });

  it('throws away a file that is not the one expected, and says so', async () => {
    const { engine } = computer({ served: { 'https://example.test/engine.zip': ARCHIVE, 'https://example.test/m1.gguf': Buffer.from(MODEL.toString().replace('weights', 'WEIGHTS')) } });
    const after = await engine.download('m1');
    expect(after.models.m1).toMatchObject({ state: 'failed' });
    expect(after.models.m1.error).toMatch(/not the one expected/);
    expect(fs.existsSync(modelFile())).toBe(false);
    expect(fs.existsSync(`${modelFile()}.part`)).toBe(false);
  });

  it('says what the network said when it refuses', async () => {
    const { engine } = computer({ served: { 'https://example.test/engine.zip': ARCHIVE } });
    expect((await engine.download('m1')).models.m1).toMatchObject({ state: 'failed', error: 'The download answered HTTP 404.' });
  });

  it('can be stopped: nothing failed, and what came stays for the next time', async () => {
    let engine;
    const fetch = async (url, init = {}) => {
      if (url.endsWith('.zip')) return answer([ARCHIVE]);
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(MODEL.subarray(0, 10)));
          init.signal.addEventListener('abort', () => controller.error(Object.assign(new Error('stopped'), { name: 'AbortError' })));
          // Once the first bytes are on disk.
          setTimeout(() => engine.cancel('m1'), 30);
        },
      }), { status: 200 });
    };
    ({ engine } = computer({ fetch }));
    const after = await engine.download('m1');
    expect(after.models.m1).toMatchObject({ state: 'absent', received: 10 });
    expect(fs.readFileSync(`${modelFile()}.part`).equals(MODEL.subarray(0, 10))).toBe(true);
  });

  it('is deleted with whatever was left of it, and its engine stopped first when it runs it', async () => {
    const { world, engine } = computer();
    await engine.download('m1');
    await engine.start('m1');
    const after = await engine.remove('m1');
    expect(world.started[0].child.killed).toBe(true);
    expect(fs.existsSync(modelFile())).toBe(false);
    expect(after).toMatchObject({ models: { m1: { state: 'absent' } }, run: { state: 'stopped', model: null } });
    // The runtime stays: another model would use it.
    expect(fs.existsSync(exeFile())).toBe(true);
  });
});

describe('a run', () => {
  it('refuses a model that is not downloaded, in words', async () => {
    const { world, engine } = computer();
    expect((await engine.start('m1')).run).toMatchObject({ state: 'failed', model: 'm1', tail: 'The model is not downloaded.' });
    expect(world.started).toEqual([]);
  });

  it('starts the runtime in the models\' folder on a port of this computer alone, warms it at a lower priority, and is then ready', async () => {
    const { world, engine } = computer();
    await engine.download('m1');
    world.changes.length = 0;
    const after = await engine.start('m1');
    expect(world.started).toHaveLength(1);
    const { bin, args, options } = world.started[0];
    expect(bin).toBe(exeFile());
    expect(args).toEqual(['--config', 'server.json', '--no-ui']);
    expect(options.cwd).toBe(path.join(dir, 'models'));
    // The model is named by its file alone: the folder's own name is never written into the config.
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'models', 'server.json'), 'utf8'))).toEqual({
      host: '127.0.0.1', port: 45123, backend: 'vulkan', device: 0, lazy_load: false,
      models: [{ id: 'm1', family: 'fam', path: 'm1.gguf', task: 'asr', mode: 'streaming', session_options: { 'fam.step': '160' } }],
    });
    expect(world.asked).toBe('45123/health');
    // One short stretch of sound went through before it was called ready.
    expect(world.lives).toHaveLength(1);
    expect(world.lives[0].target).toMatchObject({ port: 45123, model: 'm1', sampleRate: 16000 });
    expect(world.lives[0].written[0].length).toBe(32000);
    expect(world.lives[0].ended).toBe(true);
    expect(world.changes.map((s) => s.run.state)).toEqual(['starting', 'warming', 'ready']);
    expect(world.priorities).toEqual([[4242, os.constants.priority.PRIORITY_BELOW_NORMAL], [4242, os.constants.priority.PRIORITY_NORMAL]]);
    expect(after.run).toMatchObject({ state: 'ready', model: 'm1', port: 45123 });
  });

  it('is started once: asked again for the model it has, it answers what it is doing', async () => {
    const { world, engine } = computer();
    await engine.download('m1');
    await Promise.all([engine.start('m1'), engine.start('m1')]);
    await engine.start('m1');
    expect(world.started).toHaveLength(1);
  });

  it('is ready even when the warm-up did not come back: the first sentence is then the slow one', async () => {
    const { engine } = computer({ warmEvent: { type: 'error', message: 'busy' } });
    await engine.download('m1');
    expect((await engine.start('m1')).run.state).toBe('ready');
  });

  it('fails with the runtime\'s last words when it never answers', async () => {
    let t = 0;
    const { world, engine } = computer({ healthy: false });
    await engine.download('m1');
    const slow = createNativeEngine({
      dir, platform: 'win32', arch: 'x64', catalog: CATALOG,
      spawn: (bin, args, options) => world.started.push({ bin, args, options, child: null }) && Object.assign(new EventEmitter(), { pid: 1, stdout: new EventEmitter(), stderr: new EventEmitter(), kill() { this.emit('exit', 1); } }),
      get: async () => null, freePort: async () => 1, sleep: async () => { t += 1000; }, now: () => t, readyTimeoutMs: 5000, setPriority: () => {},
    });
    const after = await slow.start('m1');
    expect(after.run.state).toBe('failed');
    expect(after.run.tail).toMatch(/did not answer in time/);
  });

  it('says so when the runtime goes away by itself, and tells every open recognition', async () => {
    const { world, engine } = computer();
    await engine.download('m1');
    await engine.start('m1');
    const id = engine.openStream({ language: 'ja', sampleRate: 24000 });
    world.started[0].child.stderr.emit('data', 'out of memory\n');
    world.started[0].child.emit('exit', 1);
    expect(engine.status().run).toMatchObject({ state: 'failed', tail: 'out of memory' });
    expect(world.streamEvents).toEqual([{ id, type: 'error', message: 'The recognition engine stopped.' }]);
  });
});

describe('a live recognition', () => {
  it('is opened only on a runtime that is ready, in the language\'s own name, at the rate the sound has', async () => {
    const { world, engine } = computer();
    expect(engine.openStream({ language: 'ja' })).toBeNull();
    await engine.download('m1');
    await engine.start('m1');
    const id = engine.openStream({ language: 'ja-JP', sampleRate: 24000 });
    expect(id).toEqual(expect.any(Number));
    expect(world.lives[1].target).toEqual({ port: 45123, model: 'm1', sampleRate: 24000, language: 'Japanese' });
    // A language it was not taught the name of is left to it to detect.
    engine.openStream({ language: 'th' });
    expect(world.lives[2].target.language).toBeNull();
  });

  it('carries the sound up and the text back under its id, and is forgotten once it is done', async () => {
    const { world, engine } = computer();
    await engine.download('m1');
    await engine.start('m1');
    const id = engine.openStream({ language: 'ja', sampleRate: 24000 });
    const stream = world.lives[1];
    expect(engine.writeStream(id, new Int16Array([1, 2, 3]))).toBe(true);
    expect(stream.written[0].equals(Buffer.from(new Int16Array([1, 2, 3]).buffer))).toBe(true);
    stream.onEvent({ type: 'delta', text: 'こん' });
    stream.onEvent({ type: 'delta', text: 'にちは' });
    engine.endStream(id);
    expect(stream.ended).toBe(true);
    stream.onEvent({ type: 'done', text: 'こんにちは' });
    expect(world.streamEvents).toEqual([{ id, type: 'delta', text: 'こん' }, { id, type: 'delta', text: 'にちは' }, { id, type: 'done', text: 'こんにちは' }]);
    expect(engine.writeStream(id, new Int16Array([4]))).toBe(false);
  });

  it('is dropped with the runtime when that is stopped', async () => {
    const { world, engine } = computer();
    await engine.download('m1');
    await engine.start('m1');
    engine.openStream({ language: 'ja' });
    await engine.stop();
    expect(world.lives[1].aborted).toBe(true);
    expect(engine.status().run).toMatchObject({ state: 'stopped', model: null });
  });

  it('names the languages the model was taught by name', () => {
    expect(languageName('ja')).toBe('Japanese');
    expect(languageName('zh-CN')).toBe('Chinese');
    expect(languageName('EN_us')).toBe('English');
    expect(languageName('th')).toBeNull();
    expect(languageName('')).toBeNull();
  });
});

describe('the request a live recognition is (a real socket on this computer)', () => {
  /** A runtime's live route: collects what is sent, answers as audio.cpp does. */
  const serve = (respond) => new Promise((resolve) => {
    const seen = { url: '', chunks: [] };
    const server = http.createServer((request, response) => {
      seen.url = request.url;
      respond(request, response, seen);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen }));
  });
  const sse = (event) => `data: ${JSON.stringify(event)}\n\n`;

  it('sends the sound as it comes and reads the text as it is written', async () => {
    const { server, port, seen } = await serve((request, response, got) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      request.on('data', (chunk) => {
        got.chunks.push(chunk);
        // Text while the sound is still coming.
        if (got.chunks.length === 1) response.write(sse({ type: 'transcript.text.delta', delta: 'こん' }));
      });
      request.on('end', () => {
        response.write(sse({ type: 'transcript.text.delta', delta: 'にちは' }));
        response.write(sse({ type: 'transcript.text.done', text: 'こんにちは' }));
        response.end('data: [DONE]\n\n');
      });
    });
    const events = [];
    let wake;
    const first = new Promise((resolve) => { wake = resolve; });
    const done = new Promise((resolve) => {
      const stream = openLive({ port, model: 'r2t2', sampleRate: 24000, language: 'Japanese' }, (event) => {
        events.push(event);
        if (event.type === 'delta' && events.length === 1) wake(stream);
        if (event.type !== 'delta') resolve();
      });
      stream.write(Buffer.from([1, 2, 3, 4]));
    });
    const stream = await first;
    // The first text came back before the sound was over.
    expect(events).toEqual([{ type: 'delta', text: 'こん' }]);
    stream.write(Buffer.from([5, 6]));
    stream.end();
    await done;
    server.close();
    expect(seen.url).toBe('/v1/audio/transcriptions/live?model=r2t2&sample_rate=24000&channels=1&sample_format=s16le&language=Japanese');
    expect(Buffer.concat(seen.chunks).equals(Buffer.from([1, 2, 3, 4, 5, 6]))).toBe(true);
    expect(events).toEqual([{ type: 'delta', text: 'こん' }, { type: 'delta', text: 'にちは' }, { type: 'done', text: 'こんにちは' }]);
  });

  it('says what the runtime refused with', async () => {
    const { server, port } = await serve((request, response) => { request.resume(); response.writeHead(503); response.end('{"error":"model busy"}'); });
    const event = await new Promise((resolve) => { openLive({ port, model: 'r2t2', sampleRate: 16000, language: null }, resolve).end(); });
    server.close();
    expect(event).toEqual({ type: 'error', message: 'The engine answered HTTP 503: {"error":"model busy"}' });
  });

  it('says so when nothing listens there', async () => {
    const event = await new Promise((resolve) => { openLive({ port: 1, model: 'r2t2', sampleRate: 16000, language: null }, resolve).end(); });
    expect(event.type).toBe('error');
  });
});
