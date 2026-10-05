// Fork: a native recognition engine, downloaded and run by the app.
//
// The app's own recognizers run in the page, on WebGPU. That is where they
// are slow: the same Qwen3-ASR model that takes 3.5 s for a 15 s sentence
// there takes 0.4 s in a native runtime, and a streaming model — one that
// writes while the speaker is still talking — cannot keep up there at all.
// So this module fetches a native runtime (audio.cpp, a ggml engine; one
// program, no Python) and a model for it, keeps both under the app's own
// folder, and runs the runtime as a server that listens on this computer
// alone. Nobody has to know what it is: a model in the library is
// downloaded, and it works.
//
// What is fetched is fixed here, by address, size and SHA-256: the page asks
// for a model by its id and can name nothing else, and a file that does not
// hash to what is written here is thrown away. The runtime's archive is the
// project's own release, unchanged.
//
// The first use after the computer starts is slow — the system reads
// gigabytes from disk and the graphics driver prepares itself — so a run is
// "warming" until one short stretch of sound has gone through, at a lower
// priority than whatever else the person has open, and only then "ready".
//
// A live recognition is one request to the runtime: sound goes up in chunks
// while it is spoken, text comes back in pieces on the same connection. The
// page cannot hold such a request (a browser uploads a stream only over
// HTTP/2), so it is held here, and the page sends the sound and receives the
// text over IPC.
//
// The same goes for translation, with another runtime: llama.cpp's server
// and a translation model as a GGUF file — the models a LocalAI would run,
// without the LocalAI. It is asked over the OpenAI chat wire, which the page
// speaks itself, so nothing of it is held here but the process. One manager
// (`createNativeEngine`) runs either: what differs is what is fetched (the
// `catalog`) and how the runtime is started and warmed (the `runtime`).
//
// No Electron import, and everything it touches is handed in, so its tests
// run with no network, no runtime and no process.
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn: nodeSpawn, execFile } = require('child_process');

const LOOPBACK = '127.0.0.1';

/** The runtime: audio.cpp's own release archives, as published. */
const ENGINE = {
  version: '0.9.0',
  builds: {
    'win32-x64': {
      url: 'https://github.com/0xShug0/audio.cpp/releases/download/v0.9.0/audio-v0.9.0-bin-windows-x64-vulkan.zip',
      bytes: 60320440,
      sha256: 'f884538138e44528a0bf17bb75dbe7ff7350cb91a14cb72c3e9cc1d4a31d6f1f',
      archive: 'engine.zip',
      exe: 'audiocpp_server.exe',
      backend: 'vulkan',
    },
    'darwin-arm64': {
      url: 'https://github.com/0xShug0/audio.cpp/releases/download/v0.9.0/audio-v0.9.0-bin-macos-arm64-metal.tar.gz',
      bytes: 29162796,
      sha256: '7cea9219d5f06475011c5d225d71d988cecef633ff7d098ee8a4c7b08583b1b4',
      archive: 'engine.tar.gz',
      exe: 'audiocpp_server',
      backend: 'metal',
    },
  },
};

/**
 * The models, by the id the page asks with. `options` are the runtime's
 * session options; R2T2's are the ones measured (FORK.md, "原生引擎").
 */
const MODELS = {
  'r2t2-q8': {
    file: 'r2t2-q8_0.gguf',
    url: 'https://huggingface.co/davidxifeng/Confucius4-R2T2-gguf/resolve/a8e6b385d7df7eae9519363e07034a209004797a/r2t2-q8_0.gguf',
    bytes: 2477512064,
    sha256: '19f5ccd624484bcb5d44301437de41560b0ecc40c430e8850dfeefefbe82ccf5',
    family: 'confucius4_r2t2',
    mode: 'streaming',
    // Where it keeps up with a voice. On an Apple M2 (Metal) it does not: a minute of speech took well over two
    // (measured 2026-10-05), so a Mac is not offered it.
    platforms: ['win32-x64'],
    options: { 'confucius4_r2t2.chunk_size_ms': '160', 'confucius4_r2t2.unfixed_chunk_num': '0', 'confucius4_r2t2.unfixed_token_num': '3' },
  },
};

/** llama.cpp's server, for the translation models: the project's own release archives, as published. */
const LLAMA = {
  version: 'b11401',
  builds: {
    'win32-x64': {
      url: 'https://github.com/ggml-org/llama.cpp/releases/download/b11401/llama-b11401-bin-win-vulkan-x64.zip',
      bytes: 33308209,
      sha256: '4bdbc0b2e79f04ef3e66ecd34a996499401d94501e8387dec0c8963544ef6419',
      archive: 'engine.zip',
      exe: 'llama-server.exe',
      backend: 'vulkan',
    },
    'darwin-arm64': {
      url: 'https://github.com/ggml-org/llama.cpp/releases/download/b11401/llama-b11401-bin-macos-arm64.tar.gz',
      bytes: 11921253,
      sha256: 'cf6410ec5cb373e7f161852a0e2ad30e96c190b9282e75cbd7eae00bd96736b4',
      archive: 'engine.tar.gz',
      exe: 'llama-b11401/llama-server',
      backend: 'metal',
    },
  },
};

/** The translation models, by the id the page asks with: each a Q4_K_M file from its makers' own repository, at a fixed revision. */
const TRANSLATORS = {
  'index-translate-2b': {
    file: 'Index-Translate-2B.Q4_K_M.gguf',
    url: 'https://huggingface.co/IndexTeam/Index-Translate-2B-GGUF/resolve/449c9e6457b3632d328c6cbb78ae8e8e0c8059a5/Index-Translate-2B.Q4_K_M.gguf',
    bytes: 1312164352,
    sha256: '044b313d29342bd3b2c77cbb64023ca0d209bd9b3247763f9d162767ef2d746a',
  },
  'hy-mt2-1.8b': {
    file: 'Hy-MT2-1.8B-Q4_K_M.gguf',
    url: 'https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF/resolve/a0c709d9fac510f2c807aa3af52872340dc37a4a/Hy-MT2-1.8B-Q4_K_M.gguf',
    bytes: 1133080448,
    sha256: 'dc5f44fcf1fa496ee7ad725982c0c8c553a4de00259b53af84c4b89fb0c06699',
  },
  'hy-mt1.5-1.8b': {
    file: 'HY-MT1.5-1.8B-Q4_K_M.gguf',
    url: 'https://huggingface.co/tencent/HY-MT1.5-1.8B-GGUF/resolve/265b2e615a7dc9b06c435dc878829ad99a512ba2/HY-MT1.5-1.8B-Q4_K_M.gguf',
    bytes: 1133080512,
    sha256: '4383ac0c3c8e476de98ff979c2a3f069f8c4fb385e7860cf2d28da896cc477c7',
  },
};

/** The model the runtime is told the language by: its name in English, as R2T2 was trained to read it. Any other is left to detection. */
const LANGUAGE_NAMES = {
  ja: 'Japanese', zh: 'Chinese', en: 'English', ko: 'Korean', fr: 'French', de: 'German', it: 'Italian', pt: 'Portuguese', ru: 'Russian', es: 'Spanish', ar: 'Arabic',
};
const languageName = (code) => LANGUAGE_NAMES[String(code ?? '').trim().toLowerCase().split(/[-_]/)[0]] ?? null;

/** How long the runtime may take to load a model and answer. */
const READY_TIMEOUT_MS = 240_000;
const READY_POLL_MS = 400;
/** How long the first stretch of sound may take to come back: the slow one, after the computer starts. */
const WARM_TIMEOUT_MS = 240_000;
/** Progress is told this often at most. */
const PROGRESS_MS = 300;
const TAIL_LINES = 30;

/** A file's SHA-256, read in pieces. */
function hashOf(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
  });
}

/** A port nothing listens on, on this computer. */
function freePortOf() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, LOOPBACK, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * The system's own `tar`, by its full path: Windows 10 and later have one that reads zip, and whatever `tar` comes
 * first on the PATH may be another — Git's reads `C:\…` as a host named C (seen 2026-10-05).
 */
function systemTar(platform = process.platform, env = process.env) {
  return platform === 'win32' ? path.win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar';
}

/** Unpacks an archive with it. */
function untar(archive, into) {
  return new Promise((resolve, reject) => {
    execFile(systemTar(), ['-xf', archive, '-C', into], { windowsHide: true }, (error) => (error ? reject(error) : resolve()));
  });
}

/** GET on this computer: `{ status, body }`, or null when nothing answers. */
function loopGet(port, pathname, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const request = http.get({ host: LOOPBACK, port, path: pathname, timeout: timeoutMs }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { if (body.length < 100_000) body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
      response.on('error', () => resolve(null));
    });
    request.on('timeout', () => { request.destroy(); resolve(null); });
    request.on('error', () => resolve(null));
  });
}

/** POST of a JSON body on this computer: `{ status, body }`, or null when nothing answers in time. */
function loopPost(port, pathname, json, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify(json));
    const request = http.request({ host: LOOPBACK, port, method: 'POST', path: pathname, timeout: timeoutMs, headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length, Authorization: 'Bearer no-key' } }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { if (body.length < 100_000) body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
      response.on('error', () => resolve(null));
    });
    request.on('timeout', () => { request.destroy(); resolve(null); });
    request.on('error', () => resolve(null));
    request.end(payload);
  });
}

/**
 * audio.cpp: started with a config that sits beside the model and names it by
 * its file alone — the runtime is started in that folder, so a user folder
 * whose name it could not read (Windows, letters outside the system's code
 * page) is never spelled out — and warmed by one second of faint noise.
 */
const AUDIO_RUNTIME = {
  launch({ id, model, port, build, modelsDir, files }) {
    files.writeFileSync(path.join(modelsDir, 'server.json'), JSON.stringify({
      host: LOOPBACK,
      port,
      backend: build.backend,
      device: 0,
      lazy_load: false,
      models: [{ id, family: model.family, path: model.file, task: 'asr', mode: model.mode, session_options: model.options }],
    }, null, 1));
    return ['--config', 'server.json', '--no-ui'];
  },
  warm({ port, id, live, timeoutMs }) {
    return new Promise((resolve) => {
      let timer = null;
      let stream = null;
      const done = (ok) => { clearTimeout(timer); resolve(ok); };
      timer = setTimeout(() => { stream?.abort(); done(false); }, timeoutMs);
      stream = live({ port, model: id, sampleRate: 16000, language: null }, (event) => {
        if (event.type === 'done') done(true);
        else if (event.type === 'error') done(false);
      });
      const pcm = Buffer.alloc(16000 * 2);
      for (let i = 0; i < 16000; i += 1) pcm.writeInt16LE(Math.round((Math.random() - 0.5) * 60), i * 2);
      stream.write(pcm);
      stream.end();
    });
  },
};

/**
 * llama.cpp's server: one model, named by its file (it too is started in the
 * models' folder), everything on the graphics card, no page of its own; and
 * warmed by one short answer.
 */
const LLAMA_RUNTIME = {
  launch({ model, port }) {
    return ['-m', model.file, '--host', LOOPBACK, '--port', String(port), '-ngl', '99', '-c', String(model.context ?? 4096), '--no-webui'];
  },
  async warm({ port, post, timeoutMs }) {
    const answer = await post(port, '/v1/chat/completions', { messages: [{ role: 'user', content: 'Hello' }], max_tokens: 4, temperature: 0, chat_template_kwargs: { enable_thinking: false } }, timeoutMs);
    return answer?.status === 200;
  },
};

/**
 * A live recognition on the runtime: the request that carries the sound up
 * and the text back. `onEvent` is called with `{ type: 'delta', text }` for
 * each piece of text, `{ type: 'done', text }` with the whole of it, and
 * `{ type: 'error', message }`; `write` takes 16-bit mono PCM, `end` says the
 * sound is over, `abort` drops the request.
 */
function openLive({ port, model, sampleRate, language }, onEvent) {
  const query = new URLSearchParams({ model, sample_rate: String(sampleRate), channels: '1', sample_format: 's16le' });
  if (language) query.set('language', language);
  let over = false;
  const finish = (event) => {
    if (over) return;
    over = true;
    onEvent(event);
  };
  const request = http.request({ host: LOOPBACK, port, method: 'POST', path: `/v1/audio/transcriptions/live?${query}`, headers: { 'Content-Type': 'application/octet-stream', 'Transfer-Encoding': 'chunked' } }, (response) => {
    response.setEncoding('utf8');
    let pending = '';
    let refused = '';
    let whole = null;
    response.on('data', (chunk) => {
      if (response.statusCode !== 200) { if (refused.length < 400) refused += chunk; return; }
      pending += chunk;
      let at;
      while ((at = pending.indexOf('\n\n')) >= 0) {
        const block = pending.slice(0, at);
        pending = pending.slice(at + 2);
        const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('');
        if (!data || data === '[DONE]') continue;
        let event;
        try { event = JSON.parse(data); } catch { continue; }
        if (event?.type === 'transcript.text.delta' && typeof event.delta === 'string' && event.delta) onEvent({ type: 'delta', text: event.delta });
        else if (event?.type === 'transcript.text.done') whole = typeof event.text === 'string' ? event.text : '';
        else if (event?.type === 'error' || event?.error) finish({ type: 'error', message: String(event?.error?.message ?? event?.message ?? 'The engine reported an error.').slice(0, 300) });
      }
    });
    response.on('end', () => {
      if (response.statusCode !== 200) finish({ type: 'error', message: `The engine answered HTTP ${response.statusCode}${refused ? `: ${refused.replace(/\s+/g, ' ').slice(0, 200)}` : ''}` });
      else if (whole === null) finish({ type: 'error', message: 'The engine closed the stream before it finished.' });
      else finish({ type: 'done', text: whole });
    });
    response.on('error', (error) => finish({ type: 'error', message: error.message }));
  });
  request.on('error', (error) => finish({ type: 'error', message: error.message }));
  // Sent as it comes: a held-back chunk is text that arrives late.
  request.setNoDelay?.(true);
  request.flushHeaders();
  return {
    write: (pcm) => { if (!over && !request.writableEnded) request.write(pcm); },
    end: () => { if (!request.writableEnded) request.end(); },
    abort: () => { over = true; request.destroy(); },
  };
}

function createNativeEngine(deps = {}) {
  const {
    dir,
    platform = process.platform,
    arch = process.arch,
    fetch: doFetch = (...args) => fetch(...args),
    spawn = nodeSpawn,
    extract = untar,
    hash = hashOf,
    freePort = freePortOf,
    get = loopGet,
    post = loopPost,
    live = openLive,
    /** How the runtime is started and warmed: audio.cpp's way, unless another is handed in. */
    runtime = AUDIO_RUNTIME,
    setPriority = (pid, priority) => { try { os.setPriority(pid, priority); } catch { /* a courtesy to the rest of the computer, never a condition */ } },
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
    log = null,
    onChange = () => {},
    onStream = () => {},
    files = fs,
    readyTimeoutMs = READY_TIMEOUT_MS,
    warmTimeoutMs = WARM_TIMEOUT_MS,
    /** A folder to keep each recognition's sound in, as the engine was given it: for comparing a run with the engine's own client. */
    dumpDir = null,
    /** What is fetched: the lists above, unless a test brings its own. */
    catalog = { engine: ENGINE, models: MODELS },
  } = deps;
  const { engine: ENGINE_ } = catalog;
  const system = `${platform}-${arch}`;
  /** The models this system is offered: one that names its systems is offered on those alone. */
  const MODELS_ = Object.fromEntries(Object.entries(catalog.models).filter(([, model]) => !model.platforms || model.platforms.includes(system)));

  // A system with no model to run has no use for the runtime either.
  const build = Object.keys(MODELS_).length > 0 ? ENGINE_.builds[system] ?? null : null;
  const engineDir = path.join(dir, `engine-${ENGINE_.version}`);
  const modelsDir = path.join(dir, 'models');
  const exe = build ? path.join(engineDir, build.exe) : null;
  const fileOf = (id) => path.join(modelsDir, MODELS_[id].file);
  const has = (file) => { try { return files.statSync(file).isFile(); } catch { return false; } };
  const sizeOf = (file) => { try { return files.statSync(file).size; } catch { return 0; } };

  let child = null;
  let tail = [];
  let run = { state: 'stopped', model: null, port: 0, tail: '' };
  /** What is being fetched: id (or `engine`) → `{ received, total, abort }`. */
  const fetching = new Map();
  /** The runtime's archive is here and being unpacked: still on its way, to whoever asks. */
  let unpacking = false;
  const failed = new Map();
  let lastTold = 0;

  const modelState = (id) => {
    const busy = fetching.get(id);
    if (busy) return { state: busy.verifying ? 'verifying' : 'downloading', received: busy.received, total: busy.total };
    if (has(fileOf(id))) return { state: 'downloaded', received: MODELS_[id].bytes, total: MODELS_[id].bytes };
    const error = failed.get(id);
    return { state: error ? 'failed' : 'absent', received: sizeOf(`${fileOf(id)}.part`), total: MODELS_[id].bytes, ...(error ? { error } : {}) };
  };
  const status = () => ({
    supported: Boolean(build),
    engine: !build ? 'unsupported' : fetching.has('engine') || unpacking ? 'downloading' : has(exe) ? 'ready' : 'absent',
    engineBytes: build?.bytes ?? 0,
    models: Object.fromEntries(Object.keys(MODELS_).map((id) => [id, modelState(id)])),
    run: { ...run },
  });
  const tell = (force = true) => {
    if (!force && now() - lastTold < PROGRESS_MS) return;
    lastTold = now();
    onChange(status());
  };
  const setRun = (patch) => { run = { ...run, ...patch }; tell(); return status(); };
  const note = (chunk) => {
    const text = String(chunk);
    log?.(text);
    tail = [...tail, ...text.split(/\r?\n/).filter((line) => line.trim())].slice(-TAIL_LINES);
  };

  /** One file, from its address to its place: resumed where a stopped download left off, and kept only if it hashes right. */
  async function fetchFile(key, { url, bytes, sha256 }, dest) {
    const part = `${dest}.part`;
    const control = new AbortController();
    const state = { received: sizeOf(part), total: bytes, abort: () => control.abort(), verifying: false };
    // A part larger than the whole is no part of it.
    if (state.received > bytes) { files.rmSync(part, { force: true }); state.received = 0; }
    fetching.set(key, state);
    failed.delete(key);
    tell();
    try {
      if (state.received < bytes) {
        const response = await doFetch(url, { signal: control.signal, redirect: 'follow', headers: state.received > 0 ? { Range: `bytes=${state.received}-` } : {} });
        // The server sent the whole file where a rest was asked for: start over.
        if (response.status === 200 && state.received > 0) { files.rmSync(part, { force: true }); state.received = 0; }
        else if (response.status !== 200 && response.status !== 206) throw new Error(`The download answered HTTP ${response.status}.`);
        if (!response.body) throw new Error('The download has no body.');
        const out = files.createWriteStream(part, { flags: state.received > 0 ? 'a' : 'w' });
        const failedWrite = new Promise((_, reject) => out.once('error', reject));
        failedWrite.catch(() => {});
        try {
          const reader = response.body.getReader();
          for (;;) {
            const { done, value } = await Promise.race([reader.read(), failedWrite]);
            if (done) break;
            if (!out.write(Buffer.from(value))) await Promise.race([new Promise((resolve) => out.once('drain', resolve)), failedWrite]);
            state.received += value.byteLength;
            tell(false);
          }
        } finally {
          await new Promise((resolve) => out.end(resolve));
        }
      }
      state.verifying = true;
      tell();
      if (sizeOf(part) !== bytes || (await hash(part)) !== sha256) {
        files.rmSync(part, { force: true });
        throw new Error('The downloaded file is not the one expected, and was discarded.');
      }
      files.renameSync(part, dest);
    } finally {
      fetching.delete(key);
    }
  }

  async function ensureEngine() {
    if (has(exe)) return;
    files.mkdirSync(engineDir, { recursive: true });
    const archive = path.join(engineDir, build.archive);
    await fetchFile('engine', build, archive);
    unpacking = true;
    tell();
    try {
      await extract(archive, engineDir);
    } finally {
      unpacking = false;
      files.rmSync(archive, { force: true });
    }
    if (!has(exe)) throw new Error('The engine could not be unpacked.');
    if (platform !== 'win32') { try { files.chmodSync(exe, 0o755); } catch { /* already runnable, or it will say so when run */ } }
  }

  /** The runtime and a model, fetched: resolves with the state of things, which says what failed. */
  async function download(id) {
    if (!build || !MODELS_[id] || fetching.has(id) || fetching.has('engine') || unpacking) return status();
    try {
      await ensureEngine();
      if (!has(fileOf(id))) {
        files.mkdirSync(modelsDir, { recursive: true });
        await fetchFile(id, MODELS_[id], fileOf(id));
      }
    } catch (error) {
      // Stopped by the person: nothing failed.
      if (error?.name !== 'AbortError') failed.set(id, String(error?.message ?? error).slice(0, 300));
    }
    tell();
    return status();
  }

  function cancel(id) {
    fetching.get(id)?.abort();
    fetching.get('engine')?.abort();
    return status();
  }

  async function remove(id) {
    if (!MODELS_[id]) return status();
    cancel(id);
    if (run.model === id) await stop();
    files.rmSync(fileOf(id), { force: true });
    files.rmSync(`${fileOf(id)}.part`, { force: true });
    failed.delete(id);
    tell();
    return status();
  }

  const streams = new Map();
  let nextStream = 1;

  /** A start under way, and the model it is for: asked again meanwhile, the same start answers. */
  let starting = null;

  /** The runtime, up with this model and warmed. Asked again for the model it has, it answers what it is doing. */
  function start(id) {
    if (!build || !MODELS_[id]) return Promise.resolve(status());
    if (starting?.id === id) return starting.done;
    if (run.model === id && (run.state === 'starting' || run.state === 'warming' || run.state === 'ready')) return Promise.resolve(status());
    const mine = { id, done: null };
    mine.done = bringUp(id).finally(() => { if (starting === mine) starting = null; });
    starting = mine;
    return mine.done;
  }

  async function bringUp(id) {
    await stop();
    if (!has(exe) || !has(fileOf(id))) return setRun({ state: 'failed', model: id, tail: 'The model is not downloaded.' });
    tail = [];
    let port;
    try {
      port = await freePort();
    } catch (error) {
      return setRun({ state: 'failed', model: id, tail: String(error?.message ?? error) });
    }
    setRun({ state: 'starting', model: id, port, tail: '' });
    const model = MODELS_[id];
    let mine;
    try {
      mine = spawn(exe, runtime.launch({ id, model, port, build, modelsDir, files }), { cwd: modelsDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      return setRun({ state: 'failed', tail: String(error?.message ?? error) });
    }
    child = mine;
    let exited = false;
    const ended = (code) => {
      if (exited) return;
      exited = true;
      if (child !== mine) return;
      child = null;
      for (const [streamId, stream] of streams) { stream.abort(); onStream({ id: streamId, type: 'error', message: 'The recognition engine stopped.' }); }
      streams.clear();
      if (run.state !== 'stopped') setRun({ state: code === 0 ? 'stopped' : 'failed', tail: tail.join('\n') });
    };
    mine.stdout?.on('data', note);
    mine.stderr?.on('data', note);
    mine.stdout?.on('error', () => {});
    mine.stderr?.on('error', () => {});
    mine.on('error', (error) => { note(error.message); ended(1); });
    mine.on('exit', ended);
    // Loading and warming give way to whatever else is going on; hearing does not.
    if (mine.pid) setPriority(mine.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);

    const deadline = now() + readyTimeoutMs;
    for (;;) {
      if (child !== mine) return status();
      if ((await get(port, '/health'))?.status === 200) break;
      if (now() > deadline) {
        note('The engine did not answer in time.');
        mine.kill();
        return setRun({ state: 'failed', tail: tail.join('\n') });
      }
      await sleep(READY_POLL_MS);
    }
    setRun({ state: 'warming' });
    // One short piece of work through the model: what makes the first real sentence as quick as the rest.
    const warmed = await Promise.resolve(runtime.warm({ port, id, live, post, timeoutMs: warmTimeoutMs })).catch(() => false);
    if (child !== mine) return status();
    if (mine.pid) setPriority(mine.pid, os.constants.priority.PRIORITY_NORMAL);
    // A warm-up that did not come back is not a reason to refuse: the first sentence will be the slow one.
    if (!warmed) note('The warm-up did not finish.');
    return setRun({ state: 'ready' });
  }

  async function stop() {
    const mine = child;
    child = null;
    for (const stream of streams.values()) stream.abort();
    streams.clear();
    if (mine) {
      try { mine.kill(); } catch { /* gone already */ }
    }
    if (run.state !== 'stopped') setRun({ state: 'stopped', model: null, port: 0 });
    return status();
  }

  /** A live recognition opened for the page: its id, or null while the runtime is not ready. */
  const dumps = new Map();
  function openStream({ language, sampleRate } = {}) {
    if (run.state !== 'ready' || !run.model) return null;
    const id = nextStream++;
    const rate = Number.isInteger(sampleRate) && sampleRate >= 8000 && sampleRate <= 48000 ? sampleRate : 16000;
    const stream = live({ port: run.port, model: run.model, sampleRate: rate, language: languageName(language) }, (event) => {
      if (event.type !== 'delta') streams.delete(id);
      onStream({ id, ...event });
    });
    streams.set(id, stream);
    if (dumpDir) {
      try {
        files.mkdirSync(dumpDir, { recursive: true });
        dumps.set(id, files.createWriteStream(path.join(dumpDir, `stream-${String(id).padStart(4, '0')}-${rate}.pcm`)));
      } catch { /* a convenience */ }
    }
    return id;
  }
  function writeStream(id, pcm) {
    const stream = streams.get(id);
    if (!stream || !pcm) return false;
    const bytes = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm.buffer ?? pcm, pcm.byteOffset ?? 0, pcm.byteLength);
    stream.write(bytes);
    dumps.get(id)?.write(bytes);
    return true;
  }
  const undump = (id) => { dumps.get(id)?.end(); dumps.delete(id); };
  function endStream(id) { streams.get(id)?.end(); undump(id); return true; }
  function abortStream(id) { streams.get(id)?.abort(); streams.delete(id); undump(id); return true; }

  return { status, download, cancel, remove, start, stop, openStream, writeStream, endStream, abortStream };
}

module.exports = { createNativeEngine, openLive, languageName, systemTar, ENGINE, MODELS, LLAMA, TRANSLATORS, AUDIO_RUNTIME, LLAMA_RUNTIME, LOOPBACK };
