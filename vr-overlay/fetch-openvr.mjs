// vr-overlay/fetch-openvr.mjs
//
// Fork: fetches the OpenVR SDK files the helper builds against (BSD-3-Clause,
// Valve), pinned by tag and checked by SHA-256, into third_party/openvr/.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TAG = 'v2.15.6';
const FILES = {
  'headers/openvr.h': '1e6ed57199896cc1f7c5484e50fa18955e97be15be690beb28d998c877ead7fd',
  'lib/win64/openvr_api.lib': 'a0bf57c5920f569e8d21ab3e5bc95bac4b73e2016217f8b5b93495a2a7197bbb',
  'bin/win64/openvr_api.dll': 'bab8ac6ef64e68a9ca53315b0014d131088584b2efdfa6db511d67ec03cfcb4a',
  LICENSE: 'f56ff606104d4ef18e617921a75c73ad73b5a1a1d70c69590c29de16919e04ad',
};

const out = join(dirname(fileURLToPath(import.meta.url)), 'third_party', 'openvr');
await mkdir(out, { recursive: true });
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

for (const [path, want] of Object.entries(FILES)) {
  const target = join(out, path.split('/').pop());
  const have = await readFile(target).catch(() => null);
  if (have && sha(have) === want) continue;
  const res = await fetch(`https://raw.githubusercontent.com/ValveSoftware/openvr/${TAG}/${path}`);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (sha(bytes) !== want) throw new Error(`${path}: checksum mismatch`);
  await writeFile(target, bytes);
  console.log(`fetched ${path}`);
}
