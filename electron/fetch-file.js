/**
 * Fork: one file from several addresses of it, to a `.part` on disk — what the native engines' runtimes and models
 * and the app's own update are fetched with.
 *
 * For a large file the addresses are first tried against each other, and the quickest goes first (`quickestFirst`).
 * Then they are asked in turn, and round again: one that brought something is asked for the rest, one that
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

/** A file with this much of it still to come is worth finding the quickest address for; less has arrived before that is known. */
const TRIAL_WORTH = 16 * 1024 * 1024;
/** Each address is asked for this much of the file, and timed. */
const TRIAL_BYTES = 1024 * 1024;
/** The trial is over after this long, whoever has answered; and this long after the first address has brought its share. */
const TRIAL_MS = 6_000;
const TRIAL_REST_MS = 2_000;

/**
 * The addresses of a file, the quickest first: all are asked at once for the same stretch of it, and ordered by how
 * much of it each brought in the time. What they bring is thrown away — it is a megabyte.
 *
 * The order the addresses come in is a guess (`inMainlandChina`: by the clock). A guess sent a person in mainland
 * China who had a proxy on to the relays, which were slow that day, past a GitHub their proxy reached well; and a
 * relay that crawls still brings something, so it was never left (2026-10-13). Which address is quick is found out
 * by asking; the guess only orders those that are as quick as each other, and those that did not answer.
 */
async function quickestFirst({ sources, from = 0, bytes, fetch: doFetch, signal, trialBytes = TRIAL_BYTES, trialMs = TRIAL_MS, restMs = TRIAL_REST_MS, log = () => {} }) {
  const all = new AbortController();
  const give = () => all.abort();
  signal?.addEventListener('abort', give, { once: true });
  const began = Date.now();
  let over = setTimeout(give, trialMs);
  let someoneDone = false;
  const end = Math.min(bytes, from + trialBytes) - 1;
  // (An answer whose body does not end with its request is not waited on past the time either.)
  const stopped = new Promise((_, reject) => all.signal.addEventListener('abort', () => reject(new Error('The trial is over.')), { once: true }));
  stopped.catch(() => {});
  const rates = await Promise.all(sources.map(async (source) => {
    let got = 0;
    try {
      const response = await doFetch(source, { signal: all.signal, redirect: 'follow', headers: { Range: `bytes=${from}-${end}` } });
      const page = /^text\/html/i.test(response.headers?.get?.('content-type') ?? '');
      if ((response.status !== 200 && response.status !== 206) || page || !response.body) {
        Promise.resolve(response.body?.cancel()).catch(() => {});
        return 0;
      }
      const reader = response.body.getReader();
      try {
        while (got <= end - from) {
          const { done, value } = await Promise.race([reader.read(), stopped]);
          if (done) break;
          got += value.byteLength;
        }
      } finally {
        Promise.resolve(reader.cancel()).catch(() => {});
      }
      // The others are not waited on for long once one has shown what a quick address is like.
      if (!someoneDone) { someoneDone = true; clearTimeout(over); over = setTimeout(give, restMs); }
    } catch {
      // Stopped when the time was up: what it brought until then is what it is judged by.
    }
    return got / Math.max(1, Date.now() - began);
  }));
  clearTimeout(over);
  signal?.removeEventListener('abort', give);
  all.abort();
  log(`quickest first: ${sources.map((source, index) => `${hostOf(source)} ${Math.round(rates[index])} KB/s`).join(' · ')}`);
  // (A sort that keeps the order of equals: the guess stands among them.)
  return sources.map((source, index) => ({ source, rate: rates[index] })).sort((a, b) => b.rate - a.rate).map((entry) => entry.source);
}

/**
 * The file, whole in `part`: resolves when it is `bytes` long there, going on from what `part` already holds.
 * Rejects with what stopped it (`signal` aborted: the fetch's own abort error), or with who was asked and what each
 * said. `onReceived(count)` follows the part's length; `onTurn()` is called when an address is left for another.
 */
async function pullWhole({ sources: given, part, bytes, fetch: doFetch, signal, files = fs, answerWithinMs = ANSWER_WITHIN_MS, onReceived = () => {}, onTurn = () => {}, log = () => {}, name = part, trial = quickestFirst, trialWorth = TRIAL_WORTH }) {
  const sizeOf = (file) => { try { return files.statSync(file).size; } catch { return 0; } };
  let received = sizeOf(part);
  // A part larger than the whole is no part of it.
  if (received > bytes) { files.rmSync(part, { force: true }); received = 0; }
  onReceived(received);
  // A large file is begun at whichever address is the quickest just now, not at the one guessed to be.
  const sources = trial && given.length > 1 && bytes - received >= trialWorth ? await trial({ sources: given, from: received, bytes, fetch: doFetch, signal, log }) : given;
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

module.exports = { pullWhole, quickestFirst, relaysOf, hfMirrorOf, hostOf, inMainlandChina, ANSWER_WITHIN_MS, GITHUB_RELAYS, TRIAL_WORTH };
