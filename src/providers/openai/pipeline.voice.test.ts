/**
 * Fork: a leg that speaks (`Stages.voice`): which of its answers are spoken, in what order, and what a voice that
 * fails or falls behind does to the session.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionContext } from '../../lib/contract/adapter';
import { recordEvents, type AdapterEvent } from '../../lib/contract/events';
import { fakeSockets } from '../../lib/contract/testing/fakeSocket';
import { trackedClock } from '../../lib/contract/testing/trackedClock';
import { buildLocalAI, LOCALAI_DEFAULTS, type LocalAICredentials, type LocalAISettings } from './localai';
import { createPipelineAdapter, FIRST_REF } from './pipeline';
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

async function live(context: SessionContext, patch: Partial<LocalAISettings>, answers: Response[], voice: Partial<Pick<VoiceDeps, 'decode' | 'native' | 'edge'>> = {}) {
  const config = buildLocalAI(context, { ...LOCALAI_DEFAULTS, ...patch }, shared);
  if ('refused' in config) throw new Error(config.refused);
  const sockets = fakeSockets();
  const { clock } = trackedClock();
  const { events, log } = recordEvents();
  const said: Array<{ text: string; voice: string }> = [];
  const fetch = vi.fn(() => {
    const next = answers.shift();
    return next ? Promise.resolve(next) : Promise.reject(new Error('no answer scripted'));
  });
  const deps: Pick<VoiceDeps, 'decode' | 'native' | 'edge'> = {
    decode: async () => new Int16Array(2400).fill(500),
    native: async () => undefined,
    edge: async (request) => { said.push(request); return new ArrayBuffer(8); },
    ...voice,
  };
  const starting = createPipelineAdapter({ openSocket: sockets.create, fetch: fetch as unknown as typeof globalThis.fetch, voice: deps }).start({ context, config, credentials: K, clock, signal: new AbortController().signal }, events);
  const socket = sockets.last();
  socket.open('');
  socket.receive(frame({ type: 'session.created', session: { id: 'sess_1', type: 'realtime', model: 'gpt-realtime' } }));
  socket.receive(frame({ type: 'session.updated', session: { id: 'sess_1', type: config.transcribeOnly ? 'transcription' : 'realtime' } }));
  const session = await starting;
  stops.push(() => session.stop());
  const of = <T extends AdapterEvent['kind']>(kind: T) => log.filter((e): e is Extract<AdapterEvent, { kind: T }> => e.kind === kind);
  const frames = (type: string) => of('frame').filter((e) => e.payload.type === type);
  return { config, session, log, of, frames, said, clock, receive: (...m: string[]) => { for (const x of m) socket.receive(x); } };
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
