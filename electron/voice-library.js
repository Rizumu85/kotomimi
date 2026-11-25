// Fork: the user's own voices — short recordings a cloning voice model speaks from (`clone` in `VOICES`,
// native-engine.js). A voice is one person's: a first recording, with the words said in it where they are known (one
// read from the screen; an imported one may have none) and its language, and — for someone sure of how they sound
// in another language — a recording more in each such language. A language with a recording of its own is spoken on
// from that one; every other is spoken from the sound of the first (`reference`; `speechRequest`). Each recording is
// a WAV in a folder of the profile, beside one list of what they are. They are the user's own voice: nothing here
// leaves this computer but a file the user exports themselves.
//
// Kept apart from main.js, with no Electron import, so its tests run on a temporary folder.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/** What one recording may be: long enough to carry a voice, short enough to be read quickly by the engine. */
const LEAST_SECONDS = 1;
const MOST_SECONDS = 30;
const MOST_VOICES = 40;
const MOST_NAME = 40;
const MOST_WORDS = 400;
/** What an exported voice is known by. */
const PACK_FORMAT = 'kotomimi-voice';
/** The recordings one voice may hold: the first, and one more for each other language. */
const MOST_TAKES = 10;
/** The most a recording's file may be (30 s of 48 kHz stereo is under 6 MB), and a pack that holds a voice's. */
const MOST_WAV_BYTES = 8 * 1024 * 1024;
const MOST_PACK_BYTES = 24 * 1024 * 1024;

/** A 16-bit PCM WAV's shape, or null for anything else: where its sound is, its rate and its length. */
function wavInfo(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') return null;
  let format = null;
  for (let at = 12; at + 8 <= bytes.length;) {
    const id = bytes.toString('ascii', at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    if (id === 'fmt ' && size >= 16 && at + 24 <= bytes.length) {
      format = { code: bytes.readUInt16LE(at + 8), channels: bytes.readUInt16LE(at + 10), sampleRate: bytes.readUInt32LE(at + 12), bits: bytes.readUInt16LE(at + 22) };
    } else if (id === 'data') {
      if (!format || format.code !== 1 || format.bits !== 16 || format.channels < 1 || format.sampleRate < 8000 || format.sampleRate > 48000) return null;
      // A file cut short says more sound than it holds: not kept, the engine would read past its end.
      const dataBytes = size;
      if (dataBytes > bytes.length - (at + 8) || dataBytes % (format.channels * 2) !== 0) return null;
      return { ...format, dataOffset: at + 8, dataBytes, seconds: dataBytes / (format.sampleRate * format.channels * 2) };
    }
    at += 8 + size + (size % 2);
  }
  return null;
}

const nameOf = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, MOST_NAME);
const wordsOf = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, MOST_WORDS);
const languageOf = (value) => (typeof value === 'string' && /^[a-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/i.test(value) ? value : '');

/** A language as recordings are told apart by: its base code, or '' where it is not known. */
const keyOf = (language) => /^[a-z]{2,3}/.exec(String(language ?? '').toLowerCase())?.[0] ?? '';

function createVoiceLibrary({ dir, files = fs, now = () => Date.now(), newId = () => crypto.randomBytes(5).toString('hex') }) {
  const listFile = path.join(dir, 'voices.json');
  /** The first recording of a voice, or its one in another language (`key`). */
  const fileOf = (id, key = '') => path.join(dir, key ? `${id}.${key}.wav` : `${id}.wav`);

  /** The list as it is kept, less any voice whose first recording is gone, and any other recording that is. */
  const read = () => {
    let kept = [];
    try {
      const parsed = JSON.parse(files.readFileSync(listFile, 'utf8'));
      if (Array.isArray(parsed)) kept = parsed;
    } catch {
      // None yet, or unreadable: there are none.
    }
    return kept.filter((voice) => voice && typeof voice.id === 'string' && /^[a-f0-9]{6,32}$/.test(voice.id) && files.existsSync(fileOf(voice.id)))
      .map((voice) => {
        const language = languageOf(voice.language);
        const seen = new Set([keyOf(language)]);
        const more = (Array.isArray(voice.more) ? voice.more : [])
          .map((take) => ({ language: languageOf(take?.language), text: wordsOf(take?.text), seconds: Number(take?.seconds) || 0 }))
          .filter((take) => { const key = keyOf(take.language); if (!key || seen.has(key) || !files.existsSync(fileOf(voice.id, key))) return false; seen.add(key); return true; })
          .slice(0, MOST_TAKES - 1);
        return { id: voice.id, name: nameOf(voice.name) || 'Voice', text: wordsOf(voice.text), language, seconds: Number(voice.seconds) || 0, createdAt: Number(voice.createdAt) || 0, more };
      });
  };
  const write = (voices) => {
    files.mkdirSync(dir, { recursive: true });
    const part = `${listFile}.part`;
    files.writeFileSync(part, JSON.stringify(voices, null, 1));
    files.renameSync(part, listFile);
  };
  /** A voice as the page is told of it: its first recording's words, language and length, and the languages it has a recording in. */
  const told = (voice) => ({
    id: voice.id, name: voice.name, text: voice.text, language: voice.language, seconds: voice.seconds, createdAt: voice.createdAt,
    languages: [keyOf(voice.language), ...voice.more.map((take) => keyOf(take.language))].filter(Boolean),
  });

  /** A name no voice of `voices` has: the one wanted, or that with a number after it. */
  const freeName = (voices, wanted) => {
    const taken = new Set(voices.map((voice) => voice.name));
    let named = wanted;
    for (let n = 2; taken.has(named); n += 1) named = `${wanted.slice(0, MOST_NAME - 3)} ${n}`;
    return named;
  };

  /**
   * A recording added: `{ ok, voice }`, or `{ error }` in words for the logs with a `code` for the page. With `to`,
   * the voice it is one more recording of: in a language that voice has one in already, it takes that one's place.
   */
  function add({ name, text, language, wav, to } = {}) {
    const bytes = Buffer.isBuffer(wav) ? wav : wav instanceof Uint8Array ? Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength) : null;
    const info = bytes && bytes.length <= MOST_WAV_BYTES ? wavInfo(bytes) : null;
    if (!info) return { error: 'The recording is not a 16-bit WAV.', code: 'voice_unreadable' };
    if (info.seconds < LEAST_SECONDS) return { error: 'The recording is too short.', code: 'voice_too_short' };
    if (info.seconds > MOST_SECONDS) return { error: 'The recording is too long.', code: 'voice_too_long' };
    const voices = read();
    const take = { language: languageOf(language), text: wordsOf(text), seconds: Math.round(info.seconds * 10) / 10 };
    const key = keyOf(take.language);
    let voice;
    let file;
    if (to !== undefined) {
      const whose = voices.find((one) => one.id === to);
      if (!whose) return { error: 'There is no such voice to add a recording to.', code: 'voice_failed' };
      // Told apart by language: one that names none could never be the one a language is read from.
      if (!key) return { error: 'A recording added to a voice must say what language it is in.', code: 'voice_failed' };
      if (key === keyOf(whose.language)) {
        voice = { ...whose, ...take };
        file = fileOf(whose.id);
      } else {
        const others = whose.more.filter((one) => keyOf(one.language) !== key);
        if (others.length >= MOST_TAKES - 1) return { error: 'The voice has too many recordings already.', code: 'voice_too_many' };
        voice = { ...whose, more: [...others, take] };
        file = fileOf(whose.id, key);
      }
    } else {
      if (voices.length >= MOST_VOICES) return { error: 'There are too many voices already.', code: 'voice_too_many' };
      voice = { id: newId(), name: freeName(voices, nameOf(name) || 'Voice'), ...take, createdAt: now(), more: [] };
      file = fileOf(voice.id);
    }
    const was = files.existsSync(file);
    try {
      files.mkdirSync(dir, { recursive: true });
      files.writeFileSync(file, bytes);
      write(to === undefined ? [...voices, voice] : voices.map((one) => (one.id === voice.id ? voice : one)));
    } catch (error) {
      // Not listed: a recording that was not there before is not left behind either.
      if (!was) { try { files.rmSync(file, { force: true }); } catch { /* nothing was written */ } }
      return { error: `The recording could not be kept: ${String(error?.message ?? error).slice(0, 200)}`, code: 'voice_failed' };
    }
    return { ok: true, voice: told(voice) };
  }

  function remove(id) {
    const voices = read();
    const voice = voices.find((one) => one.id === id);
    if (!voice) return false;
    // The recordings first, the voice's first one last: one that cannot be removed (the engine is reading it) leaves
    // the voice listed, and a list that could not be written after them heals itself — a voice with no first
    // recording is not listed (`read`).
    try {
      for (const take of voice.more) files.rmSync(fileOf(id, keyOf(take.language)), { force: true });
      files.rmSync(fileOf(id), { force: true });
    } catch {
      return false;
    }
    try { write(voices.filter((one) => one.id !== id)); } catch { /* read() leaves it out */ }
    return true;
  }

  /** One of a voice's recordings in another language than its first, taken away: that language is then read from the first. */
  function removeTake(id, language) {
    const voices = read();
    const key = keyOf(language);
    const voice = voices.find((one) => one.id === id);
    if (!voice || !key || !voice.more.some((take) => keyOf(take.language) === key)) return false;
    try {
      files.rmSync(fileOf(id, key), { force: true });
    } catch {
      return false;
    }
    try { write(voices.map((one) => (one.id === id ? { ...one, more: one.more.filter((take) => keyOf(take.language) !== key) } : one))); } catch { /* read() leaves it out */ }
    return true;
  }

  function rename(id, name) {
    const voices = read();
    const named = nameOf(name);
    if (!named || !voices.some((voice) => voice.id === id)) return false;
    // Two voices of one name could not be told apart where one is chosen.
    const free = freeName(voices.filter((voice) => voice.id !== id), named);
    write(voices.map((voice) => (voice.id === id ? { ...voice, name: free } : voice)));
    return true;
  }

  /**
   * What the engine is given to speak `language` in a voice: where the recording is, its words, and the language
   * they are in — the voice's own recording in that language where it has one, else its first. Null: there is no
   * voice by this id.
   */
  function reference(id, language) {
    const voice = read().find((one) => one.id === id);
    if (!voice) return null;
    const key = keyOf(language);
    const take = key && key !== keyOf(voice.language) ? voice.more.find((one) => keyOf(one.language) === key) : undefined;
    return take ? { path: fileOf(id, key), text: take.text, language: take.language } : { path: fileOf(id), text: voice.text, language: voice.language };
  }

  /** A voice as one file to hand to someone else, every recording of it inside. Null: there is none by this id. */
  function pack(id) {
    const voice = read().find((one) => one.id === id);
    if (!voice) return null;
    const sound = (key) => files.readFileSync(fileOf(id, key)).toString('base64');
    return Buffer.from(JSON.stringify({
      format: PACK_FORMAT, version: 2, name: voice.name, text: voice.text, language: voice.language, wav: sound(''),
      more: voice.more.map((take) => ({ language: take.language, text: take.text, wav: sound(keyOf(take.language)) })),
    }));
  }

  /** A voice someone handed over, added as its recordings are: the first as a voice, the others to it. */
  function unpack(bytes) {
    let packed;
    try {
      if (!bytes || bytes.length > MOST_PACK_BYTES) throw new Error('too large');
      packed = JSON.parse(Buffer.from(bytes).toString('utf8'));
    } catch {
      return { error: 'The file is not a voice.', code: 'voice_unreadable' };
    }
    if (!packed || packed.format !== PACK_FORMAT || typeof packed.wav !== 'string') return { error: 'The file is not a voice.', code: 'voice_unreadable' };
    const added = add({ name: packed.name, text: packed.text, language: packed.language, wav: Buffer.from(packed.wav, 'base64') });
    if (!added.ok) return added;
    let voice = added.voice;
    // A recording more that will not do is left out: the voice is still one.
    for (const take of (Array.isArray(packed.more) ? packed.more : []).slice(0, MOST_TAKES - 1)) {
      if (typeof take?.wav !== 'string') continue;
      const more = add({ to: voice.id, text: take.text, language: take.language, wav: Buffer.from(take.wav, 'base64') });
      if (more.ok) voice = more.voice;
    }
    return { ok: true, voice };
  }

  return { list: () => read().map(told), add, remove, removeTake, rename, reference, pack, unpack };
}

module.exports = { createVoiceLibrary, wavInfo, PACK_FORMAT, LEAST_SECONDS, MOST_SECONDS, MOST_VOICES, MOST_TAKES, MOST_WAV_BYTES, MOST_PACK_BYTES };
