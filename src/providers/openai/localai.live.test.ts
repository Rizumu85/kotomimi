// @vitest-environment node
/**
 * Fork: LocalAI Realtime against a live server — the provider's own check,
 * builder and adapter, nothing faked. Skipped unless told where the server
 * is, so the ordinary suite never dials out:
 *
 *   LOCALAI_LIVE=192.168.1.10:8080 LOCALAI_LIVE_WAV=speech.wav npx vitest run src/providers/openai/localai.live.test.ts
 *
 * - `LOCALAI_LIVE_WAV`: a 24 kHz mono PCM16 WAV of a few seconds of speech
 *   in `LOCALAI_LIVE_SOURCE` (default `en`), translated into
 *   `LOCALAI_LIVE_TARGET` (default `zh-CN`). Without it only the typed-text
 *   cases run.
 * - `LOCALAI_LIVE_TEXT_MODEL`: a text model the server serves over chat
 *   completions (`hy-mt2-1.8b`); with it, the cases where translation runs
 *   on a text model run too. `LOCALAI_LIVE_TEXT_BASE` names another server
 *   for it (`http://localhost:11434/v1`).
 * - `LOCALAI_LIVE_JA_WAV` and `LOCALAI_LIVE_COACH_MODEL`: Japanese speech
 *   and the model that gives it grammar feedback, for the coached speaker.
 *
 * Run it after a rebase onto upstream, or after changing the server.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import type { AdapterSession, SessionContext } from '../../lib/contract/adapter';
import { realClock } from '../../lib/contract/clock';
import { recordEvents, type AdapterEvent } from '../../lib/contract/events';
import type { SharedSettings } from '../../lib/provider/types';
import { LOCALAI_DEFAULTS, localaiProvider, type LocalAICredentials, type LocalAISettings } from './localai';

const SERVER = process.env.LOCALAI_LIVE ?? '';
const WAV = process.env.LOCALAI_LIVE_WAV ?? '';
const SOURCE = process.env.LOCALAI_LIVE_SOURCE ?? 'en';
const TARGET = process.env.LOCALAI_LIVE_TARGET ?? 'zh-CN';
const TEXT_MODEL = process.env.LOCALAI_LIVE_TEXT_MODEL ?? '';
const TEXT_BASE = process.env.LOCALAI_LIVE_TEXT_BASE ?? '';
const JA_WAV = process.env.LOCALAI_LIVE_JA_WAV ?? '';
const COACH_MODEL = process.env.LOCALAI_LIVE_COACH_MODEL ?? '';
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

interface StartOptions {
  turns?: SessionContext['turns'];
  patch?: Partial<LocalAISettings>;
  direction?: SessionContext['direction'];
  /** The leg is the participant's: the pair's reverse. */
  participant?: boolean;
}

async function start(o: StartOptions = {}) {
  const settings = { ...LOCALAI_DEFAULTS, ...o.patch };
  const credentials = localaiProvider.credentials.read({ endpoint: SERVER }, noAuth) as LocalAICredentials;
  expect(credentials).not.toHaveProperty('missing');
  const context: SessionContext = { direction: o.direction ?? { source: SOURCE, target: TARGET }, speech: false, turns: o.turns ?? 'auto' };
  const ready = await localaiProvider.check(credentials, settings, { pair: context.direction, legs: ['speaker'] });
  if (!ready.ok) throw new Error(ready.reason);
  const shared: SharedSettings = { pauses: { sourceSeconds: 1.5, translationSeconds: 1.5 }, reversed: () => o.participant === true, segmentation: { mode: 'off', sentencesPerRow: 0 }, models: ready.models ?? [] };
  const config = localaiProvider.build(context, settings, shared);
  if ('refused' in config) throw new Error(config.refused);
  const { events, log } = recordEvents();
  const controller = new AbortController();
  const session: AdapterSession = await localaiProvider.start({ context, config, credentials, clock: realClock, signal: controller.signal }, events);
  const of = <K extends AdapterEvent['kind']>(kind: K) => log.filter((e): e is Extract<AdapterEvent, { kind: K }> => e.kind === kind);
  /** Each segment as L1 would fold it: its side, origin, last text and language, and whether it closed. */
  const segments = () => of('segmentOpened').map((opened) => {
    const last = of('segmentText').filter((t) => t.payload.ref === opened.payload.ref).pop()?.payload;
    return { ...opened.payload, text: last?.text ?? '', language: last?.language, closed: of('segmentClosed').some((c) => c.payload.ref === opened.payload.ref) };
  });
  const until = async (done: () => boolean, ms: number) => {
    const end = Date.now() + ms;
    while (!done() && Date.now() < end) await sleep(100);
    return done();
  };
  const frames = () => of('frame').map((f) => `${f.payload.direction === 'in' ? '<<' : '>>'} ${f.payload.type}`);
  /** The text model's own frames, with what they measured. */
  const timings = () => of('frame').filter((f) => f.payload.type === 'text.done').map((f) => f.payload.payload);
  const say = async (file: string, tailMs: number) => { for (const chunk of chunks(file, tailMs)) { session.appendAudio(chunk); await sleep(100); } };
  return { session, config, models: ready.models ?? [], log, of, segments, until, frames, timings, say };
}

type Leg = Awaited<ReturnType<typeof start>>;
const closedTranslation = (h: Leg) => () => h.segments().some((s) => s.side === 'translation' && s.closed && s.text !== '');
/** The first translation with text, and the source it is paired with. */
function pair(h: Leg) {
  const translation = h.segments().find((s) => s.side === 'translation' && s.text !== '');
  return { translation, source: h.segments().find((s) => s.side === 'source' && s.origin === translation?.origin) };
}

describe.skipIf(!SERVER)('LocalAI Realtime, live: the server\'s own pipeline', () => {
  it('lists the server\'s models and translates a typed text', async () => {
    const h = await start();
    expect(h.models.length).toBeGreaterThan(0);
    h.session.appendText('Good morning, how are you today?');
    const done = await h.until(closedTranslation(h), 30_000);
    await h.session.stop();
    console.log('typed:', JSON.stringify(h.segments()), '\n', h.frames().join(' | '));
    expect(done).toBe(true);
    expect(h.of('failed')).toEqual([]);
    const { source, translation } = pair(h);
    expect(source?.text).toBe('Good morning, how are you today?');
    expect(translation?.origin).toBe(source?.origin);
    // The session never anchors, and sent one response.create: the typed text's.
    expect(h.frames().filter((f) => f === '>> response.anchor')).toEqual([]);
    expect(h.frames().filter((f) => f === '>> response.create')).toHaveLength(1);
  }, 60_000);

  it.skipIf(!WAV)('hears speech under automatic turns: a source transcript and its paired translation, with no response asked', async () => {
    const h = await start();
    await h.say(WAV, 2_500);
    const done = await h.until(closedTranslation(h), 30_000);
    await h.session.stop();
    console.log('auto:', JSON.stringify(h.segments()), '\n', h.frames().filter((f) => !f.includes('speech_')).join(' | '));
    expect(done).toBe(true);
    expect(h.of('failed')).toEqual([]);
    expect(pair(h).source?.text).not.toBe('');
    expect(h.frames().filter((f) => f === '>> response.create' || f === '>> response.anchor')).toEqual([]);
  }, 90_000);

  it.skipIf(!WAV)('hears speech under manual turns: the commit alone is answered', async () => {
    const h = await start({ turns: 'manual' });
    h.session.beginTurn();
    await h.say(WAV, 300);
    h.session.endTurn();
    const done = await h.until(closedTranslation(h), 30_000);
    await h.session.stop();
    console.log('manual:', JSON.stringify(h.segments()), '\n', h.frames().join(' | '));
    expect(done).toBe(true);
    expect(h.of('failed')).toEqual([]);
    expect(pair(h).source?.text).not.toBe('');
    // Nothing is left open: the commit's own id, which LocalAI never transcribes under, opened no source.
    expect(h.segments().filter((s) => !s.closed)).toEqual([]);
    expect(h.frames().filter((f) => f === '>> input_audio_buffer.commit')).toHaveLength(1);
    expect(h.frames().filter((f) => f === '>> response.create')).toEqual([]);
  }, 90_000);
});

describe.skipIf(!SERVER || !TEXT_MODEL)('LocalAI Realtime, live: translation on a text model', () => {
  const VIA_MODEL: Partial<LocalAISettings> = { translateVia: 'model', translateModel: TEXT_MODEL, translateBaseUrl: TEXT_BASE };

  it('translates a typed text with the text model, and asks the Realtime server for nothing', async () => {
    const h = await start({ patch: VIA_MODEL });
    h.session.appendText('Good morning, how are you today?');
    const done = await h.until(closedTranslation(h), 60_000);
    await h.session.stop();
    console.log('typed/model:', JSON.stringify(h.segments()), JSON.stringify(h.timings()));
    expect(done).toBe(true);
    expect(h.of('degraded')).toEqual([]);
    const { source, translation } = pair(h);
    expect(source?.text).toBe('Good morning, how are you today?');
    expect(translation?.origin).toBe(source?.origin);
    expect(h.frames().filter((f) => f.startsWith('>> response.') || f.startsWith('<< response.'))).toEqual([]);
    expect(h.frames().filter((f) => f === '>> text.request')).toHaveLength(1);
  }, 90_000);

  it.skipIf(!WAV)('hears speech in a transcription session: the server writes the source and answers nothing; the text model translates', async () => {
    const h = await start({ patch: VIA_MODEL });
    await h.say(WAV, 2_500);
    const done = await h.until(closedTranslation(h), 60_000);
    await h.session.stop();
    console.log('auto/model:', JSON.stringify(h.segments()), JSON.stringify(h.timings()), '\n', h.frames().filter((f) => !f.includes('speech_')).join(' | '));
    expect(done).toBe(true);
    expect(h.of('failed')).toEqual([]);
    expect(h.of('degraded')).toEqual([]);
    expect(pair(h).source?.text).not.toBe('');
    // The proof the server's own model stayed idle: it created no response.
    expect(h.frames().filter((f) => f.startsWith('<< response.'))).toEqual([]);
    expect(h.frames().filter((f) => f === '>> text.request').length).toBeGreaterThan(0);
  }, 120_000);

  it.skipIf(!WAV)('does the same under manual turns', async () => {
    const h = await start({ turns: 'manual', patch: VIA_MODEL });
    h.session.beginTurn();
    await h.say(WAV, 300);
    h.session.endTurn();
    const done = await h.until(closedTranslation(h), 60_000);
    await h.session.stop();
    console.log('manual/model:', JSON.stringify(h.segments()), JSON.stringify(h.timings()));
    expect(done).toBe(true);
    expect(pair(h).source?.text).not.toBe('');
    expect(h.segments().filter((s) => !s.closed)).toEqual([]);
    expect(h.frames().filter((f) => f.startsWith('<< response.'))).toEqual([]);
  }, 120_000);
});

describe.skipIf(!SERVER || !JA_WAV || !COACH_MODEL)('LocalAI Realtime, live: a coached speaker', () => {
  // "I read Chinese, the other side speaks Japanese", and I speak Japanese myself.
  const direction = { source: 'zh-CN', target: 'ja' };
  const COACH: Partial<LocalAISettings> = { coach: true, coachModel: COACH_MODEL, translateModel: TEXT_MODEL };

  it('is heard in Japanese and answered with feedback, not a translation', async () => {
    const h = await start({ direction, patch: COACH });
    await h.say(JA_WAV, 2_500);
    const done = await h.until(closedTranslation(h), 90_000);
    await h.session.stop();
    console.log('coach:', JSON.stringify(h.segments()), JSON.stringify(h.timings()));
    expect(done).toBe(true);
    expect(h.of('failed')).toEqual([]);
    const { source, translation } = pair(h);
    // The source is what was said, in Japanese, and the row is told so; the feedback is in the speaker's own language.
    expect(source?.language).toBe('ja');
    expect(source?.text).toMatch(/[぀-ヿ]/);
    expect(translation?.language).toBe('zh-CN');
    expect(h.frames().filter((f) => f.startsWith('<< response.'))).toEqual([]);
  }, 150_000);

  it.skipIf(!TEXT_MODEL)('still translates what is typed, into Japanese', async () => {
    const h = await start({ direction, patch: COACH });
    h.session.appendText('报销');
    const done = await h.until(closedTranslation(h), 60_000);
    await h.session.stop();
    console.log('coach/typed:', JSON.stringify(h.segments()), JSON.stringify(h.timings()));
    expect(done).toBe(true);
    expect(pair(h).source?.text).toBe('报销');
    expect(pair(h).translation?.text).not.toBe('');
  }, 90_000);
});
