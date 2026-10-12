/**
 * Fork: one file from several addresses of it, to a `.part` on disk — what the native engines' runtimes and models
 * and the app's own update are fetched with.
 *
 * The addresses are asked in turn, and round again: one that brought something is asked for the rest, one that
 * brought nothing is left for the next. A download that breaks off — as a long one does, on a poor line — goes on by
 * itself, and fails only when every address has been asked in vain, patiently the second time. Nothing here decides
 * that the file is the right one: whoever asks checks its hash, wherever it came from.
 */
const fs = require('fs');

/** An address that has not begun to answer in this long is left for the next. */
const ANSWER_WITHIN_MS = 15_000;
/** Asked again after every address has failed once, each is waited on this many times longer: a slow proxy is not a dead one. */
const SECOND_PATIENCE = 3;
/** Every address is asked this many times in a row with nothing to show for it before the download is called failed. */
const FETCH_PASSES = 2;
/** However the addresses behave, a download asks no more often than this. */
const FETCH_ATTEMPTS_MOST = 500;

const CHINA_ZONES = new Set(['Asia/Shanghai', 'Asia/Chongqing', 'Asia/Harbin', 'Asia/Urumqi', 'PRC']);
/** A guess that only orders the addresses: by the clock the computer keeps. */
function inMainlandChina() {
  try { return CHINA_ZONES.has(Intl.DateTimeFormat().resolvedOptions().timeZone); } catch { return false; }
}

/**
 * GitHub's release downloads are often not reached from mainland China (a user's friend there, 2026-10-11: a
 * translation model stayed at 0 % and failed; from an exit in Beijing the next day, a runtime's download either did
 * not connect in half a minute or came at some 30 KB/s). These are public relays of GitHub downloads, run by
 * volunteers: asked first there, last elsewhere, and trusted with nothing — what they bring is kept only if it hashes
 * as the release file does. Each served both runtimes whole and right on 2026-10-11; from Beijing the first two were
 * quick and the third slow. One that has gone costs a quarter of a minute, not the download.
 */
const GITHUB_RELAYS = ['https://ghfast.top/', 'https://gh-proxy.com/', 'https://ghproxy.net/'];
const relaysOf = (url) => (String(url).startsWith('https://github.com/') ? GITHUB_RELAYS.map((relay) => `${relay}${url}`) : []);

/**
 * Hugging Face is not reached from mainland China at all (the same exit: no connection in half a minute). hf-mirror.com
 * is a public mirror of it, also a volunteer's: the same paths, answered there. Trusted as the relays are: with nothing.
 */
const HF = 'https://huggingface.co/';
const hfMirrorOf = (url) => (String(url).startsWith(HF) ? [`https://hf-mirror.com/${String(url).slice(HF.length)}`] : []);

const hostOf = (address) => { try { return new URL(address).host; } catch { return String(address); } };

/**
 * The file, whole in `part`: resolves when it is `bytes` long there, going on from what `part` already holds.
 * Rejects with what stopped it (`signal` aborted: the fetch's own abort error), or with who was asked and what each
 * said. `onReceived(count)` follows the part's length; `onTurn()` is called when an address is left for another.
 */
async function pullWhole({ sources, part, bytes, fetch: doFetch, signal, files = fs, answerWithinMs = ANSWER_WITHIN_MS, onReceived = () => {}, onTurn = () => {}, log = () => {}, name = part }) {
  const sizeOf = (file) => { try { return files.statSync(file).size; } catch { return 0; } };
  let received = sizeOf(part);
  // A part larger than the whole is no part of it.
  if (received > bytes) { files.rmSync(part, { force: true }); received = 0; }
  onReceived(received);
  const said = new Map();
  let at = 0;
  let barren = 0;
  // The most there has been of it: an address that begins the file again and stops short of this has brought nothing.
  let most = received;
  for (let attempts = 0; received < bytes; attempts += 1) {
    const source = sources[at % sources.length];
    const had = received;
    try {
      await pull(source, barren < sources.length ? answerWithinMs : answerWithinMs * SECOND_PATIENCE);
    } catch (error) {
      // Stopped by whoever asked: that is the answer.
      if (signal?.aborted) throw error;
      received = sizeOf(part);
      // More than the whole file is none of it.
      if (received > bytes) { files.rmSync(part, { force: true }); received = 0; most = 0; }
      onReceived(received);
      const reason = String(error?.message ?? error);
      log(`${hostOf(source)} did not serve ${name} from ${had} (${reason})`);
      said.set(hostOf(source), reason);
      if (received > most) { most = received; barren = 0; }
      else { barren += 1; at += 1; }
      if (barren >= sources.length * FETCH_PASSES || attempts + 1 >= FETCH_ATTEMPTS_MOST) {
        // Who was asked and what each said: what a person can read out when asking for help.
        throw new Error([...said].map(([host, why]) => `${host}: ${why}`).join(' · '));
      }
      onTurn();
    }
  }

  /** What one address brings, appended to the part: waited on for `patience` to begin, and twice that when it falls silent. */
  async function pull(source, patience) {
    // An address that never answers is not waited on for as long as the system would.
    const attempt = new AbortController();
    const give = () => attempt.abort();
    signal?.addEventListener('abort', give, { once: true });
    const waiting = setTimeout(give, patience);
    let response;
    try {
      response = await doFetch(source, { signal: attempt.signal, redirect: 'follow', headers: received > 0 ? { Range: `bytes=${received}-` } : {} });
    } catch (error) {
      signal?.removeEventListener('abort', give);
      throw signal?.aborted || !attempt.signal.aborted ? error : new Error('The download did not answer.');
    } finally {
      clearTimeout(waiting);
    }
    const refuse = (why) => {
      signal?.removeEventListener('abort', give);
      Promise.resolve(response.body?.cancel()).catch(() => {});
      return new Error(why);
    };
    if (response.status !== 200 && response.status !== 206) throw refuse(`The download answered HTTP ${response.status}.`);
    // An answer that says it is something else — a page in place of the file, another file, another place in it — is
    // not written down: the part is what the next address goes on from.
    const header = (key) => response.headers?.get?.(key) ?? '';
    if (/^text\/html/i.test(header('content-type'))) throw refuse('The download answered with a page, not the file.');
    const range = /^bytes (\d+)-\d+\/(\d+|\*)/.exec(header('content-range'));
    if (response.status === 206 && range && (Number(range[1]) !== received || (range[2] !== '*' && Number(range[2]) !== bytes))) throw refuse('The download answered with another file.');
    if (response.status === 200 && !header('content-encoding') && /^\d+$/.test(header('content-length')) && Number(header('content-length')) !== bytes) throw refuse('The download answered with another file.');
    if (!response.body) throw refuse('The download has no body.');
    // The server sent the whole file where a rest was asked for: start over.
    if (response.status === 200 && received > 0) { files.rmSync(part, { force: true }); received = 0; }
    const out = files.createWriteStream(part, { flags: received > 0 ? 'a' : 'w' });
    const failedWrite = new Promise((_, reject) => out.once('error', reject));
    failedWrite.catch(() => {});
    // An answer that begins and then says nothing more would be waited on for ever.
    let silence = null;
    let fallSilent;
    const silent = new Promise((_, reject) => { fallSilent = reject; });
    silent.catch(() => {});
    const listen = () => { clearTimeout(silence); silence = setTimeout(() => { fallSilent(new Error('The download stopped coming.')); attempt.abort(); }, patience * 2); };
    const reader = response.body.getReader();
    let whole = false;
    try {
      for (;;) {
        listen();
        const { done, value } = await Promise.race([reader.read(), failedWrite, silent]);
        if (done) break;
        if (!out.write(Buffer.from(value))) await Promise.race([new Promise((resolve) => out.once('drain', resolve)), failedWrite]);
        received += value.byteLength;
        if (received > bytes) throw new Error('The download is larger than the file expected.');
        onReceived(received);
      }
      whole = true;
    } finally {
      clearTimeout(silence);
      signal?.removeEventListener('abort', give);
      // Whatever stopped it, the rest of the answer is not waited for.
      if (!whole) Promise.resolve(reader.cancel()).catch(() => {});
      await new Promise((resolve) => out.end(resolve));
    }
    // An answer that ended early without saying so: what came is kept, and the next attempt goes on from it.
    if (sizeOf(part) < bytes) throw new Error('The download stopped before the end.');
  }
}

module.exports = { pullWhole, relaysOf, hfMirrorOf, hostOf, inMainlandChina, ANSWER_WITHIN_MS, GITHUB_RELAYS };
