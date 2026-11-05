// Fork: a recognition engine that runs on another device.
//
// A phone lent to this computer (android/) runs the same engine this computer downloads (native-engine.js), and
// answers the same request: one stretch of sound, read whole. So a voice is written while it is heard the same way
// as here — the stretch so far read again and again as it grows (`openWindow`) — with the readings asked of the
// phone's address instead of the loopback. How often it is read follows how long a reading takes, as it does here:
// a slow phone is read less often, and what the user sees is that phone's own pace, not a pace this side chose.
//
// Nothing is started or stopped from here: the phone's owner lends it and takes it back. This holds the recognitions
// open on such an engine, each under an id, for the page (`src/lib/native/remoteEngine.ts`).
//
// No Electron import, and the reading is handed in, so its tests need neither.
const { openWindow, readWhole, unspaced, echoOf, hintChecked, CONTEXT_LEAD, languageCode, languageName, languageLocale, MODELS } = require('./native-engine');

/** A reading over the network is given longer than one on this computer: the phone may be the slower of the two. */
const READ_TIMEOUT_MS = 60_000;
/** How long a live stretch waits for the device to take it, and, once it is over, for the device's last words. */
const LIVE_OPEN_MS = 8_000;
const LIVE_LAST_WORDS_MS = 60_000;
/** Recognitions open at once, over all devices: a page that opens more has lost count of them. */
const MOST_STREAMS = 16;

/**
 * Where an engine on another device is asked, from the address the user gave (`http://192.168.1.23:8792/v1`): null
 * for anything that is not a plain http address. (https is not offered: a phone on the local network has no
 * certificate to show.)
 */
function targetOf(base) {
  let url;
  try { url = new URL(String(base).trim()); } catch { return null; }
  if (url.protocol !== 'http:' || !url.hostname || url.username || url.password) return null;
  const port = url.port ? Number(url.port) : 80;
  return { host: url.hostname, port, pathname: `${url.pathname.replace(/\/+$/, '')}/audio/transcriptions` };
}

/**
 * How a model is told the language. The phone's models are this app's own, under the same names; one this computer
 * does not know is told the code as it is.
 */
function saidFor(model, language) {
  const how = MODELS[model]?.languageAs;
  if (!language) return undefined;
  if (how === 'locale') return languageLocale(language);
  if (how === 'code' || !MODELS[model]) return languageCode(language);
  return languageName(language);
}

/**
 * A stretch heard while it is spoken by a device that hears that way (the iPad app's own recognition,
 * `ios/KotomimiNode/Door/Lending.swift`, `live`): one WebSocket to `/v1/audio/stream`, the sound sent as it comes, and
 * what is heard written back as it is, as this computer's Mac hears with its own (`apple-speech.js`). `also` and
 * `prefer`: the speech may be in either of two languages. `emit` takes what the window's would (`delta`, `partial`,
 * then `done` or `error`).
 */
function liveStretch({ target, language, also, prefer, sampleRate }, emit, { Socket = defaultSocket() } = {}) {
  let socket = null;
  let open = false;
  let ended = false;
  let over = false;
  const waiting = [];
  let timer = null;
  const finish = (event) => {
    if (over) return;
    over = true;
    clearTimeout(timer);
    try { socket?.close(); } catch { /* gone already */ }
    emit(event);
  };
  const wait = (ms, why) => { clearTimeout(timer); timer = setTimeout(() => finish({ type: 'error', message: why }), ms); };
  const send = (data) => { try { socket.send(data); } catch { /* the close says why */ } };
  const close = () => { send(JSON.stringify({ type: 'end' })); wait(LIVE_LAST_WORDS_MS, 'The device did not finish the stretch in time.'); };
  try {
    socket = new Socket(`ws://${target.host}:${target.port}${target.pathname.replace(/\/audio\/transcriptions$/, '/audio/stream')}`, {
      headers: target.key ? { Authorization: `Bearer ${target.key}` } : {},
    });
  } catch (error) {
    queueMicrotask(() => finish({ type: 'error', message: `The device could not be reached: ${error.message}` }));
    return { write() {}, end() {}, abort() { over = true; } };
  }
  socket.binaryType = 'nodebuffer';
  wait(LIVE_OPEN_MS, 'The device did not take the stretch in time.');
  socket.on('open', () => {
    send(JSON.stringify({ type: 'open', language, ...(also ? { also } : {}), ...(also && prefer ? { prefer } : {}), sampleRate }));
  });
  socket.on('message', (data, binary) => {
    if (binary || over) return;
    let event;
    try { event = JSON.parse(String(data)); } catch { return; }
    if (event?.type === 'ready') {
      open = true;
      clearTimeout(timer);
      for (const pcm of waiting.splice(0)) send(pcm);
      if (ended) close();
    } else if (event?.type === 'partial' && typeof event.text === 'string') emit({ type: 'partial', text: event.text });
    else if (event?.type === 'delta' && typeof event.text === 'string' && event.text) emit({ type: 'delta', text: event.text });
    else if (event?.type === 'final') finish({ type: 'done', text: typeof event.text === 'string' ? event.text : '', ...(typeof event.language === 'string' && event.language ? { language: event.language } : {}) });
    else if (event?.type === 'error') finish({ type: 'error', message: String(event.message ?? 'The device reported an error.').slice(0, 300) });
  });
  socket.on('unexpected-response', (_request, response) => finish({ type: 'error', message: `The device answered HTTP ${response.statusCode}.` }));
  socket.on('error', (error) => finish({ type: 'error', message: error.message }));
  socket.on('close', () => finish({ type: 'error', message: 'The device closed the stretch before it finished.' }));
  return {
    write(pcm) {
      if (over || ended) return;
      if (open) send(pcm); else waiting.push(pcm);
    },
    end() {
      if (over || ended) return;
      ended = true;
      if (open) close();
    },
    abort() {
      over = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* gone already */ }
    },
  };
}

/** `ws`'s client, which takes headers (the device's key): loaded when first asked for. */
function defaultSocket() {
  return require('ws');
}

function createRemoteEngine({ onStream = () => {}, window = openWindow, read = readWhole, note = () => {}, live = liveStretch } = {}) {
  const streams = new Map();
  let nextStream = 1;

  /**
   * A live recognition on the engine at `base`: its id, or null where the address is not one, or too many are open.
   * `streamed`: the device hears while it is spoken (its list says `streams`), and is sent the sound as it comes,
   * not read again and again as the stretch grows; `also` and `prefer` as for this computer's Mac.
   */
  function openStream({ base, model, language, sampleRate, key, hints = [], streamed = false, also, prefer } = {}) {
    const found = targetOf(base);
    // The phone's access key, where its owner set one: every reading carries it (`src/lib/lan/phoneKeys.ts`).
    const target = found && typeof key === 'string' && /^[\x21-\x7e]{1,128}$/.test(key) ? { ...found, key } : found;
    if (!target || typeof model !== 'string' || !model || streams.size >= MOST_STREAMS) return null;
    const id = nextStream++;
    const rate = Number.isInteger(sampleRate) && sampleRate >= 8000 && sampleRate <= 48000 ? sampleRate : 16000;
    if (streamed === true) {
      const code = (value) => (typeof value === 'string' && /^[a-z]{2,3}([-_][A-Za-z0-9]{2,8})?$/i.test(value) ? value.split(/[-_]/)[0].toLowerCase() : undefined);
      const stream = live({ target, language: code(language) ?? '', also: code(also), prefer: code(prefer), sampleRate: rate }, (event) => {
        if (event.type !== 'delta' && event.type !== 'partial') streams.delete(id);
        onStream({ id, ...event });
      });
      streams.set(id, stream);
      return id;
    }
    // The words of the user's dictionary, for a model that takes them (Qwen3-ASR), as this computer's own engine is
    // told them (`openStream` in native-engine.js) — with the same checks on what it writes back: the list said back
    // for want of a voice is dropped, and a reading of nothing but the words is read again without them. Without
    // them a name heard on a device came out another way at each reading (the user, 2026-11-05).
    const words = Array.isArray(hints) ? hints.filter((hint) => typeof hint === 'string' && hint.trim()).slice(0, 100) : [];
    const context = MODELS[model]?.takesContext && words.length > 0 ? `${CONTEXT_LEAD}${words.join('、')}` : undefined;
    const echo = context ? echoOf(words) : null;
    // The phone takes a model's spaces out itself; taken out here as well, the text is the same whoever sent it.
    const spaced = MODELS[model]?.unspaced ? unspaced : null;
    const tidy = echo && spaced ? (text) => echo(spaced(text)) : echo ?? spaced;
    const reading = (asked) => read({ ...asked, ...target });
    const stream = window({
      model,
      sampleRate: rate,
      language: saidFor(model, typeof language === 'string' ? language : ''),
      ...(context ? { context } : {}),
      timeoutMs: READ_TIMEOUT_MS,
      read: context ? hintChecked(reading, words) : reading,
      ...(tidy ? { tidy } : {}),
      note,
    }, (event) => {
      if (event.type !== 'delta' && event.type !== 'partial') streams.delete(id);
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
  /** Every recognition dropped: the page that held them is gone. */
  function stop() {
    for (const stream of streams.values()) stream.abort();
    streams.clear();
  }

  return { openStream, writeStream, endStream, abortStream, stop };
}

module.exports = { createRemoteEngine, liveStretch, targetOf, saidFor };
