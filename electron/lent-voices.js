// Fork: the recordings other devices hand this computer to speak from — a device that borrows this computer's cloning
// voice model has the voice, this computer has the model. A recording is kept for as long as it is of use: under a
// name that is its own content (a SHA-256, worked out here, never taken from the device), in a folder of the
// system's temporary files, the few most lately used of them, and none once sharing stops or the app is quit. It is
// never among this computer's own voices, and this computer's own voices are never handed to a device.
//
// Kept apart from main.js, with no Electron import, so its tests run on a temporary folder.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { wavInfo, MOST_SECONDS } = require('./voice-library');

/** A recording as it is handed over: base64 in a JSON body, which the door bounds; and what it may be once read. */
const MOST_WAV_BYTES = 3 * 1024 * 1024;
const MOST_WORDS = 400;
/** Kept at once: a run's few voices and languages, of a device or two. */
const MOST_KEPT = 12;

const languageOf = (value) => (typeof value === 'string' && /^[a-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/i.test(value) ? value : '');

function createLentVoices({ dir, files = fs, most = MOST_KEPT }) {
  /** id → what is said in it, oldest use first. */
  const kept = new Map();
  const fileOf = (id) => path.join(dir, `${id}.wav`);

  /** A recording handed over: `{ ok, id }`, or `{ error, code }`. Handed over again, it is the same one. */
  function keep({ wav, text, language } = {}) {
    let bytes = null;
    try {
      if (typeof wav === 'string' && wav.length <= Math.ceil(MOST_WAV_BYTES / 3) * 4 + 4) bytes = Buffer.from(wav, 'base64');
    } catch {
      bytes = null;
    }
    const info = bytes && bytes.length <= MOST_WAV_BYTES ? wavInfo(bytes) : null;
    if (!info || info.seconds < 1 || info.seconds > MOST_SECONDS) return { error: 'The recording is not a 16-bit WAV of a voice.', code: 'voice_ref_unreadable' };
    // Before anything is written: what a device sends as words may be anything at all.
    const said = { text: (typeof text === 'string' ? text : '').replace(/\s+/g, ' ').trim().slice(0, MOST_WORDS), language: languageOf(language) };
    const id = crypto.createHash('sha256').update(bytes).digest('hex');
    try {
      files.mkdirSync(dir, { recursive: true });
      if (!kept.has(id)) files.writeFileSync(fileOf(id), bytes);
    } catch (error) {
      return { error: `The recording could not be kept: ${String(error?.message ?? error).slice(0, 200)}`, code: 'server_error' };
    }
    kept.delete(id);
    kept.set(id, said);
    while (kept.size > most) {
      const oldest = kept.keys().next().value;
      kept.delete(oldest);
      try { files.rmSync(fileOf(oldest), { force: true }); } catch { /* the engine may be reading it: it goes with the folder */ }
    }
    return { ok: true, id };
  }

  /** What the engine is given to speak from one: where it is, its words, their language. Null: it is not here (any more). */
  function get(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) return null;
    const one = kept.get(id);
    if (!one || !files.existsSync(fileOf(id))) return null;
    // Used: among the last to go.
    kept.delete(id);
    kept.set(id, one);
    return { path: fileOf(id), text: one.text, language: one.language };
  }

  /** Sharing stopped, or the app is going: nothing of another device's is left. */
  function clear() {
    kept.clear();
    try { files.rmSync(dir, { recursive: true, force: true }); } catch { /* gone with the system's temporary files */ }
  }

  return { keep, get, clear, count: () => kept.size };
}

module.exports = { createLentVoices, MOST_WAV_BYTES, MOST_KEPT };
