// @vitest-environment node
/**
 * Fork: the user's own voices on disk (`voice-library.js`): what a recording must be to be kept, how it is named,
 * found again and handed to the engine, and how one travels as a file.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { TONES } from '../src/lib/voice/tone';

const require = createRequire(import.meta.url);
const { createVoiceLibrary, wavInfo, PACK_FORMAT, MOST_VOICES, MOST_TAKES, MOST_WAV_BYTES, MOST_PACK_BYTES } = require('./voice-library.js');

/** A 16-bit WAV of `seconds`, with a note in it so that it is not silence. */
function wav(seconds, { rate = 24000, channels = 1, bits = 16, code = 1 } = {}) {
  const frames = Math.round(seconds * rate);
  const data = Buffer.alloc(frames * channels * (bits / 8));
  if (bits === 16) for (let i = 0; i < frames * channels; i += 1) data.writeInt16LE(Math.round(8000 * Math.sin(i / 20)), i * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVEfmt ', 8); head.writeUInt32LE(16, 16);
  head.writeUInt16LE(code, 20); head.writeUInt16LE(channels, 22); head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * channels * (bits / 8), 28);
  head.writeUInt16LE(channels * (bits / 8), 32); head.writeUInt16LE(bits, 34); head.write('data', 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

let dir;
let ids;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-voices-')); ids = 0; });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
const library = () => createVoiceLibrary({ dir, now: () => 1_800_000_000_000, newId: () => `abc${String(++ids).padStart(3, '0')}` });

describe('a recording as the library reads it', () => {
  it('is a 16-bit PCM WAV, with its rate and its length', () => {
    expect(wavInfo(wav(5))).toMatchObject({ sampleRate: 24000, channels: 1, seconds: 5 });
    expect(wavInfo(wav(2, { rate: 48000, channels: 2 }))).toMatchObject({ sampleRate: 48000, channels: 2, seconds: 2 });
  });

  it('is nothing else: another sample format, a rate no microphone has, a file that is no WAV', () => {
    expect(wavInfo(wav(5, { bits: 8 }))).toBeNull();
    expect(wavInfo(wav(5, { code: 3 }))).toBeNull();
    expect(wavInfo(wav(5, { rate: 4000 }))).toBeNull();
    // More channels than a microphone gives: a voice recording is mono or stereo.
    expect(wavInfo(wav(1, { channels: 6 }))).toBeNull();
    expect(wavInfo(Buffer.from('not a recording at all, only words in a file that is long enough to look'))).toBeNull();
    expect(wavInfo(wav(5).subarray(0, 30))).toBeNull();
  });

  it('is not one that says more sound than it holds: a file cut short', () => {
    expect(wavInfo(wav(5).subarray(0, 44 + 24000))).toBeNull();
    expect(library().add({ name: 'cut', wav: wav(5).subarray(0, 44 + 24000) })).toMatchObject({ code: 'voice_unreadable' });
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe('the user’s own voices', () => {
  it('keeps a recording with its name, its words and its language, and finds it again', () => {
    const added = library().add({ name: '  我的声音 ', text: '今天天气真不错。', language: 'zh-CN', wav: wav(5) });
    expect(added).toEqual({ ok: true, voice: { id: 'abc001', name: '我的声音', text: '今天天气真不错。', language: 'zh-CN', seconds: 5, createdAt: 1_800_000_000_000, languages: ['zh'], tones: [] } });
    // Another library on the same folder: what is kept is on the disk.
    expect(library().list()).toEqual([added.voice]);
    expect(library().reference('abc001')).toEqual({ path: path.join(dir, 'abc001.wav'), text: '今天天气真不错。', language: 'zh-CN' });
    expect(fs.readFileSync(path.join(dir, 'abc001.wav')).equals(wav(5))).toBe(true);
  });

  it('gives a second voice of the same name a number, and one with no name a name', () => {
    const voices = library();
    voices.add({ name: '我', wav: wav(4) });
    expect(voices.add({ name: '我', wav: wav(4) }).voice.name).toBe('我 2');
    expect(voices.add({ wav: wav(4) }).voice.name).toBe('Voice');
    // Its words may be unknown: an imported recording is cloned from its sound alone.
    expect(voices.reference('abc003')).toEqual({ path: path.join(dir, 'abc003.wav'), text: '', language: '' });
  });

  it('refuses what is no recording, too short, too long, or one too many', () => {
    const voices = library();
    expect(voices.add({ name: 'x', wav: Buffer.from('words') })).toMatchObject({ code: 'voice_unreadable' });
    expect(voices.add({ name: 'x' })).toMatchObject({ code: 'voice_unreadable' });
    expect(voices.add({ name: 'x', wav: wav(0.4) })).toMatchObject({ code: 'voice_too_short' });
    expect(voices.add({ name: 'x', wav: wav(40) })).toMatchObject({ code: 'voice_too_long' });
    expect(voices.list()).toEqual([]);
    for (let i = 0; i < MOST_VOICES; i += 1) expect(voices.add({ name: `v${i}`, wav: wav(1.2) }).ok).toBe(true);
    expect(voices.add({ name: 'one more', wav: wav(1.2) })).toMatchObject({ code: 'voice_too_many' });
  });

  it('takes a recording handed over as bytes of any kind, and holds its words to a length', () => {
    const voices = library();
    const added = voices.add({ name: 'n'.repeat(80), text: '字'.repeat(900), language: '<b>', wav: new Uint8Array(wav(3)) });
    expect(added.voice.name).toHaveLength(40);
    expect(added.voice.text).toHaveLength(400);
    expect(added.voice.language).toBe('');
  });

  it('renames and removes one, with its recording, and says so of one that is not there', () => {
    const voices = library();
    voices.add({ name: 'a', wav: wav(3) });
    voices.add({ name: 'b', wav: wav(3) });
    expect(voices.rename('abc001', 'mine')).toBe(true);
    // Another's name is taken: a number after it; its own name again is no change.
    expect(voices.rename('abc002', 'mine')).toBe(true);
    expect(voices.rename('abc001', 'mine')).toBe(true);
    expect(voices.list().map((voice) => voice.name)).toEqual(['mine', 'mine 2']);
    expect(voices.rename('abc001', '   ')).toBe(false);
    expect(voices.rename('nobody', 'x')).toBe(false);
    expect(voices.remove('abc002')).toBe(true);
    expect(voices.remove('abc002')).toBe(false);
    expect(voices.list().map((voice) => voice.name)).toEqual(['mine']);
    expect(fs.existsSync(path.join(dir, 'abc002.wav'))).toBe(false);
    expect(voices.reference('abc002')).toBeNull();
  });

  it('leaves nothing behind where a voice could not be kept, and keeps one listed whose recording could not be removed', () => {
    // The list cannot be written: the recording is not left with no voice to it.
    const unlisted = createVoiceLibrary({ dir, newId: () => 'abc777', files: { ...fs, renameSync: () => { throw new Error('EPERM'); } } });
    expect(unlisted.add({ name: 'a', wav: wav(3) })).toMatchObject({ code: 'voice_failed' });
    expect(fs.existsSync(path.join(dir, 'abc777.wav'))).toBe(false);
    // The recording is held by something reading it: still a voice, still chosen.
    library().add({ name: 'b', wav: wav(3) });
    const held = createVoiceLibrary({ dir, files: { ...fs, rmSync: () => { throw new Error('EBUSY'); } } });
    expect(held.remove('abc001')).toBe(false);
    expect(library().list().map((voice) => voice.id)).toEqual(['abc001']);
  });

  it('takes no file larger than a voice is, as a recording or as a pack', () => {
    expect(MOST_PACK_BYTES).toBe(48 * 1024 * 1024);
    expect(library().add({ name: 'big', wav: Buffer.concat([wav(5), Buffer.alloc(MOST_WAV_BYTES)]) })).toMatchObject({ code: 'voice_unreadable' });
    expect(library().unpack(Buffer.allocUnsafe(MOST_PACK_BYTES + 1))).toMatchObject({ code: 'voice_unreadable' });
    expect(library().unpack(null)).toMatchObject({ code: 'voice_unreadable' });
    expect(library().list()).toEqual([]);
  });

  it('holds one more recording of a voice for each other language, and speaks each language from its own', () => {
    const voices = library();
    voices.add({ name: '我的声音', text: '今天天气真不错。', language: 'zh-CN', wav: wav(10) });
    // Read in Japanese by the same person: the same voice, not another.
    expect(voices.add({ to: 'abc001', text: '今日はいい天気ですね。', language: 'ja', wav: wav(6) })).toMatchObject({ ok: true, voice: { id: 'abc001', name: '我的声音', language: 'zh-CN', seconds: 10, languages: ['zh', 'ja'] } });
    expect(voices.list()).toHaveLength(1);
    // Japanese is spoken on from the Japanese one; Chinese from the first; any other from the first too.
    expect(voices.reference('abc001', 'ja-JP')).toEqual({ path: path.join(dir, 'abc001.ja.wav'), text: '今日はいい天気ですね。', language: 'ja' });
    expect(voices.reference('abc001', 'zh')).toEqual({ path: path.join(dir, 'abc001.wav'), text: '今天天气真不错。', language: 'zh-CN' });
    expect(voices.reference('abc001', 'en')).toMatchObject({ path: path.join(dir, 'abc001.wav'), language: 'zh-CN' });
    expect(voices.reference('abc001')).toMatchObject({ path: path.join(dir, 'abc001.wav') });
    // Read again in a language it has: in that one's place, the first's too.
    expect(voices.add({ to: 'abc001', text: 'もう一度。', language: 'ja', wav: wav(4) }).voice.languages).toEqual(['zh', 'ja']);
    expect(voices.reference('abc001', 'ja').text).toBe('もう一度。');
    expect(voices.add({ to: 'abc001', text: '再来一遍。', language: 'zh', wav: wav(8) }).voice).toMatchObject({ text: '再来一遍。', seconds: 8, languages: ['zh', 'ja'] });
    expect(wavInfo(fs.readFileSync(path.join(dir, 'abc001.wav'))).seconds).toBe(8);
    // Of no voice, or in no language: not kept.
    expect(voices.add({ to: 'nobody', language: 'ja', wav: wav(4) })).toMatchObject({ code: 'voice_failed' });
    expect(voices.add({ to: 'abc001', language: '', wav: wav(4) })).toMatchObject({ code: 'voice_failed' });
    // Taken away: Japanese is read from the first again. The first cannot be taken away but with the voice.
    expect(voices.removeTake('abc001', 'zh')).toBe(false);
    expect(voices.removeTake('abc001', 'ko')).toBe(false);
    expect(voices.removeTake('abc001', 'ja')).toBe(true);
    expect(fs.existsSync(path.join(dir, 'abc001.ja.wav'))).toBe(false);
    expect(voices.reference('abc001', 'ja')).toMatchObject({ path: path.join(dir, 'abc001.wav'), language: 'zh' });
    expect(voices.list()[0].languages).toEqual(['zh']);
  });

  it('chooses a tone before falling back to plain and keeps tones in the order first made', () => {
    const voices = library();
    const { id } = voices.add({ language: 'en', text: 'First.', tone: 'gentle', wav: wav(1) }).voice;
    const put = (language, tone, text) => voices.add({ to: id, language, tone, text, wav: wav(2) });
    put('ja', '', 'Japanese plain.');
    put('fr', 'gentle', 'French gentle.');
    put('ja', 'bright', 'Japanese bright.');
    put('en-US', 'gentle', 'English gentle.');
    put('ja-JP', 'gentle', 'Japanese gentle.');
    const replaced = put('ja', 'gentle', 'Japanese gentle again.');
    expect(replaced.voice).toMatchObject({ languages: ['en', 'ja'], tones: [
      { tone: 'gentle', languages: ['fr', 'en', 'ja'] }, { tone: 'bright', languages: ['ja'] },
    ] });
    expect(voices.list()).toEqual([replaced.voice]);
    for (const bad of ['a', 'UPPER', '../plain', 'a'.repeat(13), null]) expect(put('ja', bad, 'Invalid.')).toMatchObject({ code: 'voice_failed' });
    expect(voices.reference(id, 'ja-JP', 'gentle')).toEqual({ path: path.join(dir, `${id}.ja.gentle.wav`), text: 'Japanese gentle again.', language: 'ja' });
    expect(voices.reference(id, 'de', 'gentle')).toEqual({ path: path.join(dir, `${id}.en.gentle.wav`), text: 'English gentle.', language: 'en-US' });
    expect(voices.removeTake(id, 'en', 'gentle')).toBe(true);
    expect(voices.reference(id, 'de', 'gentle').text).toBe('French gentle.');
    expect(voices.removeTake(id, 'fr', 'gentle')).toBe(true);
    expect(voices.list()[0].tones.map((one) => one.tone)).toEqual(['gentle', 'bright']);
    expect(voices.reference(id, 'en', 'gentle').text).toBe('Japanese gentle again.');
    expect(voices.removeTake(id, 'ja', 'gentle')).toBe(true);
    expect(fs.existsSync(path.join(dir, `${id}.ja.gentle.wav`))).toBe(false);
    expect(voices.reference(id, 'ja', 'gentle').text).toBe('Japanese plain.');
    expect(voices.reference(id, 'fr', 'gentle').text).toBe('First.');
    expect(voices.list()[0].tones).toEqual([{ tone: 'bright', languages: ['ja'] }]);
  });

  it('reads a list and packs from before recordings had tones', () => {
    const first = { language: 'en', text: 'First.' };
    const take = { language: 'fr', text: 'Bonjour.' };
    const sound = wav(1);
    fs.writeFileSync(path.join(dir, 'abc000.wav'), sound);
    fs.writeFileSync(path.join(dir, 'abc000.fr.wav'), sound);
    fs.writeFileSync(path.join(dir, 'voices.json'), JSON.stringify([{ id: 'abc000', ...first, more: [take] }]));
    const voices = library();
    expect(voices.list()[0]).toMatchObject({ languages: ['en', 'fr'], tones: [] });
    expect(voices.reference('abc000', 'fr', 'gentle').text).toBe('Bonjour.');
    const wav64 = sound.toString('base64');
    const pack = { format: PACK_FORMAT, ...first, wav: wav64 };
    expect(voices.unpack(Buffer.from(JSON.stringify({ ...pack, version: 1 }))).voice).toMatchObject({ languages: ['en'], tones: [] });
    const imported = voices.unpack(Buffer.from(JSON.stringify({ ...pack, version: 2, more: [{ ...take, wav: wav64 }] })));
    expect(imported.voice).toMatchObject({ languages: ['en', 'fr'], tones: [] });
    expect(voices.reference(imported.voice.id, 'fr').text).toBe('Bonjour.');
  });

  it('appends up to four seconds of laughter to the plain take only when speaking on from its words', () => {
    const voices = library();
    const { id } = voices.add({ language: 'en', text: 'First.', wav: wav(1) }).voice;
    const put = (language, tone, text, sound) => voices.add({ to: id, language, tone, text, wav: sound });
    const base = wav(2);
    const laugh = wav(5);
    laugh.fill(9, 44);
    put('ja-JP', '', 'Plain.', base);
    put('fr', 'laugh', 'French.', wav(1));
    put('en', 'laugh', 'English.', wav(2));
    put('ja', 'laugh', 'Ha ha.', laugh);
    try {
      const joined = voices.reference(id, 'ja', 'laugh');
      expect(joined).toMatchObject({ text: 'Plain. Ha ha.', language: 'ja-JP' });
      expect(path.dirname(joined.path)).not.toBe(dir);
      const bytes = fs.readFileSync(joined.path);
      expect(wavInfo(bytes)).toMatchObject({ seconds: 6.25, sampleRate: 24000, channels: 1 });
      const pcm = Buffer.concat([base.subarray(44), Buffer.alloc(12000), laugh.subarray(44, 44 + 192000)]);
      expect(bytes.readUInt32LE(4)).toBe(bytes.length - 8);
      expect(wavInfo(bytes).dataBytes).toBe(pcm.length);
      expect(bytes.subarray(44).equals(pcm)).toBe(true);
      expect(path.basename(joined.path, '.wav')).toBe(crypto.createHash('sha256').update(bytes).digest('hex'));
      expect(voices.reference(id, 'ja', 'laugh')).toEqual(joined);
      expect(voices.reference(id, 'fr', 'laugh')).toEqual(voices.reference(id, 'fr'));
      expect(JSON.parse(voices.pack(id)).more).toHaveLength(4);
      expect(voices.list()[0].tones).toEqual([{ tone: 'laugh', languages: ['fr', 'en', 'ja'] }]);

      put('ja', 'laugh', '', wav(2));
      const reread = voices.reference(id, 'ja', 'laugh');
      expect(reread.path).not.toBe(joined.path);
      expect(reread.text).toBe('Plain.');
      put('ja', '', 'Again.', wav(3));
      expect(voices.reference(id, 'ja', 'laugh').path).not.toBe(reread.path);
      // A laugh in another language is not read on in this one: its words would be.
      voices.removeTake(id, 'ja', 'laugh');
      expect(voices.reference(id, 'ja', 'laugh')).toEqual(voices.reference(id, 'ja'));
      expect(voices.reference(id, 'en', 'laugh').text).toBe('First. English.');
      put('ja', '', '', wav(3));
      expect(voices.reference(id, 'ja', 'laugh')).toEqual(voices.reference(id, 'ja'));
      put('ja', '', 'Other format.', wav(3, { channels: 2 }));
      expect(voices.reference(id, 'ja', 'laugh')).toEqual(voices.reference(id, 'ja'));
      voices.removeTake(id, 'ja');
      expect(voices.reference(id, 'ja', 'laugh')).toEqual(voices.reference(id, 'en'));
      voices.remove(id);
      expect(voices.reference(id, 'ja', 'laugh')).toBeNull();
    } finally {
      voices.clearJoined();
    }
  });

  it('warms distinct plain prompts before recorded tones, in tone order up to the available slots', () => {
    const voices = library();
    const { id: a } = voices.add({ language: 'en', text: 'First.', wav: wav(1) }).voice;
    const { id: b } = voices.add({ language: 'ja', text: 'Second.', wav: wav(1) }).voice;
    for (const id of [a, b]) {
      for (const tone of [...TONES].reverse()) {
        voices.add({ to: id, language: id === a ? 'en' : 'ja', tone, text: tone, wav: wav(2) });
      }
    }
    const reads = [[a, 'fr'], [a, 'de'], [b, 'ja'], [a, 'en']].map(([voice, language]) => ({ voice, language }));
    try {
      const plan = (slots) => voices.warmReads(reads, TONES, slots).map((r) => [r.voice, r.language, r.tone]);
      const expected = [[a, 'fr', ''], [b, 'ja', ''], [a, 'en', ''], [a, 'fr', 'lively'],
        [b, 'ja', 'lively'], [a, 'en', 'lively'], [b, 'ja', 'laugh'], [a, 'en', 'laugh']];
      expect(plan(8)).toEqual(expected);
      expect(plan(4)).toEqual(expected.slice(0, 4));
    } finally {
      voices.clearJoined();
    }
  });

  it('removes and packs every recording and counts all tones towards the limit', () => {
    const voices = library();
    voices.add({ name: '我', text: '你好。', language: 'zh', wav: wav(5) });
    voices.add({ to: 'abc001', text: 'こんにちは。', language: 'ja', wav: wav(4) });
    voices.add({ to: 'abc001', text: 'Hello.', language: 'en', wav: wav(3) });
    voices.add({ to: 'abc001', text: '好耶！', language: 'zh', tone: 'lively', wav: wav(2) });
    const packed = voices.pack('abc001');
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-voices-friend-'));
    try {
      const there = createVoiceLibrary({ dir: elsewhere, now: () => 5, newId: () => 'fff002' });
      expect(there.unpack(packed)).toMatchObject({ ok: true, voice: { id: 'fff002', name: '我', languages: ['zh', 'ja', 'en'] } });
      expect(there.reference('fff002', 'ja')).toEqual({ path: path.join(elsewhere, 'fff002.ja.wav'), text: 'こんにちは。', language: 'ja' });
      expect(there.list()[0].tones).toEqual([{ tone: 'lively', languages: ['zh'] }]);
      const lively = there.reference('fff002', 'ja', 'lively');
      expect(lively).toEqual({ path: path.join(elsewhere, 'fff002.zh.lively.wav'), text: '好耶！', language: 'zh' });
      expect(fs.readFileSync(lively.path).equals(wav(2))).toBe(true);
      // A recording more that is no recording is left out; the voice is still one.
      const spoiled = JSON.parse(packed.toString('utf8'));
      spoiled.more[0].wav = Buffer.from('words').toString('base64');
      const again = createVoiceLibrary({ dir: elsewhere, now: () => 6, newId: () => 'fff003' });
      expect(again.unpack(Buffer.from(JSON.stringify(spoiled))).voice.languages).toEqual(['zh', 'en']);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
    for (const code of ['ko', 'de', 'fr', 'ru', 'pt', 'es', 'it']) expect(voices.add({ to: 'abc001', language: code, wav: wav(3) }).ok).toBe(true);
    expect(MOST_TAKES).toBe(24);
    const sound = wav(1);
    for (const tone of ['gentle', 'serious']) {
      for (const language of ['ko', 'de', 'fr', 'ru', 'pt', 'es']) expect(voices.add({ to: 'abc001', language, tone, wav: sound }).ok).toBe(true);
    }
    expect(voices.add({ to: 'abc001', language: 'ja', tone: 'gentle', wav: sound }).ok).toBe(true);
    expect(voices.add({ to: 'abc001', language: 'vi', wav: wav(3) })).toMatchObject({ code: 'voice_too_many' });
    expect(voices.add({ to: 'abc001', language: 'ja', tone: 'gentle', wav: sound }).ok).toBe(true);
    expect(voices.remove('abc001')).toBe(true);
    expect(fs.readdirSync(dir).filter((name) => name.endsWith('.wav'))).toEqual([]);
  });

  it('forgets a voice whose recording is gone, and reads an unreadable list as none', () => {
    const voices = library();
    voices.add({ name: 'a', wav: wav(3) });
    fs.rmSync(path.join(dir, 'abc001.wav'));
    expect(voices.list()).toEqual([]);
    fs.writeFileSync(path.join(dir, 'voices.json'), '{ not json');
    expect(voices.list()).toEqual([]);
    // An id that is no id of the library's names no file, wherever it points.
    fs.writeFileSync(path.join(dir, 'voices.json'), JSON.stringify([{ id: '../../secret', name: 'x' }]));
    expect(voices.list()).toEqual([]);
    expect(voices.reference('../../secret')).toBeNull();
  });

  it('travels as one file: packed here, added there with what it was', () => {
    const here = library();
    here.add({ name: '我的声音', text: '今天天气真不错。', language: 'zh-CN', wav: wav(5) });
    const packed = here.pack('abc001');
    expect(JSON.parse(packed.toString('utf8'))).toMatchObject({ format: PACK_FORMAT, version: 3, name: '我的声音' });
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-voices-friend-'));
    try {
      const there = createVoiceLibrary({ dir: elsewhere, now: () => 5, newId: () => 'fff001' });
      expect(there.unpack(packed)).toEqual({ ok: true, voice: { id: 'fff001', name: '我的声音', text: '今天天气真不错。', language: 'zh-CN', seconds: 5, createdAt: 5, languages: ['zh'], tones: [] } });
      expect(fs.readFileSync(path.join(elsewhere, 'fff001.wav')).equals(wav(5))).toBe(true);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
    expect(here.pack('nobody')).toBeNull();
    expect(here.unpack(Buffer.from('{"format":"something else"}'))).toMatchObject({ code: 'voice_unreadable' });
    expect(here.unpack(Buffer.from('not json'))).toMatchObject({ code: 'voice_unreadable' });
    // What is inside must still be a recording.
    expect(here.unpack(Buffer.from(JSON.stringify({ format: PACK_FORMAT, wav: Buffer.from('words').toString('base64') })))).toMatchObject({ code: 'voice_unreadable' });
  });
});
