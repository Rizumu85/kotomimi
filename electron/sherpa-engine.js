// Fork: the CPU recognizers, in the official sherpa-onnx processes: X-ASR, streaming, and SenseVoice-Small, which
// reads a stretch at a time.
const path = require('node:path');
const WebSocket = require('ws');
const { createNativeEngine, openWindow, AUDIO_RUNTIME } = require('./native-engine');

const MODEL_ID = 'x-asr-zh-en';
const REVISION = '689ff18c584d29910da37b6fe904db0c1489c9d1';
// 480 ms / one inference thread leaves more CPU for the game than 160 ms or extra threads.
const FILES = [
  ['encoder-480ms.onnx', 592968361, '0c3454033d249081df124ddcd7adaf3deca07d0b999b26f2ee5d2475d37abc74'],
  ['decoder-480ms.onnx', 11309084, '3658368d274a5d5fd39a7ac20c46bed0ad9cfea1f0feddef30d5d89797c1f499'],
  ['joiner-480ms.onnx', 10260467, '03781c98165a2385024c9cecdd2b6b13310d81db23a62c7da420782c2915cf81'],
  ['tokens.txt', 58806, 'b818a60878b9aae978cbb8ad594acbd403d76d1af2e31ef4197c84e2dbdba27c'],
].map(([file, bytes, sha256]) => ({ file, bytes, sha256, url: `https://huggingface.co/GilgameshWind/X-ASR-zh-en/resolve/${REVISION}/deployment/models/chunk-480ms-model/${file}` }));
/**
 * SenseVoice-Small as sherpa-onnx runs it, 8-bit: Chinese, English, Japanese, Korean and Cantonese on the processor,
 * for a side heard here while the graphics card's model hears the other. On the stretches the app cuts it has 21.2 %
 * of the characters wrong, against 20.3 % for the graphics card's own (measured 2026-11-15, 59 stretches), and reads
 * a second of sound in about a tenth of one on two threads. Its files are kept under names of their own: the folder
 * is X-ASR's too, and both have a `tokens.txt`.
 */
const SENSE_ID = 'sensevoice-small-cpu';
const SENSE_REVISION = '2365baeacb507f821a0c8120fcee3d484dba7a07';
const SENSE_FILES = [
  ['sensevoice-small-int8.onnx', 239233841, 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51', 'model.int8.onnx'],
  ['sensevoice-small-tokens.txt', 315894, 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc', 'tokens.txt'],
].map(([file, bytes, sha256, name]) => ({ file, bytes, sha256, url: `https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/${SENSE_REVISION}/${name}` }));
const MODELS = {
  [MODEL_ID]: { file: FILES[0].file, files: FILES, bytes: FILES.reduce((sum, part) => sum + part.bytes, 0), languages: ['zh', 'en'], mode: 'streaming' },
  // `offline`: read a stretch at a time, as it grows (`openWindow`); it puts spaces between what it hears in pieces.
  [SENSE_ID]: { file: SENSE_FILES[0].file, files: SENSE_FILES, bytes: SENSE_FILES.reduce((sum, part) => sum + part.bytes, 0), languages: ['zh', 'en', 'ja', 'ko', 'yue'], mode: 'offline', unspaced: true },
};
const build = (name, bytes, sha256, exe) => ({
  url: `https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.1/${name}.tar.bz2`,
  bytes, sha256, archive: 'engine.tar.bz2', exe: `${name}/bin/${exe}`, backend: 'cpu',
  // The same archive's server for a model that reads a stretch at a time.
  offline: `${name}/bin/${exe.replace('online', 'offline')}`,
});
const ENGINE = { version: '2.0.1', builds: {
  'win32-x64': build('sherpa-onnx-v2.0.1-win-x64-shared-MD-MinSizeRel-no-tts', 18047922, '5520c214fae80ae40d37b3581bd67446d7c8ae8e3f25a6db916be1fc2860946a', 'sherpa-onnx-online-websocket-server.exe'),
  'darwin-arm64': build('sherpa-onnx-v2.0.1-osx-arm64-shared-no-tts', 18663994, '4fcc6c77c8d8d2e2f04cfdc17c6fd224c01469b78529370eb9d8e0e5ec97ac79', 'sherpa-onnx-online-websocket-server'),
} };

const RUNTIME = {
  program: ({ model, build, engineDir }) => (model?.mode === 'offline' ? path.join(engineDir, build.offline) : null),
  launch({ port, build, model }) {
    const quiet = `--log-file=${(build ? build.exe.endsWith('.exe') : process.platform === 'win32') ? 'NUL' : '/dev/null'}`;
    // Two threads: a second of sound in a tenth of one, where one thread takes a sixth (measured 2026-11-15).
    if (model?.mode === 'offline') {
      return [`--port=${port}`, '--provider=cpu', '--num-threads=2', '--num-work-threads=1', '--num-io-threads=1', '--max-batch-size=1',
        `--sense-voice-model=${model.files[0].file}`, `--tokens=${model.files[1].file}`, '--sense-voice-language=auto', '--sense-voice-use-itn=true', quiet];
    }
    return [`--port=${port}`, '--provider=cpu', '--num-threads=1', '--num-work-threads=1', '--num-io-threads=1',
      '--max-batch-size=1', '--loop-interval-ms=1', '--model-type=zipformer2', '--decoding-method=greedy_search',
      '--enable-endpoint=false', '--tokens=tokens.txt', '--encoder=encoder-480ms.onnx',
      '--decoder=decoder-480ms.onnx', '--joiner=joiner-480ms.onnx', `--log-file=${(build ? build.exe.endsWith('.exe') : process.platform === 'win32') ? 'NUL' : '/dev/null'}`];
  },
  warm: AUDIO_RUNTIME.warm,
};

/** The transducer has no language-id output. Within its two languages, Han text is Chinese, Latin-only English. */
function languageOf(text) {
  return /\p{Script=Han}/u.test(text) ? 'zh' : /\p{Script=Latin}/u.test(text) ? 'en' : null;
}

/** One socket per utterance. The app cuts the utterance; only EOF, never a partial, closes it. */
function openSherpa({ port, sampleRate }, onEvent, Socket = WebSocket) {
  let over = false;
  let ended = false;
  let sentEnd = false;
  let pending = [];
  let queued = 0;
  let previous = '';
  const socket = new Socket(`ws://127.0.0.1:${port}`, { handshakeTimeout: 5000, maxPayload: 1024 * 1024 });
  let timer = null;
  const finish = (event) => {
    if (over) return;
    over = true;
    clearTimeout(timer);
    pending = [];
    socket.close();
    onEvent(event);
  };
  const fail = (message) => finish({ type: 'error', message });
  const flush = () => {
    if (over || socket.readyState !== WebSocket.OPEN) return;
    for (const pcm of pending) socket.send(pcm);
    pending = [];
    queued = 0;
    if (ended && !sentEnd) { sentEnd = true; socket.send('Done'); }
  };
  socket.on('open', () => {
    if (over) { socket.close(); return; }
    if (sampleRate !== 16000) { fail('X-ASR requires 16000 Hz mono audio.'); return; }
    flush();
  });
  socket.on('message', (bytes) => {
    if (over) return;
    let result;
    try { result = JSON.parse(String(bytes)); } catch { fail('The recognition engine returned an invalid result.'); return; }
    if (typeof result?.text !== 'string') { fail('The recognition engine returned no text.'); return; }
    const text = result.text.replace(/(?<=[\p{Script=Han}，。！？、])\s+(?=[\p{Script=Han}])/gu, '').trim();
    if (result.is_eof === true) {
      const language = languageOf(text);
      finish({ type: 'done', text, ...(language ? { language } : {}) });
    } else if (text !== previous) {
      previous = text;
      onEvent({ type: 'partial', text });
    }
  });
  socket.on('error', (error) => fail(String(error.message).slice(0, 300)));
  socket.on('close', () => { if (!over) fail('The recognition engine closed the stream before it finished.'); });
  return {
    write(pcm) {
      if (over || ended) return;
      if (pcm.length % 2 !== 0) { fail('The recognition audio is not 16-bit PCM.'); return; }
      // Bound a stalled socket to 30 seconds of float audio; a slow engine must not grow the main process forever.
      if (queued + socket.bufferedAmount + pcm.length * 2 > 16000 * 4 * 30) { fail('The recognition engine is not keeping up with the audio.'); return; }
      const floats = Buffer.allocUnsafe(pcm.length * 2);
      for (let i = 0; i < pcm.length / 2; i++) floats.writeFloatLE(pcm.readInt16LE(i * 2) / 32768, i * 4);
      pending.push(floats);
      queued += floats.length;
      flush();
    },
    end() {
      if (over || ended) return;
      ended = true;
      timer = setTimeout(() => fail('The recognition engine did not finish in time.'), 15000);
      flush();
    },
    abort() { over = true; clearTimeout(timer); pending = []; socket.terminate(); },
  };
}

/** The language SenseVoice says it heard (`<|ja|>`), as the app codes it; null where it says none of its five. */
function saidLanguage(tag) {
  const code = /^<\|(zh|en|ja|ko|yue)\|>$/.exec(String(tag ?? ''))?.[1];
  return code ?? null;
}

/**
 * One stretch read whole by the offline server, as `readWhole` reads one by audio.cpp's: its sample rate and length,
 * then the samples as floats, in pieces; one JSON answer; `Done`. A socket a stretch.
 */
function readOffline({ port, sampleRate, pcm, timeoutMs = 30_000 }, Socket = WebSocket) {
  let socket = null;
  let settled = false;
  const done = new Promise((resolve) => {
    const settle = (answer) => { if (settled) return; settled = true; clearTimeout(timer); try { socket.close(); } catch { /* gone already */ } resolve(answer); };
    const timer = setTimeout(() => { try { socket.terminate(); } catch { /* gone already */ } settle({ ok: false, message: 'The engine did not answer in time.' }); }, timeoutMs);
    socket = new Socket(`ws://127.0.0.1:${port}`, { handshakeTimeout: 5000, maxPayload: 4 * 1024 * 1024 });
    socket.on('open', () => {
      const samples = Math.floor(pcm.length / 2);
      const body = Buffer.allocUnsafe(8 + samples * 4);
      body.writeInt32LE(sampleRate, 0);
      body.writeInt32LE(samples * 4, 4);
      for (let i = 0; i < samples; i++) body.writeFloatLE(pcm.readInt16LE(i * 2) / 32768, 8 + i * 4);
      for (let at = 0; at < body.length; at += 10240) socket.send(body.subarray(at, at + 10240));
    });
    socket.on('message', (bytes) => {
      let result;
      try { result = JSON.parse(String(bytes)); } catch { settle({ ok: false, message: 'The recognition engine returned an invalid result.' }); return; }
      if (typeof result?.text !== 'string') { settle({ ok: false, message: 'The recognition engine returned no text.' }); return; }
      try { socket.send('Done'); } catch { /* it has the answer */ }
      const language = saidLanguage(result.lang);
      settle({ ok: true, text: result.text.trim(), ...(language ? { language } : {}) });
    });
    socket.on('error', (error) => settle({ ok: false, message: String(error.message).slice(0, 300) }));
    socket.on('close', () => settle({ ok: false, message: 'The recognition engine closed the stretch before it answered.' }));
  });
  return { done, abort: () => { settled = true; try { socket?.terminate(); } catch { /* gone already */ } } };
}

/** How much new sound a reading on the way waits for: each costs the processor, which a game beside it wants. */
const SENSE_NEW_SECONDS = 1.5;

/** A completed WebSocket handshake means the model has loaded and the server can accept audio. */
function ready(port) {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, { handshakeTimeout: 1000 });
    socket.once('open', () => { socket.close(); resolve({ status: 200 }); });
    socket.once('error', () => resolve(null));
  });
}

function createSherpaEngine(deps) {
  const window = (target, onEvent) => openWindow({ ...target, read: readOffline, newSeconds: SENSE_NEW_SECONDS }, onEvent);
  return createNativeEngine({ catalog: { engine: ENGINE, models: MODELS }, runtime: RUNTIME, get: ready, live: openSherpa, window, ...deps });
}

module.exports = { createSherpaEngine, openSherpa, readOffline, saidLanguage, languageOf, MODEL_ID, SENSE_ID, MODELS, ENGINE, RUNTIME };
