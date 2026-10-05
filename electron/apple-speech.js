// Fork: the Mac's own speech recognition, as one more native recognizer.
//
// macOS 26 and later carry a recognizer that runs on the device and hears
// Japanese conversation better than any model the app can download
// (measured: about 14 % of the characters wrong, where the best downloaded
// model is at 18 %). The app reaches it through a small helper it ships
// (`native/apple-speech/SpeechHelper.swift`): one helper process for each
// stretch of speech, the sound in on its standard input, the text out on its
// standard output.
//
// To the rest of the app this is the same thing as the native recognition
// engine of the other systems (`native-engine.js`), and it answers the same
// questions in the same shape — so the page's recognizer, its settings and
// its readiness check need not know which one they talk to. What differs:
// there is no runtime to fetch and no server to start, so it is "ready" as
// soon as it is asked for; its models are the system's languages, one each,
// fetched by the system itself when the helper asks; and a recognition also
// says what it has heard so far before that text is settled (`partial`).
//
// No Electron import, and everything it touches is handed in, so its tests
// run with no helper and no process.
const { spawn: nodeSpawn } = require('child_process');
const fs = require('fs');
const os = require('os');

/** A model's id: this, and the language it hears. */
const PREFIX = 'apple-speech:';

/** The languages offered, by the app's base code, and the system's name for each. */
const LOCALES = {
  ja: 'ja_JP', en: 'en_US', ko: 'ko_KR', zh: 'zh_CN', es: 'es_ES', fr: 'fr_FR', de: 'de_DE', it: 'it_IT', pt: 'pt_BR', hi: 'hi_IN', yue: 'yue_CN',
};

/** Shown as a download's size: the system does not say how large a language's assets are. */
const PROGRESS_SCALE = 1000;

const baseOf = (code) => String(code ?? '').trim().toLowerCase().split(/[-_]/)[0];
/** The system's locale for a language as the app names it; null for one it is not offered in. */
const localeFor = (code) => LOCALES[baseOf(code)] ?? null;
const idOf = (language) => `${PREFIX}${language}`;
const languageOf = (id) => (typeof id === 'string' && id.startsWith(PREFIX) ? id.slice(PREFIX.length) : null);

/** macOS 26 is Darwin 25. */
const systemHasIt = (platform, release) => platform === 'darwin' && Number(String(release).split('.')[0]) >= 25;

/** A process's standard output, a JSON object to a line: `onEvent` for each. */
function readLines(stream, onEvent) {
  let pending = '';
  stream.setEncoding?.('utf8');
  stream.on('data', (chunk) => {
    pending += chunk;
    let at;
    while ((at = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, at).trim();
      pending = pending.slice(at + 1);
      if (!line) continue;
      try { onEvent(JSON.parse(line)); } catch { /* not a line of ours */ }
    }
  });
  stream.on('error', () => {});
}

function createAppleSpeech(deps = {}) {
  const {
    /** The helper's executable, inside its bundle; null where the app was built without it. */
    helper = null,
    platform = process.platform,
    release = os.release(),
    spawn = nodeSpawn,
    exists = (file) => { try { return fs.statSync(file).isFile(); } catch { return false; } },
    log = null,
    onChange = () => {},
    onStream = () => {},
  } = deps;

  const supported = Boolean(helper) && systemHasIt(platform, release) && exists(helper);
  /** What the system offers and has installed, by locale; null until asked. */
  let installed = null;
  let offered = new Set();
  /** Languages being fetched: language → `{ fraction, child }`. */
  const fetching = new Map();
  const failed = new Map();
  let run = { state: 'stopped', model: null, port: 0, tail: '' };

  const modelState = (language) => {
    const busy = fetching.get(language);
    if (busy) return { state: 'downloading', received: Math.round(busy.fraction * PROGRESS_SCALE), total: PROGRESS_SCALE };
    if (installed?.has(LOCALES[language])) return { state: 'downloaded', received: 0, total: 0 };
    const error = failed.get(language);
    return { state: error ? 'failed' : 'absent', received: 0, total: 0, ...(error ? { error } : {}) };
  };
  const snapshot = () => ({
    supported,
    engine: supported ? 'ready' : 'unsupported',
    engineBytes: 0,
    // Only the languages the system itself offers: before it has been asked, none.
    models: supported ? Object.fromEntries(Object.keys(LOCALES).filter((language) => offered.has(LOCALES[language])).map((language) => [idOf(language), modelState(language)])) : {},
    run: { ...run },
    // Once asked for, the system's recognition hears every language it has installed.
    up: supported && run.state === 'ready' ? Object.keys(LOCALES).filter((language) => installed?.has(LOCALES[language])).map(idOf) : [],
  });
  const tell = () => onChange(snapshot());

  /** Runs the helper to its end: its events, and how it exited. */
  function runHelper(args, onEvent = () => {}) {
    let child;
    const done = new Promise((resolve) => {
      try {
        child = spawn(helper, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        resolve({ ok: false, message: String(error?.message ?? error) });
        return;
      }
      let message = '';
      readLines(child.stdout, (event) => {
        if (event?.type === 'error' && typeof event.message === 'string') message = event.message;
        onEvent(event);
      });
      child.stderr?.on('data', (chunk) => log?.(String(chunk)));
      child.stderr?.on('error', () => {});
      child.on('error', (error) => resolve({ ok: false, message: error.message }));
      child.on('exit', (code) => resolve({ ok: code === 0, message }));
    });
    return { done, kill: () => { try { child?.kill(); } catch { /* gone already */ } } };
  }

  /** Asks the system what it offers and has: once, and again after anything that changes it. */
  let asking = null;
  function inventory() {
    if (!supported) return Promise.resolve();
    asking ??= runHelper(['inventory'], (event) => {
      if (event?.type !== 'inventory' || !Array.isArray(event.locales)) return;
      offered = new Set(event.locales.filter((l) => typeof l?.locale === 'string').map((l) => l.locale));
      installed = new Set(event.locales.filter((l) => l?.installed === true && typeof l.locale === 'string').map((l) => l.locale));
    }).done.finally(() => { asking = null; });
    return asking;
  }

  async function status() {
    if (supported && installed === null) await inventory();
    return snapshot();
  }

  /** A language's assets, fetched by the system: resolves with the state of things, which says what failed. */
  async function download(id) {
    const language = languageOf(id);
    if (!supported || !language || !LOCALES[language] || fetching.has(language)) return status();
    failed.delete(language);
    const state = { fraction: 0, kill: () => {}, cancelled: false };
    fetching.set(language, state);
    tell();
    const job = runHelper(['install', LOCALES[language]], (event) => {
      if (event?.type === 'progress' && Number.isFinite(event.fraction)) { state.fraction = Math.max(0, Math.min(1, event.fraction)); tell(); }
    });
    state.kill = job.kill;
    const result = await job.done;
    fetching.delete(language);
    if (!result.ok && !state.cancelled) failed.set(language, (result.message || 'The system could not fetch this language.').slice(0, 300));
    await inventory();
    tell();
    return snapshot();
  }

  function cancel(id) {
    const state = fetching.get(languageOf(id));
    if (state) { state.cancelled = true; state.kill(); }
    return snapshot();
  }

  /** Lets a language's assets go. The system keeps them until it wants the room: it may still say "installed". */
  async function remove(id) {
    const language = languageOf(id);
    if (!supported || !language || !LOCALES[language] || fetching.has(language)) return status();
    await runHelper(['release', LOCALES[language]]).done;
    failed.delete(language);
    await inventory();
    tell();
    return snapshot();
  }

  /** Nothing to start: the system's recognizer is there. "Ready" with the model asked for, when its language is installed. */
  async function start(id) {
    const language = languageOf(id);
    if (!supported || !language || !LOCALES[language]) return status();
    if (installed === null) await inventory();
    run = installed?.has(LOCALES[language])
      ? { state: 'ready', model: id, port: 0, tail: '' }
      : { state: 'failed', model: id, port: 0, tail: 'The language is not installed.' };
    tell();
    return snapshot();
  }

  const streams = new Map();
  let nextStream = 1;

  async function stop() {
    for (const stream of streams.values()) stream.kill();
    streams.clear();
    if (run.state !== 'stopped') { run = { state: 'stopped', model: null, port: 0, tail: '' }; tell(); }
    return snapshot();
  }

  /** A live recognition opened for the page: its id, or null where it cannot be — no such language, or sound at another rate than the recognizer's. */
  function openStream({ language, sampleRate } = {}) {
    const locale = localeFor(language);
    if (!supported || run.state !== 'ready' || !locale || sampleRate !== 16000) return null;
    const id = nextStream++;
    let child;
    try {
      child = spawn(helper, ['stream', locale], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      return null;
    }
    let over = false;
    const finish = (event) => {
      if (over) return;
      over = true;
      streams.delete(id);
      onStream({ id, ...event });
    };
    readLines(child.stdout, (event) => {
      if (over) return;
      if (event?.type === 'partial' && typeof event.text === 'string') onStream({ id, type: 'partial', text: event.text });
      else if (event?.type === 'delta' && typeof event.text === 'string' && event.text) onStream({ id, type: 'delta', text: event.text });
      else if (event?.type === 'final') finish({ type: 'done', text: typeof event.text === 'string' ? event.text : '' });
      else if (event?.type === 'error') finish({ type: 'error', message: String(event.message ?? 'The speech recognizer reported an error.').slice(0, 300) });
    });
    child.stderr?.on('data', (chunk) => log?.(String(chunk)));
    child.stderr?.on('error', () => {});
    child.stdin?.on('error', () => {});
    child.on('error', (error) => finish({ type: 'error', message: error.message }));
    child.on('exit', () => finish({ type: 'error', message: 'The speech recognizer closed before it finished.' }));
    streams.set(id, {
      write: (line) => { if (!over && child.stdin?.writable) child.stdin.write(line); },
      kill: () => { over = true; try { child.kill(); } catch { /* gone already */ } },
    });
    return id;
  }
  function writeStream(id, pcm) {
    const stream = streams.get(id);
    if (!stream || !pcm) return false;
    const bytes = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm.buffer ?? pcm, pcm.byteOffset ?? 0, pcm.byteLength);
    stream.write(`${JSON.stringify({ type: 'audio', pcm: bytes.toString('base64') })}\n`);
    return true;
  }
  function endStream(id) { streams.get(id)?.write(`${JSON.stringify({ type: 'end' })}\n`); return true; }
  function abortStream(id) { streams.get(id)?.kill(); streams.delete(id); return true; }

  return { status, download, cancel, remove, start, stop, openStream, writeStream, endStream, abortStream };
}

module.exports = { createAppleSpeech, localeFor, systemHasIt, LOCALES, PREFIX };
