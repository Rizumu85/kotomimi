// @vitest-environment node
/**
 * Fork: the recordings other devices hand this computer to speak from (`lent-voices.js`): what one must be, the name
 * it goes by, how few are kept and for how long.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createLentVoices, MOST_WAV_BYTES } = require('./lent-voices.js');

/** A 16-bit mono WAV of `seconds` at 24 kHz, with `mark` in it so that two are not the same. */
function wav(seconds, mark = 1) {
  const data = Buffer.alloc(Math.round(seconds * 24000) * 2);
  for (let i = 0; i < data.length / 2; i += 97) data.writeInt16LE((i * mark) % 3000, i * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVEfmt ', 8); head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(24000, 24); head.writeUInt32LE(48000, 28);
  head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write('data', 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}
const b64 = (bytes) => bytes.toString('base64');

let dir;
beforeEach(() => { dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kt-lent-')), 'voices'); });
afterEach(() => { fs.rmSync(path.dirname(dir), { recursive: true, force: true }); });

describe('a recording a device hands over', () => {
  it('is kept under the name of what it is, with its words and their language, and found again by that name', () => {
    const lent = createLentVoices({ dir });
    const bytes = wav(6);
    const kept = lent.keep({ wav: b64(bytes), text: '  今天天气真不错。 ', language: 'zh-CN' });
    // The name is worked out here, never taken from the device.
    expect(kept).toEqual({ ok: true, id: crypto.createHash('sha256').update(bytes).digest('hex') });
    expect(lent.get(kept.id)).toEqual({ path: path.join(dir, `${kept.id}.wav`), text: '今天天气真不错。', language: 'zh-CN' });
    expect(fs.readFileSync(path.join(dir, `${kept.id}.wav`)).equals(bytes)).toBe(true);
    // Handed over again, it is the same one.
    expect(lent.keep({ wav: b64(bytes), text: '', language: '' })).toEqual({ ok: true, id: kept.id });
    expect(lent.count()).toBe(1);
  });

  it('is nothing else: no recording, one cut short, one too large, a name that is no name', () => {
    const lent = createLentVoices({ dir });
    expect(lent.keep({ wav: b64(Buffer.from('only words, no sound at all in here')), text: 'x' })).toMatchObject({ code: 'voice_ref_unreadable' });
    expect(lent.keep({ wav: b64(wav(6).subarray(0, 44 + 4000)) })).toMatchObject({ code: 'voice_ref_unreadable' });
    expect(lent.keep({ wav: 'A'.repeat(Math.ceil(MOST_WAV_BYTES / 3) * 4 + 100) })).toMatchObject({ code: 'voice_ref_unreadable' });
    expect(lent.keep({ wav: 42 })).toMatchObject({ code: 'voice_ref_unreadable' });
    // Words that are no words are none, and leave no file behind unlisted.
    expect(lent.keep({ wav: b64(wav(4, 9)), text: { toString: 1 }, language: ['zh'] })).toMatchObject({ ok: true });
    expect(lent.count()).toBe(1);
    expect(fs.readdirSync(dir)).toHaveLength(1);
    lent.clear();
    expect(lent.keep()).toMatchObject({ code: 'voice_ref_unreadable' });
    expect(lent.count()).toBe(0);
    expect(lent.get('../../secret')).toBeNull();
    expect(lent.get('f'.repeat(64))).toBeNull();
  });

  it('is one of the few most lately used: the oldest goes, with its file', () => {
    const lent = createLentVoices({ dir, most: 2 });
    const first = lent.keep({ wav: b64(wav(3, 1)) }).id;
    const second = lent.keep({ wav: b64(wav(3, 2)) }).id;
    // Used: no longer the oldest.
    expect(lent.get(first)).not.toBeNull();
    const third = lent.keep({ wav: b64(wav(3, 3)) }).id;
    expect(lent.get(second)).toBeNull();
    expect(fs.existsSync(path.join(dir, `${second}.wav`))).toBe(false);
    expect(lent.get(first)).not.toBeNull();
    expect(lent.get(third)).not.toBeNull();
  });

  it('accepts the longest joined recording with both transcripts', () => {
    const lent = createLentVoices({ dir });
    const text = `${'a'.repeat(400)} ${'b'.repeat(400)}`;
    const kept = lent.keep({ wav: b64(wav(34.25)), text, language: 'en' });
    expect(lent.get(kept.id)).toMatchObject({ text, language: 'en' });
    expect(lent.keep({ wav: b64(wav(34.26)) })).toMatchObject({ code: 'voice_ref_unreadable' });
  });

  it('takes the largest recording a library can hold: a 48 kHz stereo one with a laugh joined after it', () => {
    const lent = createLentVoices({ dir });
    const frames = Math.round(34.25 * 48000);
    const data = Buffer.alloc(frames * 4, 1);
    const head = Buffer.alloc(44);
    head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVEfmt ', 8); head.writeUInt32LE(16, 16);
    head.writeUInt16LE(1, 20); head.writeUInt16LE(2, 22); head.writeUInt32LE(48000, 24); head.writeUInt32LE(192000, 28);
    head.writeUInt16LE(4, 32); head.writeUInt16LE(16, 34); head.write('data', 36); head.writeUInt32LE(data.length, 40);
    expect(frames * 4).toBeGreaterThan(6 * 1024 * 1024);
    expect(lent.keep({ wav: b64(Buffer.concat([head, data])), text: 'Hello.', language: 'en' })).toMatchObject({ ok: true });
  });

  it('is gone when sharing stops: nothing of another device is left', () => {
    const lent = createLentVoices({ dir });
    const { id } = lent.keep({ wav: b64(wav(4)) });
    lent.clear();
    expect(lent.get(id)).toBeNull();
    expect(fs.existsSync(dir)).toBe(false);
    // And it can be handed over again afterwards.
    expect(lent.keep({ wav: b64(wav(4)) })).toEqual({ ok: true, id });
  });
});
