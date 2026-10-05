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
// A model that reads a whole stretch at once (Qwen3-ASR) is given to the
// page the same way: the sound is kept here as it comes, and read again and
// again while it grows — each reading is what shows meanwhile — and once more
// when it is over (`openWindow`). In this runtime such a reading takes a
// fraction of a second, which is what makes that possible.
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

/** Nemotron's locales, by the app's base code: the one it is told where the app's own code is not of its list. */
const NEMOTRON_LOCALES = {
  ar: 'ar-AR', bg: 'bg-BG', cs: 'cs-CZ', da: 'da-DK', de: 'de-DE', el: 'el-GR', en: 'en-US', es: 'es-ES', et: 'et-EE', fi: 'fi-FI', fr: 'fr-FR', he: 'he-IL',
  hi: 'hi-IN', hr: 'hr-HR', hu: 'hu-HU', it: 'it-IT', ja: 'ja-JP', ko: 'ko-KR', lt: 'lt-LT', lv: 'lv-LV', mt: 'mt-MT', nb: 'nb-NO', nl: 'nl-NL', nn: 'nn-NO',
  no: 'nb-NO', pl: 'pl-PL', pt: 'pt-PT', ro: 'ro-RO', ru: 'ru-RU', sk: 'sk-SK', sl: 'sl-SI', sv: 'sv-SE', th: 'th-TH', tr: 'tr-TR', uk: 'uk-UA', vi: 'vi-VN', zh: 'zh-CN',
};
/** The regional ones it knows apart from those. */
const NEMOTRON_REGIONAL = { 'en-gb': 'en-GB', 'es-us': 'es-US', 'es-419': 'es-US', 'es-mx': 'es-US', 'fr-ca': 'fr-CA', 'pt-br': 'pt-BR' };

/** What Qwen3-ASR hears, either size, by the codes it is told a language with. */
const QWEN_LANGUAGES = ['zh', 'en', 'yue', 'ar', 'de', 'fr', 'es', 'pt', 'id', 'it', 'ko', 'ru', 'th', 'vi', 'ja', 'tr', 'hi', 'ms', 'nl', 'sv', 'da', 'fi', 'pl', 'cs', 'fil', 'fa', 'el', 'hu', 'mk', 'ro'];

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
  'qwen3-asr-1.7b-q8': {
    file: 'qwen3-asr-1.7b-q8_0.gguf',
    url: 'https://huggingface.co/audio-cpp/audio.cpp-gguf/resolve/e36610ac69b5262e914a52635324050bee8f1ad2/Qwen3-ASR-1.7B-GGUF/qwen3-asr-1.7b-q8_0.gguf',
    bytes: 2473010048,
    sha256: 'da4fc2ac7f24dee784d1684eb1f35836cdbf559519452ae11777670734c0a4f8',
    family: 'qwen3_asr',
    // It reads a stretch at once (its own "streaming" writes once in thirty seconds): ten seconds of speech take
    // 0.2-0.5 s on an RTX 5070 Ti and about 1.5 s on an Apple M2 (measured 2026-10-05).
    mode: 'offline',
    // It is told the language by its code, and these are the ones it hears.
    languageAs: 'code',
    languages: QWEN_LANGUAGES,
  },
  // The small one, for a computer that runs a game beside it: about 2 GB of video memory where the 1.7B holds 3, a
  // reading a quarter shorter, and more characters wrong (FORK.md, "小模型"). The same family, read the same way.
  'qwen3-asr-0.6b-q8': {
    file: 'qwen3-asr-0.6b-q8_0.gguf',
    url: 'https://huggingface.co/audio-cpp/audio.cpp-gguf/resolve/e36610ac69b5262e914a52635324050bee8f1ad2/Qwen3-ASR-0.6B-GGUF/qwen3-asr-0.6b-q8_0.gguf',
    bytes: 1151272416,
    sha256: '6c44ec2fb4cee513892d7863c1fcc3ea6b699ffa4d899b0ef4ab19956d9544f7',
    family: 'qwen3_asr',
    mode: 'offline',
    languageAs: 'code',
    languages: QWEN_LANGUAGES,
  },
  // The smallest: about 1 GB of video memory, and ten seconds of speech read in 0.15 s on an RTX 5070 Ti. As
  // accurate as the small Qwen3 on a whole clip, but of the sentences the app cuts it writes nothing for one short
  // one in five (FORK.md, "小模型"): the last choice, for a computer with no memory for another. Read a stretch at
  // a time, as Qwen3-ASR is: a reading costs it so little that its own streaming would save nothing worth a second
  // path.
  'nemotron-asr-0.6b-q8': {
    file: 'nemotron-3.5-asr-streaming-0.6b-q8_0.gguf',
    url: 'https://huggingface.co/audio-cpp/audio.cpp-gguf/resolve/e36610ac69b5262e914a52635324050bee8f1ad2/Nemotron-3.5-ASR-Streaming-0.6B-GGUF/nemotron-3.5-asr-streaming-0.6b-q8_0.gguf',
    bytes: 930625888,
    sha256: 'c58b62c1bdd6c5d7b14b08126c5bd16c1289fee6e0d6ac0761dbd3aa6d714935',
    family: 'nemotron_asr',
    mode: 'offline',
    // It is told the language by a locale of its own list, and is not left to detect one: left to, it wrote the
    // first words of a Japanese stretch as an English letter.
    languageAs: 'locale',
    languages: Object.keys(NEMOTRON_LOCALES),
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

/**
 * The chat models that give the grammar feedback, run by the same server: each a Q4_K_M file at a fixed revision.
 * Gemma 4 E2B is the one that, of the small models measured 2026-10-05, caught most mistakes without "correcting"
 * right casual speech (FORK.md, "原生语法反馈引擎").
 */
const COACHES = {
  'gemma-4-e2b': {
    file: 'gemma-4-E2B-it-Q4_K_M.gguf',
    url: 'https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/resolve/0314792d7f1f7e229411f620751375812bb9faf2/gemma-4-E2B-it-Q4_K_M.gguf',
    bytes: 3106738272,
    sha256: '740185b21d22ceb83a11c3aa62ad5842ef32c70f6096d756bbee85a1e4ec34b8',
  },
};

/** The model the runtime is told the language by: its name in English, as R2T2 was trained to read it. Any other is left to detection. */
const LANGUAGE_NAMES = {
  ja: 'Japanese', zh: 'Chinese', en: 'English', ko: 'Korean', fr: 'French', de: 'German', it: 'Italian', pt: 'Portuguese', ru: 'Russian', es: 'Spanish', ar: 'Arabic',
};
const languageCode = (code) => /^[a-z]{2,8}$/.exec(String(code ?? '').trim().toLowerCase().split(/[-_]/)[0])?.[0] ?? null;
const languageName = (code) => LANGUAGE_NAMES[languageCode(code) ?? ''] ?? null;
/** The locale Nemotron is told for a language of the app: its own regional one where it has it, the language's usual one otherwise. */
const languageLocale = (code) => NEMOTRON_REGIONAL[String(code ?? '').trim().toLowerCase().replace('_', '-')] ?? NEMOTRON_LOCALES[languageCode(code) ?? ''] ?? null;
/** Whether a model of the list above hears a language: one that lists its languages by those, any other by the names it was taught. */
const modelHears = (id, code) => (MODELS[id]?.languages ? MODELS[id].languages.includes(languageCode(code) ?? '') : Boolean(MODELS[id]) && languageName(code) !== null);

/** How long the runtime may take to load a model and answer. */
const READY_TIMEOUT_MS = 240_000;
const READY_POLL_MS = 400;
/** How long the first stretch of sound may take to come back: the slow one, after the computer starts. */
const WARM_TIMEOUT_MS = 240_000;
const STOP_PATIENCE_MS = 3000;
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

/**
 * Unpacks an archive with it, from inside the folder it goes to, so that neither is spelled out: a user folder with
 * letters outside the system's code page reaches this program as question marks, and it opens nothing (seen
 * 2026-10-06 on Windows, a folder named in Korean on a Chinese system; from inside the folder it unpacked).
 */
function untar(archive, into) {
  return new Promise((resolve, reject) => {
    execFile(systemTar(), ['-xf', path.relative(into, archive), '-C', '.'], { cwd: into, windowsHide: true }, (error) => (error ? reject(error) : resolve()));
  });
}

/** The name of the program a process runs, in small letters; null where there is no such process or it cannot be asked. */
function imageOfPid(pid, platform = process.platform, env = process.env) {
  return new Promise((resolve) => {
    if (platform === 'win32') {
      execFile(path.win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'tasklist.exe'), ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true }, (error, out) => {
        const found = error ? null : /^"([^"]+)","(\d+)"/m.exec(String(out));
        resolve(found && Number(found[2]) === pid ? found[1].toLowerCase() : null);
      });
      return;
    }
    execFile('/bin/ps', ['-p', String(pid), '-o', 'comm='], (error, out) => {
      const name = error ? '' : path.posix.basename(String(out).trim());
      resolve(name ? name.toLowerCase() : null);
    });
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
function loopPost(port, pathname, json, timeoutMs = 60_000, key = null) {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify(json));
    const request = http.request({ host: LOOPBACK, port, method: 'POST', path: pathname, timeout: timeoutMs, headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length, Authorization: `Bearer ${key || 'no-key'}` } }, (response) => {
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
      models: [{ id, family: model.family, path: model.file, task: 'asr', mode: model.mode, session_options: model.options ?? {} }],
    }, null, 1));
    return ['--config', 'server.json', '--no-ui'];
  },
  warm({ port, id, model, live, window, timeoutMs }) {
    return new Promise((resolve) => {
      let timer = null;
      let stream = null;
      const done = (ok) => { clearTimeout(timer); resolve(ok); };
      timer = setTimeout(() => { stream?.abort(); done(false); }, timeoutMs);
      stream = (model?.mode === 'offline' ? window : live)({ port, model: id, sampleRate: 16000, language: null, timeoutMs }, (event) => {
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
  /**
   * It answers only who has the key of this run. Without one it answers every page open in a browser of this
   * computer — its answers to another origin carry that origin's leave — and a name on the internet pointed at
   * 127.0.0.1 besides.
   */
  keyed: true,
  launch({ model, port, key }) {
    return ['-m', model.file, '--host', LOOPBACK, '--port', String(port), '-ngl', '99', '-c', String(model.context ?? 4096), '--no-webui', '--no-slots', ...(key ? ['--api-key', key] : [])];
  },
  async warm({ port, post, timeoutMs, key }) {
    const answer = await post(port, '/v1/chat/completions', { messages: [{ role: 'user', content: 'Hello' }], max_tokens: 4, temperature: 0, chat_template_kwargs: { enable_thinking: false } }, timeoutMs, key);
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

/** A stretch of 16-bit mono sound as a WAV file. */
function wavOf(pcm, sampleRate) {
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(sampleRate, 24);
  head.writeUInt32LE(sampleRate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}

/**
 * One stretch of sound read whole by the runtime (POST /v1/audio/transcriptions, a form): `done` resolves with
 * `{ ok, text }` or `{ ok: false, message }`, and `abort` drops the request.
 */
function readWhole({ port, model, sampleRate, language, pcm, timeoutMs }) {
  const boundary = `----kotomimi${crypto.randomBytes(12).toString('hex')}`;
  const field = (name, value) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  const body = Buffer.concat([
    field('model', model),
    ...(language ? [field('language', language)] : []),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="stretch.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
    wavOf(pcm, sampleRate),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  let request = null;
  const done = new Promise((resolve) => {
    request = http.request({ host: LOOPBACK, port, method: 'POST', path: '/v1/audio/transcriptions', timeout: timeoutMs, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length } }, (response) => {
      let answer = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { if (answer.length < 400_000) answer += chunk; });
      response.on('end', () => {
        if (response.statusCode !== 200) { resolve({ ok: false, message: `The engine answered HTTP ${response.statusCode}: ${answer.replace(/\s+/g, ' ').slice(0, 200)}` }); return; }
        let text = answer;
        try { text = JSON.parse(answer)?.text ?? ''; } catch { /* the text itself */ }
        resolve({ ok: true, text: String(text).trim() });
      });
      response.on('error', (error) => resolve({ ok: false, message: error.message }));
    });
    request.on('timeout', () => { request.destroy(); resolve({ ok: false, message: 'The engine did not answer in time.' }); });
    request.on('error', (error) => resolve({ ok: false, message: error.message }));
    request.end(body);
  });
  return { done, abort: () => request?.destroy() };
}

/**
 * Where a reading begins to say one thing over and over, or -1. Such a model now and then loses its way at some
 * point of a stretch and writes the same few characters until it is stopped (measured 2026-10-05: 「波で」 two hundred
 * and fifty times, three seconds of writing, for one stretch in about a hundred — and for that stretch at some lengths
 * only). Nothing after that point is the speech.
 *
 * It is told from what people say by how it ends: a model that lost its way writes on until it is stopped, so the
 * repeating runs to the end of the reading and is long. A number written in digits (「1400000000人」), a laugh
 * (「哈哈哈哈哈哈哈哈」), a 「はいはいはいはい…」 are short, and more speech follows them.
 */
const LOOP = /(.{1,20}?)\1{7,}/gsu;
/** The repeating is at least this long in all… */
const LOOP_CHARS = 40;
/** …and no more than this follows it: a piece of the thing repeated, cut off. */
const LOOP_REST_CHARS = 20;
function lostAt(text) {
  for (const found of String(text).matchAll(LOOP)) {
    if (found[0].length >= LOOP_CHARS && text.length - (found.index + found[0].length) <= LOOP_REST_CHARS) return found;
  }
  return null;
}
function loopAt(text) {
  return lostAt(text)?.index ?? -1;
}
/** A reading up to where it lost its way, with the thing it repeated said once. */
function unloop(text) {
  const found = lostAt(text);
  return found ? (text.slice(0, found.index) + found[1]).trim() : text;
}

/** Two halves of a stretch, as one text: with a space between them, except where the writing has none between its words. */
const UNSPACED = /[\u3000-\u30ff\u3400-\u9fff\uff00-\uffef]/u;
function joinHalves(first, second) {
  if (!first || !second) return first || second;
  return UNSPACED.test(first.at(-1)) || UNSPACED.test(second[0]) ? first + second : `${first} ${second}`;
}

/**
 * Where to cut a stretch in two for reading the halves apart: the quietest fifth of a second in its middle third,
 * as a count of bytes from its start.
 */
function quietMiddle(pcm, sampleRate) {
  const frame = Math.round(sampleRate * 0.02) * 2;
  const frames = Math.floor(pcm.length / frame);
  const peaks = new Array(frames);
  for (let f = 0; f < frames; f += 1) {
    let peak = 0;
    for (let i = f * frame; i < (f + 1) * frame; i += 2) { const size = Math.abs(pcm.readInt16LE(i)); if (size > peak) peak = size; }
    peaks[f] = peak;
  }
  const span = 10;
  let best = Math.floor(frames / 2);
  let least = Infinity;
  for (let f = Math.floor(frames / 3); f + span <= Math.ceil((frames * 2) / 3); f += 1) {
    let loudest = 0;
    for (let k = f; k < f + span; k += 1) if (peaks[k] > loudest) loudest = peaks[k];
    if (loudest < least) { least = loudest; best = f + span / 2; }
  }
  return best * frame;
}

/** A stretch shorter than this is not cut in two: its halves would be too short to read. */
const LOOP_SPLIT_SECONDS = 4;
/** The silence put before a stretch that is read again. */
const LOOP_LEAD_SECONDS = 0.5;

/** A reading is asked for this long after the last one came back — or as long as that one took, where that is longer: a slow computer reads less often, and is never behind for it. */
const WINDOW_REST_MS = 600;
/** …and only once this much new sound has come. */
const WINDOW_NEW_SECONDS = 0.4;
/**
 * A reading that left out only this much of the end, with nothing loud in what it left out — the pause that ended
 * the stretch — is the last one: the stretch is not read again for its silence.
 */
const WINDOW_TAIL_SECONDS = 3;
const WINDOW_QUIET_PEAK = 600;
const WINDOW_QUIET_OF_PEAK = 0.1;
/**
 * …and "nothing loud" is never louder than this (about -30 dB of full scale), however loud the stretch was: a word
 * said softly after a laugh is a tenth of the laugh, and is still a word.
 */
const WINDOW_QUIET_MOST = 1000;
const WINDOW_READ_TIMEOUT_MS = 30_000;
/** Once the stretch has ended, a reading that lost its way is read in halves only while no more than this has passed: the page waits for the last words, not for ever. */
const WINDOW_LAST_MS = 8000;
/** A stretch is never longer than this: the page ends one long before, and what it never ends is not kept for ever. */
const WINDOW_MOST_SECONDS = 120;

/**
 * A recognition by a model that reads a whole stretch at once, with the
 * interface of a live one (`openLive`): `write` takes the sound as it comes,
 * and while it comes the stretch so far is read again and again — each reading
 * goes out as `{ type: 'partial', text }`, everything heard so far, which the
 * next may write otherwise. `end` has it read once more, to `{ type: 'done',
 * text }` — unless the last reading already had all but the closing silence.
 */
function openWindow({ port, model, sampleRate, language, timeoutMs = WINDOW_READ_TIMEOUT_MS, read = readWhole, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout, note = () => {} }, onEvent) {
  const chunks = [];
  let bytes = 0;
  /** The loudest sample so far, and the loudest that no reading has had yet. */
  let peak = 0;
  let unreadPeak = 0;
  /** How much of the sound the reading under way — or the last — was given, and what it wrote; null where it wrote nothing to keep (it failed, or lost its way). */
  let readBytes = 0;
  let lastText = null;
  let lastTook = 0;
  let reading = null;
  let timer = null;
  let ended = false;
  let endedAt = 0;
  let over = false;

  const finish = (event) => {
    if (over) return;
    over = true;
    if (timer) clearTimer(timer);
    timer = null;
    onEvent(event);
  };
  /** What no reading has had is the silence after the voice. */
  const restIsQuiet = () => bytes - readBytes <= WINDOW_TAIL_SECONDS * sampleRate * 2 && unreadPeak <= Math.max(WINDOW_QUIET_PEAK, Math.min(WINDOW_QUIET_MOST, peak * WINDOW_QUIET_OF_PEAK));

  /** One more reading, of this sound; `then` is given its answer unless the recognition was dropped meanwhile. */
  function ask(pcm, then) {
    const mine = read({ port, model, sampleRate, language, pcm, timeoutMs });
    reading = mine;
    mine.done.then((answer) => {
      if (reading === mine) reading = null;
      if (!over) then(answer);
    });
  }

  /**
   * The last reading of a stretch the model lost its way in. Where it does that depends on where the stretch begins
   * and ends, so it is read again with half a second of silence before it, which was enough where this was measured;
   * and if it still repeats, in two halves cut at a quiet moment — a half that repeats is cut where it begins to,
   * and what the other half heard is kept.
   */
  function reread(sound, whole) {
    ask(Buffer.concat([Buffer.alloc(Math.round(sampleRate * LOOP_LEAD_SECONDS) * 2), sound]), (again) => {
      if (again.ok && loopAt(again.text) < 0) { finish({ type: 'done', text: again.text }); return; }
      const at = sound.length >= LOOP_SPLIT_SECONDS * sampleRate * 2 && now() - endedAt <= WINDOW_LAST_MS ? quietMiddle(sound, sampleRate) : 0;
      if (at <= 0 || at >= sound.length) { finish({ type: 'done', text: unloop(whole) }); return; }
      ask(sound.subarray(0, at), (first) => {
        // A half that cannot be read leaves what the whole had before it lost its way.
        if (!first.ok) { finish({ type: 'done', text: unloop(whole) }); return; }
        ask(sound.subarray(at), (second) => {
          finish({ type: 'done', text: joinHalves(unloop(first.text), second.ok ? unloop(second.text) : '').trim() });
        });
      });
    });
  }

  function start(last) {
    const started = now();
    readBytes = bytes;
    unreadPeak = 0;
    const sound = Buffer.concat(chunks, bytes);
    const mine = read({ port, model, sampleRate, language, pcm: sound, timeoutMs });
    reading = mine;
    mine.done.then((answer) => {
      if (reading === mine) reading = null;
      if (over) return;
      const took = now() - started;
      if (answer.ok) lastTook = took;
      const lost = answer.ok && loopAt(answer.text) >= 0;
      if (lost) note(`A reading of ${(sound.length / 2 / sampleRate).toFixed(1)} s lost its way after ${loopAt(answer.text)} characters, and took ${took} ms${last ? ': the last one, read again' : ''}.
`);
      // A reading that lost its way is not one to end on.
      lastText = answer.ok && !lost ? answer.text : null;
      // The stretch ended while this was read: it is the last reading if it had all the voice, else one more is.
      if (ended) {
        if (!answer.ok) { if (last) finish({ type: 'error', message: answer.message }); else start(true); }
        else if (lost) { if (last) reread(sound, answer.text); else start(true); }
        else if (last || restIsQuiet()) finish({ type: 'done', text: answer.text });
        else start(true);
        return;
      }
      if (answer.ok && answer.text) onEvent({ type: 'partial', text: unloop(answer.text) });
      plan();
    });
  }

  function plan() {
    if (over || ended || reading || timer) return;
    timer = setTimer(() => {
      timer = null;
      if (over || ended || reading) return;
      if (bytes - readBytes >= WINDOW_NEW_SECONDS * sampleRate * 2) start(false);
      else plan();
    }, Math.max(WINDOW_REST_MS, lastTook));
  }

  return {
    write(pcm) {
      if (over || ended || !pcm?.length) return;
      const sound = Buffer.from(pcm);
      for (let i = 0; i + 1 < sound.length; i += 2) {
        const size = Math.abs(sound.readInt16LE(i));
        if (size > unreadPeak) unreadPeak = size;
      }
      if (unreadPeak > peak) peak = unreadPeak;
      chunks.push(sound);
      bytes += sound.length;
      if (bytes > WINDOW_MOST_SECONDS * sampleRate * 2) {
        reading?.abort();
        finish({ type: 'error', message: 'The stretch of speech is too long to read.' });
        return;
      }
      plan();
    },
    end() {
      if (over || ended) return;
      ended = true;
      endedAt = now();
      if (timer) clearTimer(timer);
      timer = null;
      // A reading under way decides when it comes back.
      if (reading) return;
      if (bytes === 0) finish({ type: 'done', text: '' });
      else if (lastText !== null && restIsQuiet()) finish({ type: 'done', text: lastText });
      else start(true);
    },
    abort() {
      over = true;
      if (timer) clearTimer(timer);
      timer = null;
      reading?.abort();
    },
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
    window = openWindow,
    /** How the runtime is started and warmed: audio.cpp's way, unless another is handed in. */
    runtime = AUDIO_RUNTIME,
    setPriority = (pid, priority) => { try { os.setPriority(pid, priority); } catch { /* a courtesy to the rest of the computer, never a condition */ } },
    /** What a process left by an earlier run of the app is known by, and how it is ended. */
    imageOf = imageOfPid,
    killPid = (pid) => process.kill(pid),
    /** A runtime told to stop is waited for this long, then told so that it cannot refuse. */
    stopPatienceMs = STOP_PATIENCE_MS,
    env = process.env,
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
  /**
   * The models this system is offered: one that names its systems is offered on those alone. A list with nothing
   * behind it: the page names a model by its id, and `constructor` is no model.
   */
  const MODELS_ = Object.assign(Object.create(null), Object.fromEntries(Object.entries(catalog.models).filter(([, model]) => !model.platforms || model.platforms.includes(system))));

  // A system with no model to run has no use for the runtime either.
  const build = Object.keys(MODELS_).length > 0 ? ENGINE_.builds[system] ?? null : null;
  const engineDir = path.join(dir, `engine-${ENGINE_.version}`);
  const modelsDir = path.join(dir, 'models');
  const exe = build ? path.join(engineDir, build.exe) : null;
  const fileOf = (id) => path.join(modelsDir, MODELS_[id].file);
  const has = (file) => { try { return files.statSync(file).isFile(); } catch { return false; } };
  const sizeOf = (file) => { try { return files.statSync(file).size; } catch { return 0; } };
  /**
   * The runtime is being unpacked while this file is beside it. An unpacking that stopped halfway — the app closed,
   * the disk full, the archive refused — can leave the program and not the libraries it needs: with this left
   * behind, that is not a runtime, and it is fetched again.
   */
  const unpackingMark = build ? path.join(engineDir, '.unpacking') : null;
  const engineReady = () => Boolean(exe) && has(exe) && !has(unpackingMark);
  /** The runtime that is up, written down: what the next run of the app ends, should this one go without ending it. */
  const runFile = path.join(dir, 'run.json');
  /** The runtime's own surroundings: none of the settings a person keeps for a llama.cpp of their own (a key among them, which it would then ask of the app). */
  const childEnv = Object.fromEntries(Object.entries(env).filter(([name]) => !/^LLAMA_/i.test(name)));

  let child = null;
  let tail = [];
  let run = { state: 'stopped', model: null, port: 0, key: null, tail: '' };
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
    engine: !build ? 'unsupported' : fetching.has('engine') || unpacking ? 'downloading' : engineReady() ? 'ready' : 'absent',
    engineBytes: build?.bytes ?? 0,
    models: Object.fromEntries(Object.keys(MODELS_).map((id) => [id, modelState(id)])),
    run: { ...run },
    // The models that can be asked now: the one the runtime is up with.
    up: run.state === 'ready' && run.model ? [run.model] : [],
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
        const reader = response.body.getReader();
        let whole = false;
        try {
          for (;;) {
            const { done, value } = await Promise.race([reader.read(), failedWrite]);
            if (done) break;
            if (!out.write(Buffer.from(value))) await Promise.race([new Promise((resolve) => out.once('drain', resolve)), failedWrite]);
            state.received += value.byteLength;
            if (state.received > bytes) throw new Error('The download is larger than the file expected.');
            tell(false);
          }
          whole = true;
        } finally {
          // Whatever stopped it, the rest of the answer is not waited for.
          if (!whole) Promise.resolve(reader.cancel()).catch(() => {});
          await new Promise((resolve) => out.end(resolve));
        }
        // An answer that ended early without saying so: what came is kept, and the next attempt goes on from it.
        if (sizeOf(part) < bytes) throw new Error('The download stopped before the end. Start it again to go on.');
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
    if (engineReady()) return;
    files.mkdirSync(engineDir, { recursive: true });
    const archive = path.join(engineDir, build.archive);
    await fetchFile('engine', build, archive);
    unpacking = true;
    tell();
    let whole = false;
    try {
      // What an unpacking that stopped halfway left is not built upon.
      for (const name of files.readdirSync(engineDir)) {
        if (name !== build.archive) files.rmSync(path.join(engineDir, name), { recursive: true, force: true });
      }
      files.writeFileSync(unpackingMark, '');
      await extract(archive, engineDir);
      // The program itself, not a link to one somewhere else.
      whole = files.lstatSync(exe).isFile();
      if (whole) files.rmSync(unpackingMark, { force: true });
    } catch (error) {
      note(`The engine could not be unpacked: ${String(error?.message ?? error)}\n`);
    } finally {
      unpacking = false;
      files.rmSync(archive, { force: true });
    }
    if (!whole) throw new Error('The engine could not be unpacked.');
    if (platform !== 'win32') { try { files.chmodSync(exe, 0o755); } catch { /* already runnable, or it will say so when run */ } }
  }

  /** The runtime and a model, fetched: resolves with the state of things, which says what failed. */
  async function download(id) {
    if (!build || !MODELS_[id] || fetching.has(id) || fetching.has('engine') || unpacking) return status();
    try {
      engineFor = id;
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

  /** The model whose download is fetching the runtime: stopping another's leaves it. */
  let engineFor = null;
  function cancel(id) {
    fetching.get(id)?.abort();
    if (engineFor === id) fetching.get('engine')?.abort();
    return status();
  }

  async function remove(id) {
    if (!MODELS_[id]) return status();
    cancel(id);
    // Up with it, or on the way up: the runtime has ended before its file is deleted — Windows deletes no file a process holds.
    if (run.model === id || starting?.id === id) await stop();
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

  /**
   * Each start and each stop is a turn. A start waits more than once — for the runtime before it to end, for a port —
   * and another start, or a stop, may come meanwhile: the one that finds it is no longer the last gives way, and
   * starts nothing. Two starts that crossed would otherwise each start a runtime, and only the second be known of:
   * the first would hold its video memory until the computer is restarted.
   */
  let turn = 0;

  /** A runtime told to end, and waited for: told again so that it cannot refuse when it has not gone in a while, and not waited for beyond that. */
  function letGo(proc) {
    return new Promise((resolve) => {
      let hard = null;
      let last = null;
      const done = () => { clearTimeout(hard); clearTimeout(last); forget(proc.pid); resolve(); };
      proc.once('exit', done);
      try { proc.kill(); } catch { done(); return; }
      hard = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone already */ } }, stopPatienceMs);
      last = setTimeout(done, stopPatienceMs + 2000);
      hard.unref?.();
      last.unref?.();
    });
  }

  /** The note of the runtime that is up, taken away once that one has ended. */
  function forget(pid) {
    try {
      if (JSON.parse(files.readFileSync(runFile, 'utf8'))?.pid === pid) files.rmSync(runFile, { force: true });
    } catch { /* none, or not this one's */ }
  }

  /**
   * A runtime an earlier run of the app left running — it crashed, or was ended from the task manager, and its
   * runtimes are processes of their own — is ended: it holds gigabytes of video memory that nothing else would
   * give back. Only a process that still runs this engine's program: the number alone may be another's by now.
   */
  async function reap() {
    let left = null;
    try { left = JSON.parse(files.readFileSync(runFile, 'utf8')); } catch { return; }
    try {
      if (exe && Number.isInteger(left?.pid) && left.pid > 0 && (await imageOf(left.pid)) === path.basename(exe).toLowerCase()) {
        killPid(left.pid);
        note(`A runtime left by an earlier run (process ${left.pid}) was ended.\n`);
      }
    } catch { /* gone already, or not ours to end */ }
    try { files.rmSync(runFile, { force: true }); } catch { /* a note, not a condition */ }
  }
  const reaped = reap();
  /** Every runtime that was told to end has ended. */
  let leaving = Promise.resolve();

  /** The runtime let go, with every recognition it had open told so: resolves once its process has ended — its video memory is free, and its files can be deleted. */
  function halt() {
    const mine = child;
    child = null;
    // Told, as when the runtime goes by itself: the page otherwise sends sound into nothing and waits for last words that never come.
    for (const [streamId, stream] of streams) { stream.abort(); undump(streamId); onStream({ id: streamId, type: 'error', message: 'The recognition engine was stopped.' }); }
    streams.clear();
    // Whatever is still on its way out is waited for too: a stop and a start asked at once are two halts, and the second finds nothing to end.
    if (mine) leaving = Promise.all([leaving, letGo(mine)]).then(() => {});
    if (run.state !== 'stopped') setRun({ state: 'stopped', model: null, port: 0, key: null });
    return leaving;
  }

  async function bringUp(id) {
    turn += 1;
    const myTurn = turn;
    await halt();
    await reaped;
    if (myTurn !== turn) return status();
    if (!engineReady() || !has(fileOf(id))) return setRun({ state: 'failed', model: id, tail: 'The model is not downloaded.' });
    tail = [];
    let port;
    try {
      port = await freePort();
    } catch (error) {
      if (myTurn !== turn) return status();
      return setRun({ state: 'failed', model: id, tail: String(error?.message ?? error) });
    }
    if (myTurn !== turn) return status();
    const key = runtime.keyed ? crypto.randomBytes(24).toString('hex') : null;
    setRun({ state: 'starting', model: id, port, key, tail: '' });
    const model = MODELS_[id];
    let mine;
    try {
      mine = spawn(exe, runtime.launch({ id, model, port, key, build, modelsDir, files }), { cwd: modelsDir, env: childEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      return setRun({ state: 'failed', tail: String(error?.message ?? error) });
    }
    child = mine;
    if (mine.pid) { try { files.writeFileSync(runFile, JSON.stringify({ pid: mine.pid })); } catch { /* a note, not a condition */ } }
    let exited = false;
    const ended = (code) => {
      if (exited) return;
      exited = true;
      forget(mine.pid);
      if (child !== mine) return;
      child = null;
      for (const [streamId, stream] of streams) { stream.abort(); undump(streamId); onStream({ id: streamId, type: 'error', message: 'The recognition engine stopped.' }); }
      streams.clear();
      if (run.state !== 'stopped') setRun({ state: code === 0 ? 'stopped' : 'failed', tail: tail.join('\n') });
    };
    mine.stdout?.on('data', note);
    mine.stderr?.on('data', note);
    mine.stdout?.on('error', () => {});
    mine.stderr?.on('error', () => {});
    mine.on('error', (error) => { note(error.message); ended(1); });
    mine.on('exit', ended);
    // Loading and warming give way to whatever else is going on; hearing does not. On Windows only: elsewhere a
    // process that has stepped back may not step forward again unless it is the system's own, and would hear at a
    // disadvantage for good.
    const yields = platform === 'win32' && Boolean(mine.pid);
    if (yields) setPriority(mine.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);

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
    const warmed = await Promise.resolve(runtime.warm({ port, id, model, key, live, window, post, timeoutMs: warmTimeoutMs })).catch(() => false);
    if (child !== mine) return status();
    if (yields) setPriority(mine.pid, os.constants.priority.PRIORITY_NORMAL);
    // A warm-up that did not come back is not a reason to refuse: the first sentence will be the slow one.
    if (!warmed) note('The warm-up did not finish.');
    return setRun({ state: 'ready' });
  }

  async function stop() {
    turn += 1;
    await halt();
    return status();
  }

  /** A live recognition opened for the page: its id, or null while the runtime is not ready — or is up with another model than the one asked for. */
  const dumps = new Map();
  function openStream({ language, sampleRate, model: asked } = {}) {
    if (run.state !== 'ready' || !run.model) return null;
    if (typeof asked === 'string' && asked && asked !== run.model) return null;
    const id = nextStream++;
    const rate = Number.isInteger(sampleRate) && sampleRate >= 8000 && sampleRate <= 48000 ? sampleRate : 16000;
    const model = MODELS_[run.model];
    // A model that reads a stretch at once is given it as it grows; one told the language by its code, or by a
    // locale, is told that.
    const windowed = model?.mode === 'offline';
    const said = model?.languageAs === 'code' ? languageCode(language) : model?.languageAs === 'locale' ? languageLocale(language) : languageName(language);
    const target = { port: run.port, model: run.model, sampleRate: rate, language: said };
    const stream = (windowed ? window : live)(windowed ? { ...target, note } : target, (event) => {
      if (event.type !== 'delta' && event.type !== 'partial') streams.delete(id);
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

module.exports = { createNativeEngine, openLive, openWindow, wavOf, loopAt, unloop, joinHalves, imageOfPid, quietMiddle, languageName, languageCode, languageLocale, modelHears, systemTar, ENGINE, MODELS, LLAMA, TRANSLATORS, COACHES, AUDIO_RUNTIME, LLAMA_RUNTIME, LOOPBACK };
