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
const { openWindow, readWhole, languageCode, languageName, languageLocale, MODELS } = require('./native-engine');

/** A reading over the network is given longer than one on this computer: the phone may be the slower of the two. */
const READ_TIMEOUT_MS = 60_000;
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

function createRemoteEngine({ onStream = () => {}, window = openWindow, read = readWhole, note = () => {} } = {}) {
  const streams = new Map();
  let nextStream = 1;

  /** A live recognition on the engine at `base`: its id, or null where the address is not one, or too many are open. */
  function openStream({ base, model, language, sampleRate } = {}) {
    const target = targetOf(base);
    if (!target || typeof model !== 'string' || !model || streams.size >= MOST_STREAMS) return null;
    const id = nextStream++;
    const rate = Number.isInteger(sampleRate) && sampleRate >= 8000 && sampleRate <= 48000 ? sampleRate : 16000;
    const stream = window({
      model,
      sampleRate: rate,
      language: saidFor(model, typeof language === 'string' ? language : ''),
      timeoutMs: READ_TIMEOUT_MS,
      read: (asked) => read({ ...asked, ...target }),
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

module.exports = { createRemoteEngine, targetOf, saidFor };
