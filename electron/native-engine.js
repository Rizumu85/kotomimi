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
    options: { 'confucius4_r2t2.chunk_size_ms': '160', 'confucius4_r2t2.unfixed_chunk_num': '0', 'confucius4_r2t2.unfixed_token_num': '1' },
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

/** Unpacks an archive with the system's own `tar` (Windows 10 and later have one that reads zip). */
function untar(archive, into) {
  return new Promise((resolve, reject) => {
    execFile('tar', ['-xf', archive, '-C', into], { windowsHide: true }, (error) => (error ? reject(error) : resolve()));
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
    live = openLive,
    setPriority = (pid, priority) => { try { os.setPriority(pid, priority); } catch { /* a courtesy to the rest of the computer, never a condition */ } },
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
    log = null,
    onChange = () => {},
    onStream = () => {},
    files = fs,
    readyTimeoutMs = READY_TIMEOUT_MS,
    warmTimeoutMs = WARM_TIMEOUT_MS,
    /** What is fetched: the lists above, unless a test brings its own. */
    catalog = { engine: ENGINE, models: MODELS },
  } = deps;
  const { engine: ENGINE_, models: MODELS_ } = catalog;

  const build = ENGINE_.builds[`${platform}-${arch}`] ?? null;
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
    engine: !build ? 'unsupported' : fetching.has('engine') ? 'downloading' : has(exe) ? 'ready' : 'absent',
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
    try {
      await extract(archive, engineDir);
    } finally {
      files.rmSync(archive, { force: true });
    }
    if (!has(exe)) throw new Error('The engine could not be unpacked.');
    if (platform !== 'win32') { try { files.chmodSync(exe, 0o755); } catch { /* already runnable, or it will say so when run */ } }
  }

  /** The runtime and a model, fetched: resolves with the state of things, which says what failed. */
  async function download(id) {
    if (!build || !MODELS_[id] || fetching.has(id) || fetching.has('engine')) return status();
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

  /** One second of faint noise through the model: what makes the first real sentence as quick as the rest. */
  function warm(port, id) {
    return new Promise((resolve) => {
      let timer = null;
      let stream = null;
      const done = (ok) => { clearTimeout(timer); resolve(ok); };
      timer = setTimeout(() => { stream?.abort(); done(false); }, warmTimeoutMs);
      stream = live({ port, model: id, sampleRate: 16000, language: null }, (event) => {
        if (event.type === 'done') done(true);
        else if (event.type === 'error') done(false);
      });
      const pcm = Buffer.alloc(16000 * 2);
      for (let i = 0; i < 16000; i += 1) pcm.writeInt16LE(Math.round((Math.random() - 0.5) * 60), i * 2);
      stream.write(pcm);
      stream.end();
    });
  }

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
    // The config sits beside the model and names it by its file alone: the runtime is started in that folder, so a
    // user folder whose name it could not read (Windows, letters outside the system's code page) is never spelled out.
    files.writeFileSync(path.join(modelsDir, 'server.json'), JSON.stringify({
      host: LOOPBACK,
      port,
      backend: build.backend,
      device: 0,
      lazy_load: false,
      models: [{ id, family: model.family, path: model.file, task: 'asr', mode: model.mode, session_options: model.options }],
    }, null, 1));
    let mine;
    try {
      mine = spawn(exe, ['--config', 'server.json', '--no-ui'], { cwd: modelsDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
    const warmed = await warm(port, id);
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
  function openStream({ language, sampleRate } = {}) {
    if (run.state !== 'ready' || !run.model) return null;
    const id = nextStream++;
    const rate = Number.isInteger(sampleRate) && sampleRate >= 8000 && sampleRate <= 48000 ? sampleRate : 16000;
    const stream = live({ port: run.port, model: run.model, sampleRate: rate, language: languageName(language) }, (event) => {
      if (event.type !== 'delta') streams.delete(id);
      onStream({ id, ...event });
    });
    streams.set(id, stream);
    return id;
  }
  function writeStream(id, pcm) {
    const stream = streams.get(id);
    if (!stream || !pcm) return false;
    stream.write(Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm.buffer ?? pcm, pcm.byteOffset ?? 0, pcm.byteLength));
    return true;
  }
  function endStream(id) { streams.get(id)?.end(); return true; }
  function abortStream(id) { streams.get(id)?.abort(); streams.delete(id); return true; }

  return { status, download, cancel, remove, start, stop, openStream, writeStream, endStream, abortStream };
}

module.exports = { createNativeEngine, openLive, languageName, ENGINE, MODELS, LOOPBACK };
