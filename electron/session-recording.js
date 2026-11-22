const fs = require('node:fs');
const path = require('node:path');

const RATE = 16000;
// The system's playout, what the loudspeakers play, stays stereo: the echo canceller is measured against it.
const CHANNELS = { speaker: 1, participant: 1, raw: 1, playout: 2 };
const TRACKS = Object.keys(CHANNELS);
const finite = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
const json = (v) => object(v) && Buffer.byteLength(JSON.stringify(v)) <= 1024 * 1024;

/** `samples` counts frames: one sample per channel. */
function wavHeader(samples, channels = 1) {
  const bytes = samples * 2 * channels;
  const b = Buffer.alloc(44);
  b.write('RIFF'); b.writeUInt32LE(36 + bytes, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(RATE, 24); b.writeUInt32LE(RATE * 2 * channels, 28);
  b.writeUInt16LE(2 * channels, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(bytes, 40);
  return b;
}

/** Area averaging before downsampling; chunks carry their own input rate. */
function resample(pcm, rate) {
  const count = Math.round(pcm.length * RATE / rate);
  const out = Buffer.alloc(count * 2);
  const ratio = rate / RATE;
  for (let i = 0; i < count; i++) {
    const a = i * ratio, b = Math.min(pcm.length, (i + 1) * ratio);
    let sum = 0;
    for (let j = Math.floor(a); j < b; j++) sum += pcm[j] * (Math.min(j + 1, b) - Math.max(j, a));
    out.writeInt16LE(Math.round(sum / (b - a)), i * 2);
  }
  return out;
}

/** Interleaved frames, each channel resampled on its own. */
function resampleFrames(pcm, rate, channels) {
  if (channels === 1) return resample(pcm, rate);
  const parts = [];
  for (let c = 0; c < channels; c++) {
    const one = new Int16Array(pcm.length / channels);
    for (let i = 0; i < one.length; i++) one[i] = pcm[i * channels + c];
    parts.push(resample(one, rate));
  }
  const frames = parts[0].length / 2;
  const out = Buffer.alloc(frames * 2 * channels);
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) out.writeInt16LE(parts[c].readInt16LE(i * 2), (i * channels + c) * 2);
  return out;
}

function writeAll(fd, buffer, position) {
  let n = 0;
  while (n < buffer.length) n += fs.writeSync(fd, buffer, n, buffer.length - n, position + n);
}

function recordings(root) {
  fs.mkdirSync(root, { recursive: true });
  return fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => {
    const dir = path.join(root, d.name);
    let session = null;
    try {
      const file = path.join(dir, 'session.json');
      if (fs.lstatSync(file).isFile() && fs.statSync(file).size <= 1024 * 1024) {
        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (object(value) && finite(value.startedAt) && (value.endedAt === null || finite(value.endedAt))) session = value;
      }
    } catch (cause) {
      if (cause.code !== 'ENOENT' && !(cause instanceof SyntaxError)) throw cause;
    }
    const bytes = fs.readdirSync(dir, { withFileTypes: true }).filter((f) => f.isFile())
      .reduce((n, f) => n + fs.statSync(path.join(dir, f.name)).size, 0);
    return { dir, session, bytes, start: session?.startedAt ?? fs.statSync(dir).mtimeMs };
  }).sort((a, b) => a.start - b.start);
}

function retain(root, now, limit = 2 * 1024 ** 3) {
  const list = recordings(root);
  let total = list.reduce((n, r) => n + r.bytes, 0);
  for (const r of list) {
    if (r.start < now - 7 * 86400000 || total > limit) {
      // dir is a direct, non-symlink child enumerated inside our recordings root.
      fs.rmSync(r.dir, { recursive: true });
      total -= r.bytes;
    }
  }
}

function createSessionRecording({ userData, appVersion, platform }) {
  const root = path.join(userData, 'session-recordings');
  let active = null;
  const save = () => fs.writeFileSync(path.join(active.dir, 'session.json'), JSON.stringify(active.meta, null, 2));
  const close = () => {
    for (const track of Object.values(active.tracks)) fs.closeSync(track.fd);
    active = null;
  };
  return {
    root,
    abandon() { if (active) close(); },
    start(payload) {
      if (!json(payload) || !finite(payload.startedAt) || !json(payload.metadata)) throw new Error('Invalid recording start.');
      if (active) throw new Error('A recording is already open.');
      retain(root, Date.now());
      const d = new Date(payload.startedAt);
      const pad = (n, width = 2) => String(n).padStart(width, '0');
      const name = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}-${pad(d.getMilliseconds(), 3)}`;
      const dir = path.join(root, name);
      fs.mkdirSync(dir);
      active = { dir, tracks: {}, meta: { ...payload.metadata, formatVersion: 1, appVersion, platform,
        sampleRate: RATE, startedAt: payload.startedAt, endedAt: null, tracks: [] } };
      try {
        save();
        for (const leg of TRACKS) {
          const fd = fs.openSync(path.join(dir, `${leg}.wav`), 'wx');
          active.tracks[leg] = { fd, samples: 0, channels: CHANNELS[leg] };
          // A crash may leave these lengths unpatched. ffmpeg can still read the PCM to EOF.
          writeAll(fd, wavHeader(0, CHANNELS[leg]), 0);
        }
        for (const file of ['lines.jsonl', 'marks.jsonl']) fs.writeFileSync(path.join(dir, file), '');
      } catch (cause) { close(); throw cause; }
      return { ok: true };
    },
    write(p) {
      if (!object(p) || !['pcm', 'line', 'track', 'metadata'].includes(p.kind)) throw new Error('Invalid recording event.');
      if (!active) throw new Error('No recording is open.');
      if (p.kind === 'pcm') {
        if (!TRACKS.includes(p.leg) || !finite(p.ms) || p.ms > 36 * 3600000 || !Number.isInteger(p.rate)
          || p.rate < RATE || p.rate > 192000 || !(p.pcm instanceof Int16Array) || !p.pcm.length
          || p.pcm.length % CHANNELS[p.leg] || p.pcm.length > p.rate * 2 * CHANNELS[p.leg]) throw new Error('Invalid PCM chunk.');
        const track = active.tracks[p.leg];
        const frame = 2 * track.channels;
        const pcm = resampleFrames(p.pcm, p.rate, track.channels);
        // Arrival marks the END of a chunk. Snap small jitter, keep real pauses and restarts.
        let start = Math.round(p.ms * RATE / 1000) - pcm.length / frame;
        if (Math.abs(start - track.samples) <= RATE * 0.02) start = track.samples;
        const skip = Math.max(0, track.samples - start, -start);
        start += skip;
        if (skip * frame < pcm.length) {
          // Positional writes make holes read as silence without buffering a gap in memory.
          writeAll(track.fd, pcm.subarray(skip * frame), 44 + start * frame);
          track.samples = start + pcm.length / frame - skip;
        }
      } else {
        if (!json(p.data)) throw new Error('Invalid recording data.');
        if (p.kind === 'line') fs.appendFileSync(path.join(active.dir, 'lines.jsonl'), JSON.stringify(p.data) + '\n');
        if (p.kind === 'track') { active.meta.tracks.push(p.data); save(); }
        if (p.kind === 'metadata') { active.meta.runtime = p.data; save(); }
      }
      return { ok: true };
    },
    end(p) {
      if (!object(p) || !finite(p.endedAt) || !finite(p.durationMs) || p.durationMs > 36 * 3600000) throw new Error('Invalid recording end.');
      if (!active) throw new Error('No recording is open.');
      try {
        const samples = Math.max(Math.round(p.durationMs * RATE / 1000), ...Object.values(active.tracks).map((t) => t.samples));
        for (const track of Object.values(active.tracks)) {
          fs.ftruncateSync(track.fd, 44 + samples * 2 * track.channels);
          writeAll(track.fd, wavHeader(samples, track.channels), 0);
        }
        active.meta.endedAt = p.endedAt;
        active.meta.durationMs = p.durationMs;
        save();
      } finally { close(); }
      return { ok: true };
    },
    mark(p) {
      if (!json(p) || !finite(p.wallTime) || !finite(p.markedAt) || !['speaker', 'participant'].includes(p.leg)
        || typeof p.entryId !== 'string' || typeof p.sourceText !== 'string' || typeof p.translationText !== 'string') throw new Error('Invalid line mark.');
      const found = recordings(root).reverse().find(({ session, dir }) => session && session.startedAt <= p.wallTime
        && p.wallTime <= (session.endedAt ?? (active?.dir === dir ? Date.now() : -1)));
      const dir = found?.dir;
      if (!dir) return { ok: false, reason: 'not-recorded', error: 'No recording covers this line.' };
      fs.appendFileSync(path.join(dir, 'marks.jsonl'), JSON.stringify(p) + '\n');
      return { ok: true };
    },
  };
}

function setupSessionRecordingHandlers({ ipcMain, app, shell, isTrustedSender }) {
  const recorder = createSessionRecording({ userData: app.getPath('userData'), appVersion: app.getVersion(), platform: process.platform });
  const watched = new WeakSet();
  let owner = null;
  const handle = (fn) => async (event, payload) => {
    if (!isTrustedSender(event.sender)) return { ok: false, error: 'Recording refused: not the main window.' };
    try { return await fn(payload); }
    catch (cause) { return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }; }
  };
  ipcMain.handle('session-recording:start', (event, payload) => {
    if (isTrustedSender(event.sender)) {
      owner = event.sender;
      if (!watched.has(owner)) {
        watched.add(owner);
        const sender = owner;
        // A crashed/reloaded renderer must not leave descriptors open or block the next run.
        const abandon = () => { if (owner === sender) recorder.abandon(); };
        sender.on('render-process-gone', abandon);
        sender.on('destroyed', abandon);
        sender.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
          if (mainFrame && !inPlace) abandon();
        });
      }
    }
    return handle((p) => recorder.start(p))(event, payload);
  });
  ipcMain.handle('session-recording:write', handle((p) => recorder.write(p)));
  ipcMain.handle('session-recording:end', handle((p) => recorder.end(p)));
  ipcMain.handle('session-recording:mark', handle((p) => recorder.mark(p)));
  ipcMain.handle('session-recording:open', handle(async () => {
    fs.mkdirSync(recorder.root, { recursive: true });
    const error = await shell.openPath(recorder.root);
    return error ? { ok: false, error } : { ok: true };
  }));
}

module.exports = { createSessionRecording, setupSessionRecordingHandlers, retain, resample, wavHeader };
