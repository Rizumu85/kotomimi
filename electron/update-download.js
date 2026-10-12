/**
 * Fork: the installer of an update, fetched whole and checked before it is run.
 *
 * It is a GitHub release file, some 190 MB, and GitHub's downloads crawl or do not answer from mainland China (an exit
 * in Beijing, 2026-10-12: about 30 KB/s when it came at all) — so an update never arrived there. It is asked for as
 * the engines' runtimes are (electron/fetch-file.js): of public relays of GitHub as well, first on a mainland China
 * time zone and last elsewhere, going on by itself where a download breaks off.
 *
 * A relay is a stranger, and this file is run. So what arrives is kept only if it is the length and has the SHA-512
 * the release's own `latest.yml` gives for it — which the updater reads from GitHub itself, never through a relay.
 * A release that gives neither is fetched from GitHub alone, as before.
 */
const crypto = require('crypto');
const fs = require('fs');
const { pullWhole, relaysOf, inMainlandChina } = require('./fetch-file');

/** The file's SHA-512 as `latest.yml` writes one: in base64. */
const sha512Of = (file) => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha512');
  fs.createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('base64')));
});

/** Whether a release says enough about its installer for a stranger to be asked for it. */
const checkable = ({ sha512, size }) => typeof sha512 === 'string' && sha512.length > 0 && Number.isInteger(size) && size > 0;

/**
 * The installer at `url`, at `dest`: resolves once it is there, whole and checked. `onProgress(received, total)`
 * follows it. What a stopped download left beside `dest` is gone on from, and checked all the same.
 */
async function downloadInstaller({ url, sha512, size, dest, fetch: doFetch, mirrorFirst = inMainlandChina, onProgress = () => {}, signal, files = fs, hash = sha512Of, answerWithinMs, log = () => {} }) {
  if (!checkable({ sha512, size })) throw new Error('The release does not say what its installer should be.');
  const part = `${dest}.part`;
  const relays = relaysOf(url);
  await pullWhole({
    sources: mirrorFirst() ? [...relays, url] : [url, ...relays],
    part,
    bytes: size,
    fetch: doFetch,
    signal,
    files,
    ...(answerWithinMs ? { answerWithinMs } : {}),
    name: 'the update',
    onReceived: (received) => onProgress(received, size),
    log,
  });
  if ((await hash(part)) !== sha512) {
    files.rmSync(part, { force: true });
    throw new Error('The downloaded update is not the one the release describes, and was discarded.');
  }
  files.rmSync(dest, { force: true });
  files.renameSync(part, dest);
}

module.exports = { downloadInstaller, checkable, sha512Of };
