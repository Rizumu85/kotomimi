/**
 * Fork: a leg that speaks (`Stages.voice`): which of its answers are spoken, in what order, and what a voice that
 * fails or falls behind does to the session.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionContext } from '../../lib/contract/adapter';
import { recordEvents, type AdapterEvent } from '../../lib/contract/events';
import { fakeSockets } from '../../lib/contract/testing/fakeSocket';
import { trackedClock } from '../../lib/contract/testing/trackedClock';
import { buildLocalAI, LOCALAI_DEFAULTS, type LocalAIConfig, type LocalAICredentials, type LocalAISettings } from './localai';
import { createPipelineAdapter, FIRST_REF } from './pipeline';
import { Speaker } from './speaker';
import { exchange, SHARED } from './testing';
import type { VoiceDeps } from './voice';

const K: LocalAICredentials = { apiKey: '', endpoint: 'ws://192.168.1.10:8080/v1/realtime' };
const SPEAKS: SessionContext = { leg: 'speaker', direction: { source: 'zh-CN', target: 'ja' }, speech: true, turns: 'auto' };
const OTHER_SIDE: SessionContext = { leg: 'participant', direction: { source: 'ja', target: 'zh-CN' }, speech: false, turns: 'auto' };
const shared = { ...SHARED, reversed: (d: SessionContext['direction']) => d.source === 'ja', models: [{ id: 'gpt-realtime' }, { id: 'hy-mt2-1.8b' }] };
const EDGE_ON: Partial<LocalAISettings> = { translateServerModel: 'hy-mt2-1.8b', speak: { ...LOCALAI_DEFAULTS.speak, on: true, at: 'api' } };

const frame = (e: Record<string, unknown>) => JSON.stringify(e);
const heard = (id: string, text: string) => [
  frame({ type: 'input_audio_buffer.committed', item_id: id }),
  frame({ type: 'conversation.item.input_audio_transcription.delta', item_id: id, content_index: 0, delta: text }),
  frame({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, content_index: 0, transcript: text }),
];
const sse = (...pieces: string[]) => new Response(
  `${pieces.map((p) => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`).join('')}data: [DONE]\n\n`,
  { headers: { 'Content-Type': 'text/event-stream' } },
);

const stops: Array<() => Promise<void>> = [];
afterEach(async () => { for (const stop of stops.splice(0)) await stop(); });

describe('sentence playback on the request clock', () => {
  function voice(withSaying = true) {
    const { clock } = trackedClock();
    let piece: (value: number) => void;
    let finish: () => void;
    const native: VoiceDeps['native'] = (_request, take) => new Promise<void>((resolve) => {
      piece = (value) => take(new Int16Array(6000).fill(value), 24_000); // 250 ms
      finish = resolve;
    });
    const audio = vi.fn();
    const until = vi.fn();
    const saying = vi.fn((_text: string, _from: number) => until);
    const degraded = vi.fn();
    const frame = vi.fn();
    const speaker = new Speaker({ via: 'speech', engine: true, baseUrl: '', model: 'test', voices: {} }, undefined,
      { clock, native, fetch: vi.fn(), decode: vi.fn(), edge: vi.fn() }, { audio, degraded, frame },
      withSaying ? saying : undefined);
    const say = (ref: number, text = `Sentence ${ref}`) => speaker.say(ref, text, 'en');
    const done = async () => {
      frame.mockClear();
      finish();
      await vi.waitFor(() => expect(frame).toHaveBeenCalledWith(expect.objectContaining({ type: 'voice.done' })));
    };
    return { clock, say, audio, saying, until, degraded, piece: (value: number) => piece(value), done };
  }

  it('streams at the margin and excludes the wait for the first piece', async () => {
    const h = voice();
    h.say(1);
    h.clock.advance(3000);
    expect(h.saying).not.toHaveBeenCalled();
    h.piece(1);
    expect(h.audio).toHaveBeenCalledTimes(1);
    h.clock.advance(200);
    h.piece(2);
    expect(h.audio).toHaveBeenCalledTimes(2);
    h.clock.advance(200); // 400 ms from first piece to end for 500 ms of sound
    await h.done();
    h.say(2);
    h.piece(3);
    expect(h.audio).toHaveBeenCalledTimes(3);
    await h.done();
    expect(h.degraded).not.toHaveBeenCalled();
  });

  it('counts a late piece even with a fast average and dates the echo from hand-on', async () => {
    const h = voice();
    h.say(1);
    h.piece(1);
    h.clock.advance(300);
    h.piece(2);
    await h.done();
    expect(h.audio).toHaveBeenCalledTimes(2);
    expect(h.until).toHaveBeenLastCalledWith(550);

    h.say(2);
    h.piece(3);
    h.clock.advance(1000);
    h.piece(4);
    expect(h.audio).toHaveBeenCalledTimes(2);
    expect(h.saying).toHaveBeenCalledTimes(1);
    await h.done();
    expect(h.audio).toHaveBeenCalledTimes(3);
    const [{ ref, pcm }] = h.audio.mock.lastCall!;
    expect(ref).toBe(2);
    expect(pcm).toHaveLength(12000);
    expect([pcm[0], pcm[5999], pcm[6000], pcm[11999]]).toEqual([3, 3, 4, 4]);
    expect(h.saying).toHaveBeenLastCalledWith('Sentence 2', 1300);
    expect(h.until).toHaveBeenLastCalledWith(1800);
    h.say(3);
    h.piece(5);
    await h.done();
    expect(h.saying).toHaveBeenLastCalledWith('Sentence 3', 1800);
    expect(h.until).toHaveBeenLastCalledWith(2050);
  });

  it('holds above the margin, streams after three fast sentences, and warns only once', async () => {
    const h = voice();
    for (let ref = 1; ref <= 6; ref++) {
      h.say(ref);
      const before = h.audio.mock.calls.length;
      h.piece(1);
      const streaming = ref === 1 || ref === 5;
      expect(h.audio.mock.calls.length - before).toBe(streaming ? 1 : 0);
      h.clock.advance(100);
      h.piece(2);
      // No piece was late, but completing these sentences took 401 ms for 500 ms of sound.
      if (streaming) h.clock.advance(301);
      await h.done();
      expect(h.audio.mock.calls.length - before).toBe(streaming ? 2 : 1);
    }
    expect(h.degraded.mock.calls).toEqual([[{ code: 'tts_slow', message: expect.any(String) }]]);
  });

  it('drops the oldest sentence waiting behind a held sentence', async () => {
    const h = voice();
    h.say(1);
    h.piece(1);
    h.clock.advance(300);
    h.piece(2);
    await h.done();
    h.say(2);
    h.piece(3);
    h.say(3);
    h.say(4);
    h.say(5);
    await h.done();
    for (const value of [4, 5]) { h.piece(value); await h.done(); }
    expect(h.audio.mock.calls.map(([event]) => event.ref)).toEqual([1, 1, 2, 4, 5]);
  });

  it('keeps a server echo for ten seconds after the held sound plays out', async () => {
    const h = voice(false);
    h.say(1);
    h.piece(1);
    h.clock.advance(300);
    h.piece(2);
    await h.done();
    h.say(2, 'Hello again');
    h.piece(3);
    h.clock.advance(2000);
    await h.done();
    h.clock.advance(10_249);
    h.say(3, 'Hello again');
    h.clock.advance(1);
    h.say(4, 'Hello again');
    h.piece(4);
    await h.done();
    expect(h.audio.mock.calls.map(([event]) => event.ref)).toEqual([1, 1, 2, 4]);
  });
});

async function live(context: SessionContext, patch: Partial<LocalAISettings>, answers: Response[], voice: Partial<Pick<VoiceDeps, 'decode' | 'native' | 'edge'>> = {}, adjust?: (config: LocalAIConfig) => void, credentials: LocalAICredentials = K) {
  const config = buildLocalAI(context, { ...LOCALAI_DEFAULTS, ...patch }, shared);
  if ('refused' in config) throw new Error(config.refused);
  adjust?.(config);
  const sockets = fakeSockets();
  const { clock } = trackedClock();
  const { events, log } = recordEvents();
  const said: Array<{ text: string; voice: string }> = [];
  const fetch = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => {
    const next = answers.shift();
    return next ? Promise.resolve(next) : Promise.reject(new Error('no answer scripted'));
  });
  const deps: Pick<VoiceDeps, 'decode' | 'native' | 'edge'> = {
    decode: async () => new Int16Array(2400).fill(500),
    native: async () => undefined,
    edge: async (request) => { said.push(request); return new ArrayBuffer(8); },
    ...voice,
  };
  const starting = createPipelineAdapter({ openSocket: sockets.create, fetch: fetch as unknown as typeof globalThis.fetch, voice: deps }).start({ context, config, credentials, clock, signal: new AbortController().signal }, events);
  const socket = sockets.last();
  socket.open('');
  socket.receive(frame({ type: 'session.created', session: { id: 'sess_1', type: 'realtime', model: 'gpt-realtime' } }));
  socket.receive(frame({ type: 'session.updated', session: { id: 'sess_1', type: config.transcribeOnly ? 'transcription' : 'realtime' } }));
  const session = await starting;
  stops.push(() => session.stop());
  const of = <T extends AdapterEvent['kind']>(kind: T) => log.filter((e): e is Extract<AdapterEvent, { kind: T }> => e.kind === kind);
  const frames = (type: string) => of('frame').filter((e) => e.payload.type === type);
  return { config, session, log, of, frames, said, clock, fetch, receive: (...m: string[]) => { for (const x of m) socket.receive(x); } };
}

describe('a leg that speaks (fork)', () => {
  it('is built with the voice stage only where its context speaks: the speaker\'s leg, the stage on', () => {
    const on = buildLocalAI(SPEAKS, { ...LOCALAI_DEFAULTS, ...EDGE_ON }, shared);
    expect('refused' in on ? null : on.stages?.voice).toMatchObject({ via: 'edge', voices: { ja: 'ja-JP-NanamiNeural' } });
    const silent = buildLocalAI({ ...SPEAKS, speech: false }, { ...LOCALAI_DEFAULTS, ...EDGE_ON }, shared);
    expect('refused' in silent ? null : silent.stages?.voice).toBeUndefined();
    const other = buildLocalAI(OTHER_SIDE, { ...LOCALAI_DEFAULTS, ...EDGE_ON }, shared);
    expect('refused' in other ? null : other.stages?.voice).toBeUndefined();
  });

  it('is refused while its voice API names no model', () => {
    const unnamed = buildLocalAI(SPEAKS, { ...LOCALAI_DEFAULTS, ...EDGE_ON, speak: { ...LOCALAI_DEFAULTS.speak, on: true, at: 'api', apiBaseUrl: 'https://api.example.com/v1', apiModel: '' } }, shared);
    expect(unnamed).toMatchObject({ code: 'voice_unnamed' });
  });

  describe('with the voice on the other device', () => {
    const QWEN = 'qwen3-tts-1.7b-customvoice-q8';
    const THERE: Partial<LocalAISettings> = { translateServerModel: 'hy-mt2-1.8b', speak: { ...LOCALAI_DEFAULTS.speak, on: true, at: 'server', serverModel: QWEN } };
    const lends = { ...shared, models: [{ id: 'kotomimi', kind: 'pipeline', host: 'kotomimi' }, { id: 'hy-mt2-1.8b', kind: 'translate', host: 'kotomimi' }, { id: QWEN, kind: 'voice', host: 'kotomimi' }] };

    it('is built as a stage of the shared device, and refused where the device lends no voice model', () => {
      const on = buildLocalAI(SPEAKS, { ...LOCALAI_DEFAULTS, ...THERE }, lends);
      expect('refused' in on ? null : on.stages?.voice).toMatchObject({ via: 'speech', server: true, model: QWEN, key: 'serverKey', streams: true, voices: { ja: 'ono_anna' } });
      const none = buildLocalAI(SPEAKS, { ...LOCALAI_DEFAULTS, ...THERE, speak: { ...LOCALAI_DEFAULTS.speak, on: true, at: 'server' } }, { ...lends, models: lends.models.filter((m) => m.kind !== 'voice') });
      expect(none).toMatchObject({ code: 'server_no_voice' });
    });

    it('asks the device the run is connected to, with the run\'s own access key', async () => {
      const pcm = new Response(new Uint8Array(new Int16Array(2400).fill(500).buffer), { headers: { 'Content-Type': 'audio/pcm;rate=24000' } });
      // Asked first, as the run begins: the warm-up, whose sound nobody hears.
      const warm = new Response(new Uint8Array(4), { headers: { 'Content-Type': 'audio/pcm;rate=24000' } });
      const h = await live(SPEAKS, THERE, [warm, sse('こんにちは。'), pcm], { decode: async () => new Int16Array(0) }, undefined, { ...K, apiKey: 'door-key' });
      h.receive(...heard('a', '你好。'));
      await vi.waitFor(() => expect(h.of('audio')).toHaveLength(1));
      expect(h.of('audio')[0].payload.pcm).toHaveLength(2400);
      const speeches = h.fetch.mock.calls.filter((call) => String(call[0]).endsWith('/audio/speech'));
      expect(speeches).toHaveLength(2);
      expect(JSON.parse(speeches[0][1]!.body as string)).toMatchObject({ model: QWEN, input: 'こんにちは。', response_format: 'pcm' });
      const asked = speeches[1];
      expect(String(asked[0])).toBe('http://192.168.1.10:8080/v1/audio/speech');
      expect((asked[1]!.headers as Record<string, string>).Authorization).toBe('Bearer door-key');
      expect(JSON.parse(asked[1]!.body as string)).toMatchObject({ model: QWEN, input: 'こんにちは。', voice: 'ono_anna', response_format: 'pcm', language: 'ja' });
    });
  });

  it('speaks each translation when it is whole, on the translation\'s own segment, in the language\'s voice', async () => {
    const h = await live(SPEAKS, EDGE_ON, [sse('こん', 'にちは。')]);
    h.receive(...heard('a', '你好。'));
    await vi.waitFor(() => expect(h.of('audio')).toHaveLength(1));
    expect(h.said).toEqual([{ text: 'こんにちは。', voice: 'ja-JP-NanamiNeural' }]);
    const translation = h.of('segmentOpened').find((e) => e.payload.side === 'translation')?.payload.ref;
    expect(h.of('audio')[0].payload.ref).toBe(translation);
    expect(h.of('audio')[0].payload.pcm).toBeInstanceOf(Int16Array);
    expect(h.frames('voice.done')).toHaveLength(1);
  });

  it('speaks each finished translation in the tone of its source or its final words', async () => {
    const native = vi.fn<VoiceDeps['native']>(async (_request, piece) => { piece(new Int16Array(2400), 24000); });
    const h = await live(SPEAKS, EDGE_ON, [sse('手紙が届いた。'), sse('ありが', 'とう。')], { native }, (config) => {
      config.stages!.voice = { via: 'speech', engine: true, baseUrl: '', model: 'qwen3-tts-1.7b-base-q8', voices: { ja: 'aaa111' }, patient: true };
    });
    h.receive(...heard('a', '太好了，信到了。'), ...heard('b', '我收到了你的包裹。'));
    await vi.waitFor(() => expect(h.of('audio')).toHaveLength(2));
    expect(native.mock.calls.map(([{ text, tone }]) => [text, tone])).toEqual([['手紙が届いた。', 'lively'], ['ありがとう。', 'gentle']]);
  });

  describe('with a second language of theirs lit', () => {
    const TWO: Partial<LocalAISettings> = { ...EDGE_ON, theyAlso: ['en'], theyLit: 'en', asrDetectOther: true };
    // Without the loudspeaker check, which legs of earlier tests would hold a sentence for.
    const unchecked = (config: LocalAIConfig) => { delete config.stages!.leakCheck; };

    it('speaks the translation into each of their languages, the main one first, each in its own voice', async () => {
      const h = await live(SPEAKS, TWO, [sse('次のワールドに行こう。'), sse("Let's go to the next world.")], {}, unchecked);
      expect(h.config.stages?.voice?.voices).toMatchObject({ ja: 'ja-JP-NanamiNeural', en: expect.stringMatching(/^en-/) });
      h.receive(...heard('a', '我们去下一个世界吧。'));
      await vi.waitFor(() => expect(h.of('audio')).toHaveLength(2));
      expect(h.said.map((one) => one.text)).toEqual(['次のワールドに行こう。', "Let's go to the next world."]);
      expect(h.said[1].voice).toMatch(/^en-/);
      // Each on its own translation's segment.
      const refs = h.of('segmentOpened').filter((e) => e.payload.side === 'translation').map((e) => e.payload.ref);
      expect(h.of('audio').map((e) => e.payload.ref)).toEqual(refs);
    });

    it('speaks a sentence said in one of theirs in the other, and never the one back into the user\'s own', async () => {
      const crossing = (config: LocalAIConfig) => {
        delete config.stages!.leakCheck;
        Object.assign(config.stages!, {
          heard: 'auto',
          back: { stage: { kind: 'translate', model: 'back', baseUrl: '', system: 'Translate into zh-CN', language: 'zh-CN' }, language: 'ja', own: 'zh-CN', languages: ['ja'] },
          cross: [{ language: 'ja', stage: { kind: 'translate', model: 'across', baseUrl: '', system: 'Translate into en', language: 'en' } }],
        });
      };
      const h = await live(SPEAKS, TWO, [sse("Let's go to the next world."), sse('我们去下一个世界吧。')], {}, crossing);
      h.receive(...heard('a', '次のワールドに行こう'));
      await vi.waitFor(() => expect(h.frames('text.done')).toHaveLength(2));
      await vi.waitFor(() => expect(h.of('audio')).toHaveLength(1));
      expect(h.said.map((one) => one.text)).toEqual(["Let's go to the next world."]);
      expect(h.frames('voice.request')).toHaveLength(1);
    });

    it('holds each language to its own count when the voice falls behind: neither is left out for the other', async () => {
      const release: Array<() => void> = [];
      const spoken: string[] = [];
      const answers = ['一', '二', '三', '四'].flatMap((n, i) => [sse(`${n}。`), sse(`${['One', 'Two', 'Three', 'Four'][i]}.`)]);
      const h = await live(SPEAKS, TWO, answers, {
        edge: (request) => new Promise((resolve) => { spoken.push(request.text); release.push(() => resolve(new ArrayBuffer(8))); }),
      }, unchecked);
      for (const [id, text] of [['a', '第一句。'], ['b', '第二句。'], ['c', '第三句。'], ['d', '第四句。']] as const) h.receive(...heard(id, text));
      // 一 is being made, and held: of each language two wait behind it, the oldest gone — 二; One, then Two.
      await vi.waitFor(() => expect(h.frames('voice.skipped')).toHaveLength(3));
      for (let i = 0; i < 5; i += 1) { await vi.waitFor(() => expect(release.length).toBeGreaterThan(i)); release[i](); }
      await vi.waitFor(() => expect(h.of('audio')).toHaveLength(5));
      expect(spoken.filter((text) => /。$/.test(text))).toEqual(['一。', '三。', '四。']);
      expect(spoken.filter((text) => /\.$/.test(text))).toEqual(['Three.', 'Four.']);
    });

    it('is built where the voice speaks only their second language', () => {
      // Irodori speaks Japanese alone: their main language is English, Japanese lit beside it.
      const english: SessionContext = { ...SPEAKS, direction: { source: 'zh-CN', target: 'en' } };
      const irodori: Partial<LocalAISettings> = { translateServerModel: 'hy-mt2-1.8b', speak: { ...LOCALAI_DEFAULTS.speak, on: true, at: 'device', nativeModel: 'irodori-tts-v4.1-small-mf-q8' }, theyAlso: ['ja'], theyLit: 'ja', asrDetectOther: true };
      const built = buildLocalAI(english, { ...LOCALAI_DEFAULTS, ...irodori }, { ...shared, reversed: (d: SessionContext['direction']) => d.source === 'en' });
      expect('refused' in built ? built : built.stages?.voice).toMatchObject({ engine: true, languages: ['ja'] });
      const alone = buildLocalAI(english, { ...LOCALAI_DEFAULTS, ...irodori, theyLit: '', asrDetectOther: false }, { ...shared, reversed: (d: SessionContext['direction']) => d.source === 'en' });
      expect('refused' in alone ? alone : alone.stages?.voice).toBeUndefined();
    });
  });

  it('speaks a translation between two writings of one language: simplified into traditional', async () => {
    const traditional: SessionContext = { ...SPEAKS, direction: { source: 'zh-CN', target: 'zh-TW' } };
    const h = await live(traditional, EDGE_ON, [sse('軟體已經更新了。')]);
    h.receive(...heard('a', '软件已经更新了。'));
    await vi.waitFor(() => expect(h.of('audio')).toHaveLength(1));
    expect(h.said.map((one) => one.text)).toEqual(['軟體已經更新了。']);
  });

  it('says a typed sentence\'s translation too', async () => {
    const h = await live(SPEAKS, EDGE_ON, [sse('経費精算')]);
    h.session.appendText('报销');
    await vi.waitFor(() => expect(h.of('audio')).toHaveLength(1));
    expect(h.said[0].text).toBe('経費精算');
    expect(h.of('audio')[0].payload.ref).toBe(FIRST_REF + 2);
  });

  it('goes on after a sentence the voice could not make, and says so once for it', async () => {
    let calls = 0;
    const h = await live(SPEAKS, EDGE_ON, [sse('一つ目。'), sse('二つ目。')], {
      edge: async () => { calls += 1; if (calls === 1) throw new Error('No audio received'); return new ArrayBuffer(8); },
    });
    h.receive(...heard('a', '第一句。'), ...heard('b', '第二句。'));
    await vi.waitFor(() => expect(h.of('audio')).toHaveLength(1));
    expect(h.of('degraded').map((e) => e.payload.code)).toEqual(['tts_degraded']);
    expect(h.frames('voice.failed')).toHaveLength(1);
  });

  it('drops the oldest waiting sentence when the voice falls behind, and never the one being made', async () => {
    const release: Array<() => void> = [];
    const spoken: string[] = [];
    const h = await live(SPEAKS, EDGE_ON, [sse('一。'), sse('二。'), sse('三。'), sse('四。')], {
      edge: (request) => new Promise((resolve) => { spoken.push(request.text); release.push(() => resolve(new ArrayBuffer(8))); }),
    });
    for (const [id, text] of [['a', '一。'], ['b', '二。'], ['c', '三。'], ['d', '四。']] as const) h.receive(...heard(id, text));
    await vi.waitFor(() => expect(h.frames('voice.skipped')).toHaveLength(1));
    for (let i = 0; i < 3; i += 1) { await vi.waitFor(() => expect(release.length).toBeGreaterThan(i)); release[i](); }
    await vi.waitFor(() => expect(h.of('audio')).toHaveLength(3));
    expect(spoken).toEqual(['一。', '三。', '四。']);
  });

  it('speaks the translations the other device\'s own session writes, where the leg has no stage of its own', async () => {
    // Every stage on the other device, and its pipeline answering: the leg is the Realtime adapter, heard.
    const h = await live(SPEAKS, { speak: { ...LOCALAI_DEFAULTS.speak, on: true, at: 'api' } }, []);
    expect(h.config.stages).toEqual({ speech: null, typed: null, voice: expect.objectContaining({ via: 'edge' }) });
    h.receive(...exchange(1, { source: '你好。', translation: 'こんにちは。' }));
    await vi.waitFor(() => expect(h.of('audio')).toHaveLength(1));
    expect(h.said).toEqual([{ text: 'こんにちは。', voice: 'ja-JP-NanamiNeural' }]);
    const translation = h.of('segmentOpened').find((e) => e.payload.side === 'translation')?.payload.ref;
    expect(h.of('audio')[0].payload.ref).toBe(translation);
    h.receive(...exchange(2, { source: 'こんにちは', translation: 'こんにちは！' }));
    expect(h.of('segmentOpened').filter((e) => e.payload.side === 'translation')).toHaveLength(2);
    expect(h.frames('voice.request')).toHaveLength(1);
    h.clock.advance(10_200);
    h.receive(...exchange(3, { source: '你好。', translation: 'こんにちは。' }));
    await vi.waitFor(() => expect(h.of('audio')).toHaveLength(2));
  });

  it('does not take its own voice, come back through the microphone, for a sentence of the user\'s', async () => {
    const h = await live(SPEAKS, EDGE_ON, [sse('こんにちは。'), sse('ありがとう。')], { decode: async () => new Int16Array(9_600).fill(500) });
    h.receive(...heard('a', '你好。'));
    await vi.waitFor(() => expect(h.of('audio')).toHaveLength(1));
    // The loudspeakers play it, and the microphone hears the same words while it is still being said.
    h.receive(...heard('b', 'こんにちは'));
    await vi.waitFor(() => expect(h.frames('speech.dropped')).toHaveLength(1));
    // Other words said meanwhile are the user's own: translated, and not held up by the voice.
    h.receive(...heard('c', '谢谢。'));
    await vi.waitFor(() => expect(h.said.map((one) => one.text)).toEqual(['こんにちは。', 'ありがとう。']));
    expect(h.of('degraded')).toHaveLength(0);
  });

  it('recognizes an echo of a queued sentence during its playback window', async () => {
    const speaker = await live(SPEAKS, EDGE_ON, [sse('Welcome.'), sse('Good morning.')], {
      decode: async () => new Int16Array(72_000),
    });
    const participant = await live(OTHER_SIDE, EDGE_ON, [sse('First reply.'), sse('Later reply.')]);
    speaker.session.appendText('First line.');
    await vi.waitFor(() => expect(speaker.of('audio')).toHaveLength(1));
    speaker.session.appendText('Second line.');
    await vi.waitFor(() => expect(speaker.of('audio')).toHaveLength(2));

    // Both clips were handed on at zero. The second plays from 3000 to 6000 ms.
    participant.receive(...heard('early', 'Good morning.'));
    await vi.waitFor(() => expect(participant.frames('text.done')).toHaveLength(1));
    participant.clock.advance(5900);
    participant.receive(...heard('echo', 'Good morning.'));
    expect(participant.frames('speech.dropped')).toHaveLength(1);
    participant.clock.advance(200);
    participant.receive(...heard('later', 'Good morning.'));
    await vi.waitFor(() => expect(participant.frames('text.done')).toHaveLength(2));
  });

  it('drops an audible piece of a failed stream on the participant leg, but not a later repetition', async () => {
    const speaker = await live(SPEAKS, { ...EDGE_ON, speak: { ...LOCALAI_DEFAULTS.speak, on: true } }, [sse('こんばんは。')], {
      native: async (_request, piece) => { piece(new Int16Array(9_600), 24_000); throw new Error('stream ended'); },
    });
    const participant = await live(OTHER_SIDE, EDGE_ON, [sse('Good evening.')]);
    speaker.session.appendText('晚上好。');
    await vi.waitFor(() => expect(speaker.frames('voice.failed')).toHaveLength(1));
    expect(speaker.of('audio')).toHaveLength(1);
    participant.clock.advance(200);
    participant.receive(...heard('echo', 'こんばんは'));
    expect(participant.frames('speech.dropped')).toHaveLength(1);
    participant.clock.advance(300);
    participant.receive(...heard('person', 'こんばんは'));
    await vi.waitFor(() => expect(participant.frames('text.done')).toHaveLength(1));
  });

  it('says nothing more once it is stopped: the sentence being made is given up', async () => {
    let stopped: AbortSignal | undefined;
    const h = await live(SPEAKS, EDGE_ON, [sse('こんにちは。')], {
      edge: (_request, signal) => new Promise((_resolve, reject) => { stopped = signal; signal.addEventListener('abort', () => reject(signal.reason)); }),
    });
    h.receive(...heard('a', '你好。'));
    await vi.waitFor(() => expect(stopped).toBeDefined());
    await h.session.stop();
    expect(stopped?.aborted).toBe(true);
    expect(h.of('audio')).toHaveLength(0);
    expect(h.of('degraded')).toHaveLength(0);
  });
});
