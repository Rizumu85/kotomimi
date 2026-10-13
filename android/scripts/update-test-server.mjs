#!/usr/bin/env node
// Serves a made-up `phone.json` and a package to a phone on USB, to try the app's own update without publishing
// anything. It listens on this computer alone (127.0.0.1); `adb reverse` leads the phone's 127.0.0.1 here, so no
// firewall is asked and nothing on the network can reach it.
//
//   node android/scripts/update-test-server.mjs <the package to offer> [--port 23456] [--code N --version X.Y.Z]
//
// The package's version is read from the `output-metadata.json` Gradle writes beside it, unless given. The phone must
// carry a build with a lower version code, or it is offered nothing. Then (README, "自己的更新"):
//
//   adb reverse tcp:23456 tcp:23456
//   adb shell run-as io.github.rizumu85.kotomimi.node sh -c 'mkdir -p files && echo http://127.0.0.1:23456/good/phone.json > files/update-test'
//
// What is in the address before `/phone.json` picks what the phone is told:
//
//   good     the package as it is
//   slow     the same, at 2 MB a second: time to stop a download and go on with it
//   hash     a checksum that is not the package's: the download is refused when it is whole
//   stale    a version older than any phone has: "nothing new"
//   future   fields no app knows yet: offered all the same
//   sdk      a package for an Android no phone has yet: not offered
//   garbage  not a phone.json at all
//   hang     an answer that never comes
//   (anything else: 404, which the app takes for "nothing is published")
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const option = (name) => { const at = args.indexOf(`--${name}`); return at < 0 ? undefined : args.splice(at, 2)[1]; };
const port = Number(option('port') ?? 23456);
let code = option('code');
let version = option('version');
const apk = args[0] && resolve(args[0]);
if (!apk || !existsSync(apk)) {
  console.error('usage: node update-test-server.mjs <apk> [--port 23456] [--code N --version X.Y.Z]');
  process.exit(2);
}
if (!code || !version) {
  const beside = join(dirname(apk), 'output-metadata.json');
  const said = existsSync(beside) ? JSON.parse(readFileSync(beside, 'utf8')).elements?.[0] : undefined;
  code ??= said?.versionCode;
  version ??= said?.versionName;
}
if (!code || !version) {
  console.error('The package has no output-metadata.json beside it: say --code and --version.');
  process.exit(2);
}

const bytes = statSync(apk).size;
const sha256 = createHash('sha256').update(readFileSync(apk)).digest('hex');
const origin = `http://127.0.0.1:${port}`;
const manifest = (kind) => ({ version: String(version), code: Number(code), apk: `${origin}/${kind}/update.apk`, bytes, sha256, sdk: 28, notes: '试更新用的' });
const MANIFESTS = {
  good: () => manifest('good'),
  slow: () => manifest('slow'),
  hash: () => ({ ...manifest('good'), sha256: '0'.repeat(64) }),
  stale: () => ({ ...manifest('good'), version: '0.0.1', code: 1 }),
  future: () => ({ ...manifest('good'), format: 2, channel: { name: 'stable', since: '2099-01-01' }, mirrors: ['https://example.invalid/'] }),
  sdk: () => ({ ...manifest('good'), sdk: 99 }),
};
const SLOW_BYTES_A_SECOND = 2 * 1024 * 1024;

const server = createServer((request, response) => {
  const [, kind, file] = new URL(request.url, origin).pathname.split('/');
  const range = request.headers.range ?? '';
  const say = (status, note = '') => console.log(`${new Date().toISOString().slice(11, 23)} ${request.method} ${request.url} ${range} -> ${status} ${note}`);

  if (file === 'phone.json') {
    if (kind === 'hang') { say('(never answered)'); return; }
    if (kind === 'garbage') { say(200, 'garbage'); response.writeHead(200, { 'Content-Type': 'text/html' }).end('<html><body>Not what you asked for.</body></html>'); return; }
    if (MANIFESTS[kind]) { say(200); response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(MANIFESTS[kind]())); return; }
  }
  if (file === 'update.apk' && (kind === 'good' || kind === 'slow')) {
    // A part of the file, as the app asks for it: `bytes=from-to`.
    const asked = /^bytes=(\d+)-(\d*)$/.exec(range);
    const from = asked ? Number(asked[1]) : 0;
    const to = asked && asked[2] ? Math.min(Number(asked[2]), bytes - 1) : bytes - 1;
    if (from > to) { say(416); response.writeHead(416, { 'Content-Range': `bytes */${bytes}` }).end(); return; }
    say(asked ? 206 : 200);
    response.writeHead(asked ? 206 : 200, {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Length': to - from + 1,
      'Accept-Ranges': 'bytes',
      ...(asked ? { 'Content-Range': `bytes ${from}-${to}/${bytes}` } : {}),
    });
    const stream = createReadStream(apk, { start: from, end: to, highWaterMark: 64 * 1024 });
    if (kind !== 'slow') { stream.pipe(response); return; }
    // Each connection its share of the speed, a chunk at a time.
    stream.on('data', (chunk) => {
      response.write(chunk);
      stream.pause();
      setTimeout(() => stream.resume(), (chunk.length * 1000 * 4) / SLOW_BYTES_A_SECOND);
    });
    stream.on('end', () => response.end());
    response.on('close', () => stream.destroy());
    return;
  }
  say(404);
  response.writeHead(404).end();
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Offering ${version} (code ${code}), ${bytes} bytes, sha256 ${sha256}`);
  console.log(`at ${origin}/<good|slow|hash|stale|future|sdk|garbage|hang>/phone.json — this computer only; reach it from the phone with: adb reverse tcp:${port} tcp:${port}`);
});
