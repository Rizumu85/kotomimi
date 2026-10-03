// @vitest-environment node
/**
 * Fork: this provider against a live Kotomimi sharing its models — the
 * provider's own check, builder and adapter on one side, the other app's
 * server and models on the other, nothing faked. Skipped unless told where
 * that Kotomimi is:
 *
 *   KOTOMIMI_LIVE=192.168.1.20:8790 KOTOMIMI_LIVE_WAV=speech.wav npx vitest run src/providers/openai/kotomimi.live.test.ts
 *
 * - `KOTOMIMI_LIVE_WAV`: a 24 kHz mono PCM16 WAV of a few seconds of speech
 *   in `KOTOMIMI_LIVE_SOURCE` (default `en`), translated into
 *   `KOTOMIMI_LIVE_TARGET` (default `zh-CN`). The other Kotomimi needs a
 *   recognizer downloaded for the source. Without the WAV only the lists and
 *   the typed text run.
 * - `KOTOMIMI_LIVE_KEY`: its access key, when it has one.
 * - `KOTOMIMI_LIVE_ASR`: one of its recognizers by name, in place of its own pick.
 */
import './nodeWindow';
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import type { AdapterSession, SessionContext } from '../../lib/contract/adapter';
import { realClock } from '../../lib/contract/clock';
import { recordEvents, type AdapterEvent } from '../../lib/contract/events';
import { LAN_PIPELINE } from '../../lib/lan/protocol';
import type { SharedSettings } from '../../lib/provider/types';
import { LOCALAI_DEFAULTS, localaiProvider, type LocalAICredentials, type LocalAISettings } from './localai';
import { isKotomimiServer, type LocalAIModel } from './localaiModels';

const SERVER = process.env.KOTOMIMI_LIVE ?? '';
const WAV = process.env.KOTOMIMI_LIVE_WAV ?? '';
const SOURCE = process.env.KOTOMIMI_LIVE_SOURCE ?? 'en';
const TARGET = process.env.KOTOMIMI_LIVE_TARGET ?? 'zh-CN';
const KEY = process.env.KOTOMIMI_LIVE_KEY ?? '';
const ASR = process.env.KOTOMIMI_LIVE_ASR ?? '';
const noAuth = { signedIn: false, getToken: async () => null };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A WAV's samples, with half a second of silence before and `tailMs` after, in 100 ms chunks. */
function chunks(file: string, tailMs: number): Int16Array[] {
  const wav = readFileSync(file);
  const data = wav.indexOf(Buffer.from('data')) + 8;
  const pcm = new Int16Array(wav.buffer.slice(wav.byteOffset + data, wav.byteOffset + data + ((wav.length - data) & ~1)));
  const CHUNK = 2_400;
  const out: Int16Array[] = [];
  for (let i = 0; i < 5; i += 1) out.push(new Int16Array(CHUNK));
  for (let i = 0; i < pcm.length; i += CHUNK) out.push(pcm.subarray(i, Math.min(i + CHUNK, pcm.length)));
  for (let i = 0; i < tailMs / 100; i += 1) out.push(new Int16Array(CHUNK));
  return out;
}

async function start(turns: SessionContext['turns'] = 'auto', patch: Partial<LocalAISettings> = {}) {
  // The Realtime model left blank: the server's own pipeline is found by the check.
  const settings: LocalAISettings = { ...LOCALAI_DEFAULTS, model: '', serverNeedsKey: KEY !== '', asrModel: ASR, ...patch };
  const credentials = localaiProvider.credentials.read({ endpoint: SERVER, ...(KEY ? { serverKey: KEY } : {}) }, noAuth) as LocalAICredentials;
  expect(credentials).not.toHaveProperty('missing');
  const context: SessionContext = { direction: { source: SOURCE, target: TARGET }, speech: false, turns };
  const ready = await localaiProvider.check(credentials, settings, { pair: context.direction, legs: ['speaker'] });
  if (!ready.ok) throw new Error(ready.reason);
  const models = (ready.models ?? []) as LocalAIModel[];
  const shared: SharedSettings = { pauses: { sourceSeconds: 1.5, translationSeconds: 1.5 }, reversed: () => false, segmentation: { mode: 'off', sentencesPerRow: 0 }, models };
  const config = localaiProvider.build(context, settings, shared);
  if ('refused' in config) throw new Error(config.refused);
  const { events, log } = recordEvents();
  const session: AdapterSession = await localaiProvider.start({ context, config, credentials, clock: realClock, signal: new AbortController().signal }, events);
  const of = <K extends AdapterEvent['kind']>(kind: K) => log.filter((e): e is Extract<AdapterEvent, { kind: K }> => e.kind === kind);
  const segments = () => of('segmentOpened').map((opened) => {
    const last = of('segmentText').filter((t) => t.payload.ref === opened.payload.ref).pop()?.payload;
    return { ...opened.payload, text: last?.text ?? '', closed: of('segmentClosed').some((c) => c.payload.ref === opened.payload.ref) };
  });
  const until = async (done: () => boolean, ms: number) => {
    const end = Date.now() + ms;
    while (!done() && Date.now() < end) await sleep(100);
    return done();
  };
  const frames = () => of('frame').map((f) => `${f.payload.direction === 'in' ? '<<' : '>>'} ${f.payload.type}`);
  const say = async (file: string, tailMs: number) => { for (const chunk of chunks(file, tailMs)) { session.appendAudio(chunk); await sleep(100); } };
  const translated = () => segments().some((s) => s.side === 'translation' && s.closed && s.text !== '');
  const pair = () => {
    const translation = segments().find((s) => s.side === 'translation' && s.text !== '');
    return { translation, source: segments().find((s) => s.side === 'source' && s.origin === translation?.origin) };
  };
  return { session, config, models, of, segments, until, frames, say, translated, pair };
}

describe.skipIf(!SERVER)('another Kotomimi, live', () => {
  it('says what it is, and translates a typed text with its own best model for the pair', async () => {
    const h = await start();
    expect(isKotomimiServer(h.models)).toBe(true);
    expect(h.config.model).toBe(LAN_PIPELINE);
    console.log('models:', h.models.map((m) => `${m.id}(${m.kind})`).join(', '));
    h.session.appendText('Good morning, how are you today?');
    const done = await h.until(h.translated, 60_000);
    await h.session.stop();
    console.log('typed:', JSON.stringify(h.segments()));
    expect(done).toBe(true);
    expect(h.of('failed')).toEqual([]);
    expect(h.of('degraded')).toEqual([]);
    expect(h.pair().source?.text).toBe('Good morning, how are you today?');
    // The socket is asked for no response: the translation went over chat.
    expect(h.frames().filter((f) => f.includes('response.'))).toEqual([]);
  }, 90_000);

  it.skipIf(!WAV)('hears speech with its recognizer and its own turn detection, and translates what it heard', async () => {
    const h = await start();
    await h.say(WAV, 3_000);
    const done = await h.until(h.translated, 60_000);
    await h.session.stop();
    console.log('auto:', JSON.stringify(h.segments()), '\n', h.frames().filter((f) => !f.includes('speech_')).join(' | '));
    expect(done).toBe(true);
    expect(h.of('failed')).toEqual([]);
    expect(h.pair().source?.text).not.toBe('');
    expect(h.segments().filter((s) => !s.closed)).toEqual([]);
  }, 150_000);

  it.skipIf(!WAV)('hears speech under manual turns: the commit ends the turn', async () => {
    const h = await start('manual');
    h.session.beginTurn();
    await h.say(WAV, 300);
    h.session.endTurn();
    const done = await h.until(h.translated, 60_000);
    await h.session.stop();
    console.log('manual:', JSON.stringify(h.segments()));
    expect(done).toBe(true);
    expect(h.pair().source?.text).not.toBe('');
    expect(h.segments().filter((s) => !s.closed)).toEqual([]);
    expect(h.frames().filter((f) => f === '>> input_audio_buffer.commit')).toHaveLength(1);
  }, 150_000);
});
