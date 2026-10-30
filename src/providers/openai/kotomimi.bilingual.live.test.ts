// @vitest-environment node
/**
 * Real two-device acceptance. No network calls without KOTOMIMI_BILINGUAL_LIVE.
 * The host needs paired Apple Speech assets for both languages, a translator,
 * and a feedback model. WAV inputs must be 24 kHz, mono, PCM16.
 * See docs/apple-speech-lan.md for environment variables and scope.
 */
import './nodeWindow';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SessionContext } from '../../lib/contract/adapter';
import { realClock } from '../../lib/contract/clock';
import { recordEvents, type AdapterEvent } from '../../lib/contract/events';
import type { SharedSettings } from '../../lib/provider/types';
import { LOCALAI_DEFAULTS, localaiProvider, type LocalAICredentials } from './localai';
import type { LocalAIModel } from './localaiModels';

const SERVER = process.env.KOTOMIMI_BILINGUAL_LIVE ?? '';
const NATIVE_WAV = process.env.KOTOMIMI_NATIVE_WAV ?? '';
const PRACTICE_WAV = process.env.KOTOMIMI_PRACTICE_WAV ?? '';
const NATIVE_LANGUAGE = process.env.KOTOMIMI_NATIVE_LANGUAGE ?? 'zh-CN';
const PRACTICE_LANGUAGE = process.env.KOTOMIMI_PRACTICE_LANGUAGE ?? 'en';
const KEY = process.env.KOTOMIMI_LIVE_KEY ?? '';
const base = (language: string) => language.split('-')[0];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function pcmFromWav(file: string): Int16Array {
  const wav = readFileSync(file);
  expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
  expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
  let pcm: Buffer | undefined;
  let validFormat = false;
  for (let at = 12; at + 8 <= wav.length;) {
    const size = wav.readUInt32LE(at + 4);
    const start = at + 8;
    expect(start + size).toBeLessThanOrEqual(wav.length);
    if (wav.toString('ascii', at, at + 4) === 'fmt ') {
      expect(size).toBeGreaterThanOrEqual(16);
      expect(wav.readUInt16LE(start)).toBe(1);
      expect(wav.readUInt16LE(start + 2)).toBe(1);
      expect(wav.readUInt32LE(start + 4)).toBe(24_000);
      expect(wav.readUInt16LE(start + 14)).toBe(16);
      validFormat = true;
    }
    if (wav.toString('ascii', at, at + 4) === 'data') pcm = wav.subarray(start, start + size);
    at = start + size + (size % 2);
  }
  expect(validFormat).toBe(true);
  expect(pcm?.length).toBeGreaterThan(0);
  expect(pcm!.length % 2).toBe(0);
  return new Int16Array(pcm!.buffer.slice(pcm!.byteOffset, pcm!.byteOffset + pcm!.length));
}

async function connect(participant = false) {
  const settings = {
    ...LOCALAI_DEFAULTS, model: '', serverNeedsKey: KEY !== '',
    asrModel: `apple-speech:${base(NATIVE_LANGUAGE)}`, speakBoth: true, coach: true,
    translateServerModel: process.env.KOTOMIMI_TRANSLATOR ?? 'index-translate-2b',
    coachServerModel: process.env.KOTOMIMI_COACH ?? 'gemma-4-e2b',
    translateBySentence: false,
  };
  const credentials = localaiProvider.credentials.read({ endpoint: SERVER, ...(KEY ? { serverKey: KEY } : {}) }, { signedIn: false, getToken: async () => null }) as LocalAICredentials;
  expect(credentials).not.toHaveProperty('missing');
  const pair = { source: NATIVE_LANGUAGE, target: PRACTICE_LANGUAGE };
  const readiness = await localaiProvider.check(credentials, settings, { pair, legs: ['speaker', 'participant'] });
  if (!readiness.ok) throw new Error(readiness.reason);
  const models = (readiness.models ?? []) as LocalAIModel[];
  for (const language of [NATIVE_LANGUAGE, PRACTICE_LANGUAGE]) {
    expect(models.find((model) => model.id === `apple-speech:${base(language)}`)?.bilingual).toBe(true);
  }
  const context: SessionContext = { direction: participant ? { source: pair.target, target: pair.source } : pair, speech: false, turns: 'manual' };
  const shared: SharedSettings = {
    pauses: { sourceSeconds: 1.5, translationSeconds: 1.5 }, reversed: () => participant,
    segmentation: { mode: 'off', sentencesPerRow: 0 }, models,
  };
  const config = localaiProvider.build(context, settings, shared);
  if ('refused' in config) throw new Error(config.refused);
  const { events, log } = recordEvents();
  const controller = new AbortController();
  const session = await localaiProvider.start({ context, config, credentials, clock: realClock, signal: controller.signal }, events);
  const of = <K extends AdapterEvent['kind']>(kind: K) => log.filter((event): event is Extract<AdapterEvent, { kind: K }> => event.kind === kind);
  const segments = () => of('segmentOpened').map(({ payload }) => {
    const text = of('segmentText').filter((event) => event.payload.ref === payload.ref).pop()?.payload;
    return { ...payload, text: text?.text ?? '', language: text?.language, closed: of('segmentClosed').some((event) => event.payload.ref === payload.ref) };
  });
  const until = async (done: () => boolean) => {
    const deadline = Date.now() + 90_000;
    while (!done() && Date.now() < deadline && !of('failed').length) await sleep(100);
    expect(of('failed')).toEqual([]);
    expect(of('degraded')).toEqual([]);
    expect(done(), JSON.stringify(segments())).toBe(true);
  };
  const say = async (file: string) => {
    const pcm = pcmFromWav(file);
    session.beginTurn();
    for (const chunk of [new Int16Array(7_200), ...Array.from({ length: Math.ceil(pcm.length / 2_400) }, (_, i) => pcm.subarray(i * 2_400, (i + 1) * 2_400)), new Int16Array(7_200)]) {
      session.appendAudio(chunk);
      await sleep(chunk.length / 24);
    }
    session.endTurn();
  };
  const stop = async () => { controller.abort(); await session.stop(); };
  return { session, of, segments, until, say, stop };
}

describe.skipIf(!SERVER || !NATIVE_WAV || !PRACTICE_WAV)('paired Apple Speech on another computer, live', () => {
  it('keeps a translation and private feedback for practice speech, then translates native speech and typed text without feedback', async () => {
    const h = await connect();
    try {
      await h.say(PRACTICE_WAV);
      await h.until(() => h.segments().some((segment) => segment.purpose === 'feedback' && segment.closed && segment.text !== ''));
      const feedback = h.segments().find((segment) => segment.purpose === 'feedback')!;
      await h.until(() => h.segments().some((segment) => segment.origin === feedback.origin && segment.purpose === 'translation' && segment.closed && segment.text !== ''));
      const source = h.segments().find((segment) => segment.origin === feedback.origin && segment.side === 'source')!;
      expect(base(source.language ?? '')).toBe(base(PRACTICE_LANGUAGE));
      expect(feedback.accompaniesTranslation).toBe(true);
      const answers = h.segments().filter((segment) => segment.origin === feedback.origin && segment.side === 'translation');
      expect(new Set(answers.map((segment) => segment.ref)).size).toBe(2);
      const feedbackCount = h.segments().filter((segment) => segment.purpose === 'feedback').length;
      const previous = new Set(h.segments().map((segment) => segment.ref));
      await h.say(NATIVE_WAV);
      await h.until(() => h.segments().some((segment) => !previous.has(segment.ref) && segment.purpose === 'translation' && segment.closed && segment.text !== ''));
      const nativeSource = h.segments().find((segment) => !previous.has(segment.ref) && segment.side === 'source')!;
      expect(base(nativeSource.language ?? '')).toBe(base(NATIVE_LANGUAGE));
      expect(h.segments().filter((segment) => segment.purpose === 'feedback')).toHaveLength(feedbackCount);
      const beforeTyped = new Set(h.segments().map((segment) => segment.ref));
      h.session.appendText(process.env.KOTOMIMI_TYPED_TEXT ?? 'Good morning, how are you today?');
      await h.until(() => h.segments().some((segment) => !beforeTyped.has(segment.ref) && segment.side === 'translation' && segment.closed && segment.text !== ''));
      expect(h.segments().filter((segment) => segment.purpose === 'feedback')).toHaveLength(feedbackCount);
    } finally {
      console.log('bilingual speaker results:', JSON.stringify(h.segments()));
      await h.stop();
    }
  }, 240_000);

  it('keeps simultaneous speaker and participant languages separate, and shows native participant speech without translation', async () => {
    const speaker = await connect();
    let participant: Awaited<ReturnType<typeof connect>> | undefined;
    try {
      participant = await connect(true);
      const other = participant;
      await Promise.all([speaker.say(PRACTICE_WAV), other.say(NATIVE_WAV)]);
      await Promise.all([
        speaker.until(() => speaker.segments().some((segment) => segment.purpose === 'feedback' && segment.closed && segment.text !== '')),
        other.until(() => other.segments().some((segment) => segment.side === 'source' && segment.closed && segment.text !== '')),
      ]);
      expect(base(other.segments().find((segment) => segment.side === 'source')?.language ?? '')).toBe(base(NATIVE_LANGUAGE));
      expect(other.segments().filter((segment) => segment.side === 'translation' && segment.text !== '')).toEqual([]);
      const previous = new Set(other.segments().map((segment) => segment.ref));
      await other.say(PRACTICE_WAV);
      await other.until(() => other.segments().some((segment) => !previous.has(segment.ref) && segment.side === 'translation' && segment.closed && segment.text !== ''));
      expect(base(other.segments().find((segment) => !previous.has(segment.ref) && segment.side === 'source')?.language ?? '')).toBe(base(PRACTICE_LANGUAGE));
      expect(other.segments().filter((segment) => segment.purpose === 'feedback')).toEqual([]);
    } finally {
      console.log('simultaneous source results:', JSON.stringify({ speaker: speaker.segments(), participant: participant?.segments() }));
      await Promise.all([speaker.stop(), participant?.stop()]);
    }
  }, 240_000);
});
