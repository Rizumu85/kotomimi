// Fork: X-ASR's streaming CPU recognizer, in the official sherpa-onnx process.
const WebSocket = require('ws');
const { createNativeEngine, AUDIO_RUNTIME } = require('./native-engine');

const MODEL_ID = 'x-asr-zh-en';
const REVISION = '689ff18c584d29910da37b6fe904db0c1489c9d1';
// 480 ms / one inference thread leaves more CPU for the game than 160 ms or extra threads.
const FILES = [
  ['encoder-480ms.onnx', 592968361, '0c3454033d249081df124ddcd7adaf3deca07d0b999b26f2ee5d2475d37abc74'],
  ['decoder-480ms.onnx', 11309084, '3658368d274a5d5fd39a7ac20c46bed0ad9cfea1f0feddef30d5d89797c1f499'],
  ['joiner-480ms.onnx', 10260467, '03781c98165a2385024c9cecdd2b6b13310d81db23a62c7da420782c2915cf81'],
  ['tokens.txt', 58806, 'b818a60878b9aae978cbb8ad594acbd403d76d1af2e31ef4197c84e2dbdba27c'],
].map(([file, bytes, sha256]) => ({ file, bytes, sha256, url: `https://huggingface.co/GilgameshWind/X-ASR-zh-en/resolve/${REVISION}/deployment/models/chunk-480ms-model/${file}` }));
const MODELS = {
  [MODEL_ID]: { file: FILES[0].file, files: FILES, bytes: FILES.reduce((sum, part) => sum + part.bytes, 0), languages: ['zh', 'en'], mode: 'streaming' },
};
const build = (name, bytes, sha256, exe) => ({
  url: `https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.1/${name}.tar.bz2`,
  bytes, sha256, archive: 'engine.tar.bz2', exe: `${name}/bin/${exe}`, backend: 'cpu',
});
const ENGINE = { version: '2.0.1', builds: {
  'win32-x64': build('sherpa-onnx-v2.0.1-win-x64-shared-MD-MinSizeRel-no-tts', 18047922, '5520c214fae80ae40d37b3581bd67446d7c8ae8e3f25a6db916be1fc2860946a', 'sherpa-onnx-online-websocket-server.exe'),
  'darwin-arm64': build('sherpa-onnx-v2.0.1-osx-arm64-shared-no-tts', 18663994, '4fcc6c77c8d8d2e2f04cfdc17c6fd224c01469b78529370eb9d8e0e5ec97ac79', 'sherpa-onnx-online-websocket-server'),
} };

const RUNTIME = {
  launch({ port, build }) {
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

/** A completed WebSocket handshake means the model has loaded and the server can accept audio. */
function ready(port) {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, { handshakeTimeout: 1000 });
    socket.once('open', () => { socket.close(); resolve({ status: 200 }); });
    socket.once('error', () => resolve(null));
  });
}

function createSherpaEngine(deps) {
  return createNativeEngine({ catalog: { engine: ENGINE, models: MODELS }, runtime: RUNTIME, get: ready, live: openSherpa, ...deps });
}

module.exports = { createSherpaEngine, openSherpa, languageOf, MODEL_ID, MODELS, ENGINE, RUNTIME };
