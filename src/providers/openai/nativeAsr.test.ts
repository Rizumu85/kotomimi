import { describe, expect, it } from 'vitest';
import { createVirtualClock } from '../../lib/contract/clock';
import { NO_NATIVE_ENGINE, type NativeBridge, type NativeEngineStatus, type NativeStreamEvent } from '../../lib/native/nativeEngine';
import type { VadWorker } from './apiAsr';
import { createNativeAsr, LAST_WORDS_TIMEOUT_MS, ROLL_AFTER_SECONDS, ROLL_AT_SECONDS } from './nativeAsr';

const RATE = 24000;
const VAD = { threshold: 0.5, minSilenceDuration: 1.4, minSpeechDuration: 0.4, maxSpeechDuration: 15 };
const READY: NativeEngineStatus = { ...NO_NATIVE_ENGINE, supported: true, engine: 'ready', run: { state: 'ready', model: 'r2t2-q8', port: 4000, tail: '' } };

/** The detector as a recorder: what it was sent, and a way to say what it "heard". */
function fakeVad() {
  const sent: Array<{ type: string; pcm?: Int16Array }> = [];
  const worker: VadWorker & { say(type: string, extra?: { message?: string; forced?: boolean }): void; terminated: boolean } = {
    onmessage: null,
    onerror: null,
    terminated: false,
    postMessage: (message) => { sent.push(message as { type: string }); },
    terminate: () => { worker.terminated = true; },
    say: (type, extra = {}) => worker.onmessage?.({ data: { type, ...extra } }),
  };
  return { worker, sent };
}

/** The engine as a recorder: each recognition it opened, with the samples it was given and how it was left. */
function fakeEngine(options: { down?: boolean } = {}) {
  const streams: Array<{ id: number; language: string; sampleRate: number; samples: number; ended: boolean; aborted: boolean }> = [];
  let listener: ((event: NativeStreamEvent) => void) | null = null;
  const state = { down: options.down ?? false, listening: 0 };
  const bridge: NativeBridge = {
    async open(init) {
      if (state.down) return null;
      const id = streams.length + 1;
      streams.push({ id, ...init, samples: 0, ended: false, aborted: false });
      return id;
    },
    write: (id, pcm) => { streams[id - 1].samples += pcm.length; },
    end: (id) => { streams[id - 1].ended = true; },
    abort: (id) => { streams[id - 1].aborted = true; },
    listen: (mine) => {
      listener = mine;
      state.listening += 1;
      return () => { listener = null; state.listening -= 1; };
    },
  };
  return { bridge, streams, state, say: (event: NativeStreamEvent) => listener?.(event) };
}

async function started(engine = fakeEngine(), options: { status?: NativeEngineStatus; vad?: typeof VAD } = {}) {
  const vad = fakeVad();
  const clock = createVirtualClock();
  const asr = createNativeAsr({ bridge: engine.bridge, start: async () => options.status ?? READY, vad: () => vad.worker, now: () => clock.now(), clock });
  const seen = { partials: [] as string[], results: [] as string[], starts: 0, errors: [] as string[], fatal: [] as string[] };
  asr.onPartialResult = (text) => seen.partials.push(text);
  asr.onResult = (result) => seen.results.push(result.text);
  asr.onSpeechStart = () => { seen.starts += 1; };
  asr.onError = (error) => seen.errors.push(error);
  asr.onFatal = (error) => seen.fatal.push(error);
  const ready = asr.init('r2t2-q8', { vadConfig: options.vad ?? VAD, language: 'ja-JP' });
  vad.worker.say('ready');
  await ready;
  return { asr, vad, engine, seen, clock };
}

const seconds = (s: number, value = 1000) => new Int16Array(Math.round(s * RATE)).fill(value);
const settled = () => new Promise((r) => setTimeout(r, 0));

describe('this computer\'s native recognizer', () => {
  it('does not start without its engine, and says what the engine said', async () => {
    const vad = fakeVad();
    const failed: NativeEngineStatus = { ...READY, run: { state: 'failed', model: null, port: 0, tail: 'loading\nvulkan: no device found' } };
    const asr = createNativeAsr({ bridge: fakeEngine().bridge, start: async () => failed, vad: () => vad.worker });
    const ready = asr.init('r2t2-q8', { vadConfig: VAD, language: 'ja' });
    vad.worker.say('ready');
    await expect(ready).rejects.toThrow('could not start: vulkan: no device found');
  });

  it('opens one recognition for a stretch of speech, with the moments before it, in the language heard', async () => {
    const { asr, vad, engine, seen } = await started();
    asr.feedAudio(seconds(2), RATE);
    asr.feedAudio(seconds(0.5), RATE);
    expect(engine.streams).toHaveLength(0);
    vad.worker.say('speech_start');
    await settled();
    expect(seen.starts).toBe(1);
    expect(engine.streams).toHaveLength(1);
    expect(engine.streams[0]).toMatchObject({ language: 'ja', sampleRate: RATE });
    // The pre-roll is whole chunks: at least 0.8 s, and no more than the last two.
    expect(engine.streams[0].samples).toBe(2.5 * RATE);
    asr.feedAudio(seconds(1), RATE);
    expect(engine.streams[0].samples).toBe(3.5 * RATE);
    // The detector hears everything, speech or not.
    expect(vad.sent.filter((m) => m.type === 'audio')).toHaveLength(3);
  });

  it('shows what is written as it comes, and gives the whole as the result when the pause has passed', async () => {
    const { asr, vad, engine, seen } = await started();
    vad.worker.say('speech_start');
    await settled();
    asr.feedAudio(seconds(2), RATE);
    engine.say({ id: 1, type: 'delta', text: 'こんにちは' });
    engine.say({ id: 1, type: 'delta', text: '今日は' });
    expect(seen.partials).toEqual(['こんにちは', 'こんにちは今日は']);
    // The silence of the pause goes to the engine too.
    asr.feedAudio(seconds(1.4, 0), RATE);
    vad.worker.say('speech_end');
    expect(engine.streams[0].ended).toBe(true);
    expect(engine.streams[0].samples).toBe(3.4 * RATE);
    expect(seen.results).toEqual([]);
    engine.say({ id: 1, type: 'done', text: 'こんにちは今日はいい天気' });
    expect(seen.results).toEqual(['こんにちは今日はいい天気']);
    // Sound after it is nobody's until the next voice.
    asr.feedAudio(seconds(1), RATE);
    expect(engine.streams[0].samples).toBe(3.4 * RATE);
  });

  it('adds the silence the engine needs when the detector waits for less', async () => {
    const { asr, vad, engine } = await started(fakeEngine(), { vad: { ...VAD, minSilenceDuration: 0.1 } });
    vad.worker.say('speech_start');
    await settled();
    asr.feedAudio(seconds(1), RATE);
    vad.worker.say('speech_end');
    expect(engine.streams[0].samples).toBe(Math.round(1.2 * RATE));
  });

  it('makes a result of what is written where the detector cuts a long stretch, and keeps the recognition open', async () => {
    const { asr, vad, engine, seen } = await started();
    vad.worker.say('speech_start');
    await settled();
    asr.feedAudio(seconds(15), RATE);
    engine.say({ id: 1, type: 'delta', text: '長い話の前半' });
    vad.worker.say('speech_end', { forced: true });
    expect(seen.results).toEqual(['長い話の前半']);
    expect(engine.streams[0].ended).toBe(false);
    // The sound between the cut and the detector's next "speech" is not dropped.
    asr.feedAudio(seconds(0.1), RATE);
    vad.worker.say('speech_start');
    await settled();
    expect(engine.streams).toHaveLength(1);
    expect(engine.streams[0].samples).toBe(Math.round(15.1 * RATE));
    engine.say({ id: 1, type: 'delta', text: 'と後半' });
    expect(seen.partials[seen.partials.length - 1]).toBe('と後半');
    vad.worker.say('speech_end');
    engine.say({ id: 1, type: 'done', text: '長い話の前半と後半です' });
    expect(seen.results).toEqual(['長い話の前半', 'と後半です']);
  });

  it('keeps the tail of a cut stretch the detector calls too short to be speech', async () => {
    const { asr, vad, engine, seen } = await started();
    vad.worker.say('speech_start');
    await settled();
    asr.feedAudio(seconds(15), RATE);
    engine.say({ id: 1, type: 'delta', text: '前半' });
    vad.worker.say('speech_end', { forced: true });
    asr.feedAudio(seconds(0.3), RATE);
    vad.worker.say('speech_start');
    vad.worker.say('speech_cancel');
    expect(engine.streams[0].ended).toBe(true);
    engine.say({ id: 1, type: 'done', text: '前半です' });
    expect(seen.results).toEqual(['前半', 'です']);
  });

  it('keeps nothing of a sound too short to be speech', async () => {
    const { asr, vad, engine, seen } = await started();
    vad.worker.say('speech_start');
    await settled();
    asr.feedAudio(seconds(0.3), RATE);
    vad.worker.say('speech_cancel');
    engine.say({ id: 1, type: 'delta', text: 'ん' });
    engine.say({ id: 1, type: 'done', text: 'ん' });
    expect(seen.partials).toEqual([]);
    expect(seen.results).toEqual(['']);
  });

  it('begins a long recognition again at a gap between words, the engine taking the new one when the old is done', async () => {
    const { asr, vad, engine, seen } = await started();
    vad.worker.say('speech_start');
    await settled();
    for (let i = 0; i < ROLL_AFTER_SECONDS; i += 1) asr.feedAudio(seconds(1), RATE);
    expect(engine.streams).toHaveLength(1);
    // Loud: no gap. Then a fifth of a second of quiet.
    asr.feedAudio(seconds(1), RATE);
    expect(engine.streams[0].ended).toBe(false);
    asr.feedAudio(seconds(0.1, 20), RATE);
    asr.feedAudio(seconds(0.1, 20), RATE);
    expect(engine.streams[0].ended).toBe(true);
    // What follows waits for the engine: it runs one recognition at a time.
    asr.feedAudio(seconds(2), RATE);
    await settled();
    expect(engine.streams).toHaveLength(1);
    engine.say({ id: 1, type: 'done', text: '一つ目' });
    await settled();
    expect(seen.results).toEqual(['一つ目']);
    expect(engine.streams).toHaveLength(2);
    expect(engine.streams[1].samples).toBe(2 * RATE);
    asr.feedAudio(seconds(1), RATE);
    expect(engine.streams[1].samples).toBe(3 * RATE);
  });

  it('begins again where the detector cuts, once a recognition has run a minute with no gap', async () => {
    const { asr, vad, engine, seen } = await started();
    vad.worker.say('speech_start');
    await settled();
    for (let i = 0; i < ROLL_AT_SECONDS; i += 1) asr.feedAudio(seconds(1), RATE);
    engine.say({ id: 1, type: 'delta', text: 'ずっと話す' });
    vad.worker.say('speech_end', { forced: true });
    expect(seen.results).toEqual(['ずっと話す']);
    expect(engine.streams[0].ended).toBe(true);
    engine.say({ id: 1, type: 'done', text: 'ずっと話す人' });
    await settled();
    expect(seen.results).toEqual(['ずっと話す', '人']);
    expect(engine.streams).toHaveLength(2);
  });

  it('gives what it has when the last words never come, and lets the next stretch through', async () => {
    const { asr, vad, engine, seen, clock } = await started();
    vad.worker.say('speech_start');
    await settled();
    asr.feedAudio(seconds(2), RATE);
    engine.say({ id: 1, type: 'delta', text: '途中まで' });
    vad.worker.say('speech_end');
    vad.worker.say('speech_start');
    asr.feedAudio(seconds(1), RATE);
    await settled();
    expect(engine.streams).toHaveLength(1);
    clock.advance(LAST_WORDS_TIMEOUT_MS);
    await settled();
    expect(seen.results).toEqual(['途中まで']);
    expect(engine.streams[0].aborted).toBe(true);
    expect(engine.streams).toHaveLength(2);
    expect(engine.streams[1].samples).toBe(RATE);
  });

  it('reports one recognition failing as one sentence lost, and goes on', async () => {
    const { asr, vad, engine, seen } = await started();
    vad.worker.say('speech_start');
    await settled();
    engine.say({ id: 1, type: 'error', message: 'The engine answered HTTP 500.' });
    expect(seen.errors).toEqual(['The engine answered HTTP 500.']);
    asr.feedAudio(seconds(1), RATE);
    vad.worker.say('speech_start');
    await settled();
    expect(engine.streams).toHaveLength(2);
    expect(seen.fatal).toEqual([]);
  });

  it('says so, for good, when the engine is no longer there', async () => {
    const engine = fakeEngine();
    const { vad, seen } = await started(engine);
    engine.state.down = true;
    vad.worker.say('speech_start');
    await settled();
    expect(seen.fatal).toEqual(['The recognition engine of this computer is not running.']);
  });

  it('closes the turn on a flush, whatever the detector thinks', async () => {
    const { asr, vad, engine } = await started();
    vad.worker.say('speech_start');
    await settled();
    asr.feedAudio(seconds(15), RATE);
    vad.worker.say('speech_end', { forced: true });
    asr.flush();
    expect(engine.streams[0].ended).toBe(true);
    expect(vad.sent[vad.sent.length - 1]).toEqual({ type: 'flush' });
  });

  it('lets go of everything when it is disposed of', async () => {
    const { asr, vad, engine, seen } = await started();
    vad.worker.say('speech_start');
    await settled();
    asr.dispose();
    expect(engine.streams[0].aborted).toBe(true);
    expect(engine.state.listening).toBe(0);
    expect(vad.worker.terminated).toBe(true);
    engine.say({ id: 1, type: 'done', text: '遅い' });
    expect(seen.results).toEqual([]);
  });
});
