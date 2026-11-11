// Fork: where the downloaded models are kept, and moving them.
//
// The three native engines (recognition, translation, feedback) each keep a folder of their own — the runtime and its
// models — under one root: the app's data folder by default, which on Windows is on drive C. Their models run to
// gigabytes (11 GB on one computer), and a friend's drive C had no room for them (2026-11-05). The root can be another
// folder: what is already downloaded moves there with it, so nothing is fetched again.
//
// A move copies everything first and lets go of the old folders only once every file is there whole: stopped or
// failed halfway, the models are where they were, and nothing changed. On the same drive it is a rename.
//
// No Electron import: the folders and the disk are handed in, and its tests need neither.
const fs = require('fs');
const path = require('path');

/** Each engine's folder under the root (`main.js`). */
const KINDS = ['native-engine', 'native-translator', 'native-coach', 'sherpa-engine'];
/** Written in the app's data folder: the root, where it is not the default. */
const CONFIG = 'model-storage.json';
/** Kept free on the drive moved to, beyond what moves: the drive is not filled to its last byte. */
const MARGIN = 512 * 1024 ** 2;
/** How often progress is told while copying. */
const PROGRESS_MS = 200;
const CHUNK = 4 * 1024 ** 2;

function createModelStorage({ userData, files = fs, statfs = (p) => files.statfsSync(p), now = Date.now, platform = process.platform }) {
  const configFile = path.join(userData, CONFIG);

  const read = () => {
    try {
      const saved = JSON.parse(files.readFileSync(configFile, 'utf8'));
      return typeof saved?.root === 'string' && path.isAbsolute(saved.root) ? path.normalize(saved.root) : null;
    } catch { return null; }
  };
  /** The folder the engines' folders are in. */
  const root = () => read() ?? userData;
  const exists = (p) => { try { return files.statSync(p).isDirectory(); } catch { return false; } };

  /** Every file under `dir`, with its size: `[{ file, bytes }]`; nothing for a folder that is not there. */
  const walk = (dir) => {
    const out = [];
    const visit = (at) => {
      let entries;
      try { entries = files.readdirSync(at, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const full = path.join(at, entry.name);
        if (entry.isDirectory()) visit(full);
        else if (entry.isFile()) { try { out.push({ file: full, bytes: files.statSync(full).size }); } catch { /* gone meanwhile */ } }
      }
    };
    visit(dir);
    return out;
  };
  const usedAt = (where) => KINDS.reduce((sum, kind) => sum + walk(path.join(where, kind)).reduce((s, f) => s + f.bytes, 0), 0);

  /** The nearest folder of `p` that is there: a drive's free space is asked of something on it. */
  const nearest = (p) => {
    let at = path.resolve(p);
    while (!exists(at)) {
      const up = path.dirname(at);
      if (up === at) return null;
      at = up;
    }
    return at;
  };
  /** The drive `p` is on, as a person names it: `D:` on Windows, the volume's name on a Mac; with its free and total bytes. */
  const driveOf = (p) => {
    const at = nearest(p);
    let freeBytes = null;
    let totalBytes = null;
    if (at) {
      try {
        const s = statfs(at);
        freeBytes = Number(s.bavail) * Number(s.bsize);
        totalBytes = Number(s.blocks) * Number(s.bsize);
      } catch { /* no statfs here: said as unknown */ }
    }
    let name;
    if (platform === 'win32') name = path.win32.parse(path.resolve(p)).root.replace(/\\$/, '');
    else {
      const volume = /^\/Volumes\/([^/]+)/.exec(path.resolve(p));
      name = volume ? volume[1] : '';
    }
    return { name, freeBytes, totalBytes };
  };
  /** Whether two folders are on one drive: a move between them is a rename. */
  const sameDrive = (a, b) => {
    try { return files.statSync(nearest(a)).dev === files.statSync(nearest(b)).dev; } catch { return false; }
  };

  /** Where the models are, how much they take, and the room left on their drive. `missing`: a chosen folder is gone (a drive not plugged in). */
  function status() {
    const where = root();
    const isDefault = where === userData;
    const missing = !isDefault && !exists(where);
    return { root: where, isDefault, missing, usedBytes: missing ? 0 : usedAt(where), drive: driveOf(where) };
  }

  /**
   * What moving to `chosen` would take, asked before anything moves. A drive's own root takes a folder of its own
   * (`D:\` → `D:\Kotomimi`). `error`: why it cannot — `same` (it is where they are), `inside` (in the folder they
   * are in, or the other way), `not_writable`, `no_space`.
   */
  function plan(chosen) {
    const from = root();
    // A folder named in full: one relative to wherever the app runs from is no place a person chose.
    if (!path.isAbsolute(String(chosen ?? ''))) return { target: String(chosen ?? ''), needBytes: 0, drive: driveOf(from), error: 'not_writable' };
    let target = path.resolve(String(chosen ?? ''));
    if (path.parse(target).root === target) target = path.join(target, 'Kotomimi');
    const needBytes = usedAt(from);
    const drive = driveOf(target);
    const base = { target, needBytes, drive };
    const norm = (p) => (platform === 'win32' ? p.toLowerCase() : p);
    if (norm(target) === norm(from)) return { ...base, error: 'same' };
    // Into one of the folders that move: it would be copied into itself.
    const within = (a, b) => norm(a) === norm(b) || norm(a).startsWith(norm(b) + path.sep);
    if (KINDS.some((kind) => within(target, path.join(from, kind)))) return { ...base, error: 'inside' };
    try {
      files.mkdirSync(target, { recursive: true });
      const probe = path.join(target, `.kotomimi-${process.pid}-${now()}`);
      files.writeFileSync(probe, '');
      files.rmSync(probe, { force: true });
    } catch {
      return { ...base, error: 'not_writable' };
    }
    const renames = exists(from) && sameDrive(from, target);
    if (!renames && drive.freeBytes !== null && needBytes + MARGIN > drive.freeBytes) return { ...base, error: 'no_space' };
    return { ...base, sameDrive: renames };
  }

  /** The root written down; the default written as none. */
  const save = (where) => {
    if (path.normalize(where) === userData) files.rmSync(configFile, { force: true });
    else files.writeFileSync(configFile, JSON.stringify({ root: where }, null, 2));
  };

  /**
   * The models moved to `target` (a `plan` with no error): `onProgress({ copied, total })` as they go; `signal`
   * stops it, and nothing is left changed. Resolves to the new `status()`.
   */
  async function move(target, { onProgress = () => {}, signal } = {}) {
    const from = root();
    const checked = plan(target);
    if (checked.error) throw Object.assign(new Error(`The models cannot move there (${checked.error}).`), { code: checked.error });
    const to = checked.target;
    const aborted = () => signal?.aborted;

    // Folders renamed on one drive: taken back if anything after fails, so the models stay where the app looks.
    const renamed = [];
    const unrename = () => { for (const [src, dst] of renamed.reverse()) { try { files.renameSync(dst, src); } catch { /* left where it is */ } } };
    if (checked.sameDrive) {
      // One drive: each engine's folder is renamed, unless one is there already, which is merged into instead.
      try {
        for (const kind of KINDS) {
          const src = path.join(from, kind);
          const dst = path.join(to, kind);
          if (!exists(src) || exists(dst)) continue;
          files.renameSync(src, dst);
          renamed.push([src, dst]);
        }
      } catch (error) {
        unrename();
        throw Object.assign(error, { code: error.code ?? 'move_failed' });
      }
    }

    // What is left to copy: another drive, or a folder that was there already.
    const plan2 = KINDS.flatMap((kind) => walk(path.join(from, kind)).map(({ file, bytes }) => ({ file, bytes, dst: path.join(to, path.relative(from, file)) })));
    const total = plan2.reduce((s, f) => s + f.bytes, 0);
    const made = [];
    let copied = 0;
    let told = 0;
    const tell = (force) => {
      if (!force && now() - told < PROGRESS_MS) return;
      told = now();
      onProgress({ copied, total });
    };
    tell(true);
    try {
      for (const { file, bytes, dst } of plan2) {
        if (aborted()) throw Object.assign(new Error('The move was stopped.'), { code: 'stopped' });
        // A file already there whole is kept: it is one a move before left behind.
        let there = -1;
        try { there = files.statSync(dst).size; } catch { /* not there */ }
        if (there === bytes) { copied += bytes; tell(false); continue; }
        files.mkdirSync(path.dirname(dst), { recursive: true });
        made.push(dst);
        await copyFile(file, dst, (n) => { copied += n; tell(false); }, aborted);
        if (files.statSync(dst).size !== bytes) throw Object.assign(new Error(`${path.basename(file)} did not copy whole.`), { code: 'copy_failed' });
      }
    } catch (error) {
      // Stopped or failed: the copies made are taken back, and the old folders were never touched.
      for (const file of made) { try { files.rmSync(file, { force: true }); } catch { /* left */ } }
      unrename();
      throw error;
    }
    tell(true);
    save(to);
    // Everything is in the new place: the old folders go.
    for (const kind of KINDS) {
      try { files.rmSync(path.join(from, kind), { recursive: true, force: true }); } catch { /* left behind: harmless */ }
    }
    return status();
  }

  /** Back to the app's own folder: what was in the chosen one (gone) is downloaded again where it is needed. */
  function reset() {
    files.rmSync(configFile, { force: true });
    return status();
  }

  /** A file copied in pieces, each piece told; stops between pieces. */
  function copyFile(src, dst, onBytes, aborted) {
    return new Promise((resolve, reject) => {
      const input = files.createReadStream(src, { highWaterMark: CHUNK });
      const output = files.createWriteStream(dst);
      let done = false;
      const fail = (error) => {
        if (done) return;
        done = true;
        input.destroy();
        output.destroy();
        reject(error);
      };
      input.on('data', (chunk) => {
        if (aborted()) { fail(Object.assign(new Error('The move was stopped.'), { code: 'stopped' })); return; }
        onBytes(chunk.length);
      });
      input.on('error', fail);
      output.on('error', fail);
      output.on('finish', () => { if (!done) { done = true; resolve(); } });
      input.pipe(output);
    });
  }

  return { root, status, plan, move, reset, KINDS };
}

module.exports = { createModelStorage, KINDS, MARGIN };
