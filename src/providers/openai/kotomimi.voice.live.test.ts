// @vitest-environment node
/**
 * Fork: the voice of a live Kotomimi sharing its models — this provider's own check, stage and request on one side,
 * the other app's door and voice engine on the other, nothing faked. Skipped unless told where that Kotomimi is:
 *
 *   KOTOMIMI_LIVE=192.168.1.20:8790 npx vitest run src/providers/openai/kotomimi.voice.live.test.ts
 *
 * - The other Kotomimi needs a voice model downloaded that speaks `KOTOMIMI_LIVE_TARGET` (default `ja`), and, for the
 *   typed sentence, a translator from `KOTOMIMI_LIVE_SOURCE` (default `en`) into it.
 * - `KOTOMIMI_LIVE_VOICE`: one of its voice models by name, in place of the first it lends.
 * - `KOTOMIMI_LIVE_KEY`: its access key, when it has one.
 * - `KOTOMIMI_LIVE_WAV_OUT`: a file the sentence's sound is written to (24 kHz mono), to be listened to.
 */
import './nodeWindow';
import { writeFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { SAMPLE_RATE, type SessionContext } from '../../lib/contract/adapter';
import { realClock } from '../../lib/contract/clock';
import { recordEvents } from '../../lib/contract/events';
import type { SharedSettings } from '../../lib/provider/types';
import { LOCALAI_DEFAULTS, localaiProvider, type LocalAICredentials, type LocalAISettings } from './localai';
import { isKotomimiServer, type LocalAIModel } from './localaiModels';
import { lentVoices, serverVoiceModel, voiceStageOf } from './localaiVoice';
import { httpBaseOf } from './textModel';
import { atServer, speakText } from './voice';

const SERVER = process.env.KOTOMIMI_LIVE ?? '';
const SOURCE = process.env.KOTOMIMI_LIVE_SOURCE ?? 'en';
const TARGET = process.env.KOTOMIMI_LIVE_TARGET ?? 'ja';
const KEY = process.env.KOTOMIMI_LIVE_KEY ?? '';
const VOICE = process.env.KOTOMIMI_LIVE_VOICE ?? '';
const WAV_OUT = process.env.KOTOMIMI_LIVE_WAV_OUT ?? '';
const SENTENCES: Readonly<Record<string, string>> = { ja: 'こんにちは。今日はいい天気ですね。', zh: '你好，今天天气真不错。', en: 'Hello. The weather is lovely today.' };
const noAuth = { signedIn: false, getToken: async () => null };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const settings: LocalAISettings = { ...LOCALAI_DEFAULTS, model: '', serverNeedsKey: KEY !== '', speak: { ...LOCALAI_DEFAULTS.speak, on: true, at: 'server', serverModel: VOICE } };
const credentials = (): LocalAICredentials => {
  const read = localaiProvider.credentials.read({ endpoint: SERVER, ...(KEY ? { serverKey: KEY } : {}) }, noAuth) as LocalAICredentials;
  expect(read).not.toHaveProperty('missing');
  return read;
};
const context: SessionContext = { leg: 'speaker', direction: { source: SOURCE, target: TARGET }, speech: true, turns: 'auto' };

/** 24 kHz mono samples as a WAV file's bytes. */
function wav(pcm: Int16Array): Buffer {
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + pcm.byteLength, 4); head.write('WAVEfmt ', 8); head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(SAMPLE_RATE, 24); head.writeUInt32LE(SAMPLE_RATE * 2, 28);
  head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write('data', 36); head.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([head, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)]);
}

describe.skipIf(!SERVER)('another Kotomimi’s voice, live', () => {
  it('is among what it lends, and speaks a sentence as it is made', async () => {
    const k = credentials();
    const ready = await localaiProvider.check(k, settings, { pair: context.direction, legs: ['speaker'] });
    if (!ready.ok) throw new Error(ready.reason);
    const models = (ready.models ?? []) as LocalAIModel[];
    expect(isKotomimiServer(models)).toBe(true);
    console.log('voices lent:', lentVoices(models).map((m) => `${m.id}[${(m.languages ?? []).join(',')}]`).join(', '));
    const stage = voiceStageOf(settings.speak, [TARGET], models);
    expect(stage).toMatchObject({ server: true, streams: true, model: serverVoiceModel(settings.speak, models) });
    const pieces: Array<{ at: number; samples: number }> = [];
    const heard: Int16Array[] = [];
    const began = Date.now();
    const spoken = await speakText(
      atServer(stage!, httpBaseOf(k.endpoint)), { text: SENTENCES[TARGET.split('-')[0]] ?? SENTENCES.en, language: TARGET }, k.apiKey || undefined,
      { fetch: (input, init) => fetch(input, init), clock: realClock, decode: async () => { throw new Error('a file came where raw sound was asked for'); }, native: async () => { throw new Error('not this computer'); }, edge: async () => { throw new Error('not Edge'); } },
      new AbortController().signal,
      (pcm) => { pieces.push({ at: Date.now() - began, samples: pcm.length }); heard.push(pcm); },
    );
    const seconds = spoken.samples / SAMPLE_RATE;
    const whole = new Int16Array(spoken.samples);
    let at = 0;
    for (const piece of heard) { whole.set(piece, at); at += piece.length; }
    const loud = Math.sqrt(whole.reduce((sum, sample) => sum + sample * sample, 0) / Math.max(1, whole.length));
    console.log(`spoken by ${stage!.model}: first sound ${spoken.firstMs} ms, whole ${spoken.totalMs} ms for ${seconds.toFixed(2)} s of sound in ${pieces.length} pieces, RMS ${Math.round(loud)}`);
    if (WAV_OUT) writeFileSync(WAV_OUT, wav(whole));
    // A sentence of a couple of seconds, and not silence.
    expect(seconds).toBeGreaterThan(1);
    expect(seconds).toBeLessThan(20);
    expect(loud).toBeGreaterThan(200);
  }, 180_000);

  it('speaks the translation of a typed sentence, on a leg whose voice is there', async () => {
    const k = credentials();
    const ready = await localaiProvider.check(k, settings, { pair: context.direction, legs: ['speaker'] });
    if (!ready.ok) throw new Error(ready.reason);
    const models = (ready.models ?? []) as LocalAIModel[];
    const shared: SharedSettings = { pauses: { sourceSeconds: 1.5, translationSeconds: 1.5 }, reversed: () => false, segmentation: { mode: 'off', sentencesPerRow: 0 }, models };
    const config = localaiProvider.build(context, settings, shared);
    if ('refused' in config) throw new Error(config.refused);
    const { events, log } = recordEvents();
    const session = await localaiProvider.start({ context, config, credentials: k, clock: realClock, signal: new AbortController().signal }, events);
    session.appendText('Good morning, how are you today?');
    const sound = () => log.filter((e) => e.kind === 'audio');
    const frames = (type: string) => log.filter((e) => e.kind === 'frame' && e.payload.type === type);
    const end = Date.now() + 120_000;
    while (frames('voice.done').length + frames('voice.failed').length === 0 && Date.now() < end) await sleep(100);
    await session.stop();
    const translation = log.filter((e) => e.kind === 'segmentText').pop();
    console.log('typed:', JSON.stringify(translation?.kind === 'segmentText' ? translation.payload.text : null), 'voice:', JSON.stringify(frames('voice.done').map((e) => (e.kind === 'frame' ? e.payload.payload : null))));
    expect(log.filter((e) => e.kind === 'failed' || e.kind === 'degraded')).toEqual([]);
    expect(frames('voice.done')).toHaveLength(1);
    expect(sound().length).toBeGreaterThan(0);
  }, 180_000);
});
