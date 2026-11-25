// Fork: the user's own voices — short recordings a cloning voice model speaks from (`clone` in `VOICES`,
// native-engine.js). A voice is one person's: a first recording, with the words said in it where they are known (one
// read from the screen; an imported one may have none) and its language, and other recordings by language and tone.
// A sentence takes its tone from the recording. Only in the recording's language is it spoken on from its words.
// Each recording is a WAV in a folder of the profile, beside one list of what they are. They are the user's own
// voice: nothing here leaves this computer but a file the user exports themselves.
//
// Kept apart from main.js, with no Electron import, so its tests run on a temporary folder.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { speaksFromWords } = require('./native-engine');

/** What one recording may be: long enough to carry a voice, short enough to be read quickly by the engine. */
const LEAST_SECONDS = 1;
const MOST_SECONDS = 30;
const MOST_VOICES = 40;
const MOST_NAME = 40;
const MOST_WORDS = 400;
// These takes are sounds. A laugh alone loses the speaker's likeness, which the plain recording preserves.
const SOUND_TONES = new Set(['laugh']);
const SOUND_GAP = 0.25;
// Each second of reference with words costs about 2.7 s before the first sentence.
const MOST_SOUND_SECONDS = 4;
/** What an exported voice is known by. */
const PACK_FORMAT = 'kotomimi-voice';
/** The recordings one voice may hold, its first included. */
const MOST_TAKES = 24;
/** The most a recording's file may be (30 s of 48 kHz stereo is under 6 MB), and a pack that holds a voice's. */
const MOST_WAV_BYTES = 8 * 1024 * 1024;
const MOST_PACK_BYTES = 48 * 1024 * 1024;

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
      if (!format || format.code !== 1 || format.bits !== 16 || format.channels < 1 || format.channels > 2 || format.sampleRate < 8000 || format.sampleRate > 48000) return null;
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
const validTone = (value) => value === '' || (typeof value === 'string' && /^[a-z]{2,12}$/.test(value));

/** A language as recordings are told apart by: its base code, or '' where it is not known. */
const keyOf = (language) => /^[a-z]{2,3}/.exec(String(language ?? '').toLowerCase())?.[0] ?? '';

function createVoiceLibrary({ dir, files = fs, now = () => Date.now(), newId = () => crypto.randomBytes(5).toString('hex') }) {
  const listFile = path.join(dir, 'voices.json');
  const fileOf = (id, key = '', tone = '') => path.join(dir, [id, key, tone, 'wav'].filter(Boolean).join('.'));
  let joinedDir;

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
        const seen = new Set([`${keyOf(language)}.`]);
        const more = (Array.isArray(voice.more) ? voice.more : [])
          .map((take) => ({ language: languageOf(take?.language), tone: take?.tone === undefined ? '' : take.tone, text: wordsOf(take?.text), seconds: Number(take?.seconds) || 0 }))
          .filter((take) => {
            const key = keyOf(take.language);
            if (!key || !validTone(take.tone)) return false;
            const pair = `${key}.${take.tone}`;
            if (seen.has(pair) || !files.existsSync(fileOf(voice.id, key, take.tone))) return false;
            seen.add(pair);
            return true;
          })
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
  /** The first recording describes the voice. Each tone lists its own languages. */
  const told = (voice) => {
    const languages = [keyOf(voice.language)].filter(Boolean);
    const tones = new Map();
    for (const take of voice.more) {
      const key = keyOf(take.language);
      if (!take.tone) languages.push(key);
      else {
        if (!tones.has(take.tone)) tones.set(take.tone, []);
        tones.get(take.tone).push(key);
      }
    }
    return {
      id: voice.id, name: voice.name, text: voice.text, language: voice.language, seconds: voice.seconds, createdAt: voice.createdAt,
      languages, tones: Array.from(tones, ([tone, languages]) => ({ tone, languages })),
    };
  };

  /** A name no voice of `voices` has: the one wanted, or that with a number after it. */
  const freeName = (voices, wanted) => {
    const taken = new Set(voices.map((voice) => voice.name));
    let named = wanted;
    for (let n = 2; taken.has(named); n += 1) named = `${wanted.slice(0, MOST_NAME - 3)} ${n}`;
    return named;
  };

  /**
   * A recording added: `{ ok, voice }`, or `{ error }` in words for the logs with a `code` for the page. With `to`,
   * the voice it is one more recording of: the same language and tone take the previous recording's place.
   */
  function add({ name, text, language, wav, to, tone = '' } = {}) {
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
      if (!key) return { error: 'A recording added to a voice must say what language it is in.', code: 'voice_failed' };
      if (!validTone(tone)) return { error: 'The recording has an invalid tone.', code: 'voice_failed' };
      if (!tone && key === keyOf(whose.language)) {
        voice = { ...whose, ...take };
        file = fileOf(whose.id);
      } else {
        const more = whose.more;
        const at = more.findIndex((one) => one.tone === tone && keyOf(one.language) === key);
        if (at < 0 && more.length >= MOST_TAKES - 1) return { error: 'The voice has too many recordings already.', code: 'voice_too_many' };
        if (at >= 0) more.splice(at, 1);
        // Keep a tone's languages together so its place survives removing its earliest recording.
        const last = more.findLastIndex((one) => one.tone === tone);
        const insert = tone && at >= 0 ? at : last >= 0 ? last + 1 : more.length;
        more.splice(insert, 0, { ...take, tone });
        voice = whose;
        file = fileOf(whose.id, key, tone);
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
      for (const take of voice.more) files.rmSync(fileOf(id, keyOf(take.language), take.tone), { force: true });
      files.rmSync(fileOf(id), { force: true });
    } catch {
      return false;
    }
    try { write(voices.filter((one) => one.id !== id)); } catch { /* read() leaves it out */ }
    return true;
  }

  /** Any recording but the first may be taken away on its own. */
  function removeTake(id, language, tone = '') {
    const voices = read();
    const key = keyOf(language);
    const voice = voices.find((one) => one.id === id);
    const take = voice?.more.find((one) => keyOf(one.language) === key && one.tone === tone);
    if (!take) return false;
    try {
      files.rmSync(fileOf(id, key, take.tone), { force: true });
    } catch {
      return false;
    }
    voice.more.splice(voice.more.indexOf(take), 1);
    try { write(voices); } catch { /* read() leaves it out */ }
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

  function joined(base, sound) {
    const plain = files.readFileSync(base.path);
    const tail = files.readFileSync(sound.path);
    const a = wavInfo(plain);
    const b = wavInfo(tail);
    if (!a || !b || a.sampleRate !== b.sampleRate || a.channels !== b.channels) return base;
    const frame = a.channels * 2;
    const end = b.dataOffset + Math.min(b.dataBytes, MOST_SOUND_SECONDS * b.sampleRate * frame);
    const text = [base.text, sound.text].filter(Boolean).join(' ');
    const bytes = Buffer.concat([
      plain.subarray(0, a.dataOffset + a.dataBytes),
      Buffer.alloc(Math.round(a.sampleRate * SOUND_GAP) * frame),
      tail.subarray(b.dataOffset, end),
    ]);
    bytes.writeUInt32LE(bytes.length - 8, 4);
    bytes.writeUInt32LE(bytes.length - a.dataOffset, a.dataOffset - 4);
    joinedDir ??= files.mkdtempSync(path.join(os.tmpdir(), 'kotomimi-voice-'));
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    const file = path.join(joinedDir, `${digest}.wav`);
    if (!files.existsSync(file)) {
      files.writeFileSync(`${file}.part`, bytes);
      files.renameSync(`${file}.part`, file);
    }
    return { path: file, text, language: base.language };
  }

  function referenceFor(voice, language, tone) {
    const key = keyOf(language);
    const from = (take) => ({
      path: take === voice ? fileOf(voice.id) : fileOf(voice.id, keyOf(take.language), take.tone),
      text: take.text, language: take.language,
    });
    const base = from(voice.more.find((one) => !one.tone && keyOf(one.language) === key) ?? voice);
    if (!tone || (SOUND_TONES.has(tone) && !speaksFromWords(base, language))) return base;
    const matching = voice.more.filter((one) => one.tone === tone);
    const take = matching.find((one) => keyOf(one.language) === key)
      ?? matching.find((one) => keyOf(one.language) === keyOf(voice.language))
      ?? matching[0];
    if (!take) return base;
    if (!SOUND_TONES.has(tone)) return from(take);
    // Read through with the plain recording's words, a laugh's words must be in the same language: a Chinese laugh
    // with its few words, read on in Japanese, is the cross-language reading that misreads (`speechRequest`).
    const same = matching.find((one) => keyOf(one.language) === keyOf(base.language));
    return same ? joined(base, from(same)) : base;
  }

  function reference(id, language, tone = '') {
    const voice = read().find((one) => one.id === id);
    return voice ? referenceFor(voice, language, tone) : null;
  }

  /** Plain prompts first. Several languages or tones can use the same recording in the same mode. */
  function warmReads(reads, tones, slots) {
    const voices = read();
    const seen = new Set();
    const planned = [];
    for (const tone of ['', ...tones]) {
      for (const { voice, language } of reads) {
        const one = voices.find((v) => v.id === voice);
        if (!one || (tone && !one.more.some((take) => take.tone === tone))) continue;
        const reference = referenceFor(one, language, tone);
        const prompt = JSON.stringify([reference.path, speaksFromWords(reference, language) ? reference.text : '']);
        if (seen.has(prompt)) continue;
        seen.add(prompt);
        planned.push({ voice, language, tone, reference });
        if (planned.length === slots) return planned;
      }
    }
    return planned;
  }

  function clearJoined() {
    if (joinedDir) files.rmSync(joinedDir, { recursive: true, force: true });
    joinedDir = undefined;
  }

  /** A voice as one file to hand to someone else, every recording of it inside. Null: there is none by this id. */
  function pack(id) {
    const voice = read().find((one) => one.id === id);
    if (!voice) return null;
    const sound = (key, tone) => files.readFileSync(fileOf(id, key, tone)).toString('base64');
    return Buffer.from(JSON.stringify({
      format: PACK_FORMAT, version: 3, name: voice.name, text: voice.text, language: voice.language, tone: '', wav: sound(''),
      more: voice.more.map((take) => ({ language: take.language, tone: take.tone, text: take.text, wav: sound(keyOf(take.language), take.tone) })),
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
      const more = add({ to: voice.id, text: take.text, language: take.language, tone: take.tone, wav: Buffer.from(take.wav, 'base64') });
      if (more.ok) voice = more.voice;
    }
    return { ok: true, voice };
  }

  return { list: () => read().map(told), add, remove, removeTake, rename, reference, warmReads, clearJoined,
    pack, unpack };
}

module.exports = {
  createVoiceLibrary, wavInfo, PACK_FORMAT, LEAST_SECONDS, MOST_SECONDS, MOST_VOICES, MOST_TAKES,
  MOST_WAV_BYTES, MOST_PACK_BYTES,
  // The most a recording handed to another device may be: one of the library's, a laugh joined after it
  // (`joined`) in the same shape, at most 48 kHz stereo.
  MOST_REFERENCE_BYTES: MOST_WAV_BYTES + Math.ceil((SOUND_GAP + MOST_SOUND_SECONDS) * 48000) * 2 * 2,
  MOST_REFERENCE_SECONDS: MOST_SECONDS + SOUND_GAP + MOST_SOUND_SECONDS, MOST_REFERENCE_WORDS: 2 * MOST_WORDS + 1,
};
