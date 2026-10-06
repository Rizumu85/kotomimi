import { describe, expect, it, vi } from 'vitest';
import type { SessionContext } from '../../lib/contract/adapter';
import { recordEvents, type AdapterEvent } from '../../lib/contract/events';
import { fakeSockets } from '../../lib/contract/testing/fakeSocket';
import { trackedClock } from '../../lib/contract/testing/trackedClock';
import { coachPrompt } from './coachPrompt';
import { buildLocalAI, LOCALAI_DEFAULTS, localaiProvider, type LocalAIConfig, type LocalAICredentials, type LocalAISettings } from './localai';
import { createPipelineAdapter, FIRST_REF, tidyAnswer } from './pipeline';
import { SHARED } from './testing';

const K: LocalAICredentials = { apiKey: '', endpoint: 'ws://192.168.1.10:8080/v1/realtime' };
// "I read Chinese, the other side speaks Japanese": the speaker leg is zh → ja, the participant leg its reverse.
const SPEAKER: SessionContext = { direction: { source: 'zh-CN', target: 'ja' }, speech: false, turns: 'auto' };
const PARTICIPANT: SessionContext = { direction: { source: 'ja', target: 'zh-CN' }, speech: false, turns: 'auto' };
const shared = { ...SHARED, reversed: (d: SessionContext['direction']) => d.source === 'ja', models: [{ id: 'gpt-realtime' }, { id: 'hy-mt2-1.8b' }] };
// A model of the other device's, named: the leg only transcribes there, and the model is asked over chat.
const VIA_MODEL: Partial<LocalAISettings> = { translateServerModel: 'hy-mt2-1.8b' };

const frame = (e: Record<string, unknown>) => JSON.stringify(e);
const SERVER = {
  created: () => frame({ type: 'session.created', session: { id: 'sess_1', type: 'realtime', model: 'gpt-realtime' } }),
  updated: (type: string) => frame({ type: 'session.updated', session: { id: 'sess_1', type } }),
  committed: (id: string) => frame({ type: 'input_audio_buffer.committed', item_id: id }),
  inputDelta: (id: string, delta: string) => frame({ type: 'conversation.item.input_audio_transcription.delta', item_id: id, content_index: 0, delta }),
  inputDone: (id: string, transcript: string) => frame({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, content_index: 0, transcript }),
};
/** One heard utterance as a transcription session frames it. */
const heard = (id: string, text: string) => [SERVER.committed(id), SERVER.inputDelta(id, text), SERVER.inputDone(id, text)];

const sse = (...pieces: string[]) => new Response(
  `${pieces.map((p) => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`).join('')}data: [DONE]\n\n`,
  { headers: { 'Content-Type': 'text/event-stream' } },
);
type Call = { url: string; body: { model: string; messages: Array<{ role: string; content: string }> }; headers: Record<string, string>; signal: AbortSignal | undefined };

/** A leg over a `FakeSocket` and a scripted text model: started, opened, created and configured. */
async function live(context: SessionContext, patch: Partial<LocalAISettings>, answers: Array<Response | Error | 'hang'> = [], credentials: LocalAICredentials = K, tweak: (config: LocalAIConfig) => void = () => {}) {
  const settings = { ...LOCALAI_DEFAULTS, ...patch };
  const config = buildLocalAI(context, settings, shared);
  if ('refused' in config) throw new Error(config.refused);
  tweak(config);
  const sockets = fakeSockets();
  const { clock } = trackedClock();
  const { events, log } = recordEvents();
  const calls: Call[] = [];
  const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(init?.body as string), headers: init?.headers as Record<string, string>, signal: init?.signal ?? undefined });
    const next = answers.shift();
    if (next === undefined) return Promise.reject(new Error('no answer scripted'));
    if (next === 'hang') return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  const starting = createPipelineAdapter({ openSocket: sockets.create, fetch }).start({ context, config, credentials, clock, signal: new AbortController().signal }, events);
  const socket = sockets.last();
  socket.open('');
  socket.receive(SERVER.created());
  socket.receive(SERVER.updated(config.transcribeOnly ? 'transcription' : 'realtime'));
  const session = await starting;
  const of = <T extends AdapterEvent['kind']>(kind: T) => log.filter((e): e is Extract<AdapterEvent, { kind: T }> => e.kind === kind);
  const lastText = (ref: number) => of('segmentText').filter((e) => e.payload.ref === ref).pop()?.payload;
  const settled = () => vi.waitFor(() => expect(of('busy').map((e) => e.payload).pop()).toBe(false));
  return { config, socket, session, calls, log, of, lastText, settled, clock, sent: () => socket.sentJson<Record<string, unknown>>(), receive: (...m: string[]) => { for (const x of m) socket.receive(x); } };
}

describe('a leg whose translation runs on a text model', () => {
  it('opens a transcription session: the input\'s settings alone, no answering switches, no conversation model', async () => {
    const h = await live(PARTICIPANT, VIA_MODEL);
    expect(h.config).toMatchObject({ transcribeOnly: true, anchor: false, commitAnswers: true });
    const update = h.sent()[0].session as { type: string; audio: { input: { turn_detection: Record<string, unknown>; transcription: unknown } } };
    expect(update.type).toBe('transcription');
    expect(update.audio.input.turn_detection).toEqual({ type: 'semantic_vad', eagerness: 'high' });
    expect(update.audio.input.transcription).toEqual({ language: 'ja' });
    expect(update).not.toHaveProperty('instructions');
    expect(update).not.toHaveProperty('output_modalities');
  });

  it('hands each finished source to the text model on the Realtime server, and pairs the answer with it', async () => {
    const h = await live(PARTICIPANT, VIA_MODEL, [sse('今天', '天气很好。')]);
    h.receive(...heard('item_1', '今日は天気がいいですね。'));
    await h.settled();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].url).toBe('http://192.168.1.10:8080/v1/chat/completions');
    expect(h.calls[0].body.model).toBe('hy-mt2-1.8b');
    expect(h.calls[0].body.messages[1]).toEqual({ role: 'user', content: '今日は天気がいいですね。' });
    // The leg's own instructions are the model's: the interpreter's prompt, in this direction.
    expect(h.calls[0].body.messages[0].content).toContain('Japanese');
    // No key of the user's: the placeholder a keyless server takes.
    expect(h.calls[0].headers.Authorization).toBe('Bearer no-key');
    expect(h.of('segmentOpened').map((e) => e.payload)).toEqual([
      { ref: 1, side: 'source', origin: 'item_1' },
      { ref: FIRST_REF + 1, side: 'translation', origin: 'item_1' },
    ]);
    // Streamed: each snapshot is the whole text so far.
    expect(h.of('segmentText').filter((e) => e.payload.ref === FIRST_REF + 1).map((e) => e.payload.text)).toEqual(['今天', '今天天气很好。']);
    expect(h.of('segmentClosed').map((e) => e.payload.ref)).toEqual([1, FIRST_REF + 1]);
    expect(h.of('busy').map((e) => e.payload)).toEqual([true, false]);
    // No response is ever asked of the Realtime server.
    expect(h.sent().map((m) => m.type)).toEqual(['session.update']);
  });

  it('calls another server, with its key, when one is named', async () => {
    const h = await live(PARTICIPANT, { translateAt: 'api', translateModel: 'gpt-4.1-mini', translateBaseUrl: 'https://api.openai.com/v1/', translateNeedsKey: true }, [sse('好')], { ...K, translateKey: 'sk-test-1' });
    h.receive(...heard('item_1', 'いいね'));
    await h.settled();
    expect(h.calls[0].url).toBe('https://api.openai.com/v1/chat/completions');
    expect(h.calls[0].headers.Authorization).toBe('Bearer sk-test-1');
    expect(h.calls[0].body.model).toBe('gpt-4.1-mini');
    // The key is never framed.
    expect(JSON.stringify(h.of('frame'))).not.toContain('sk-test-1');
  });

  it('answers one source at a time, in the order they finished', async () => {
    const h = await live(PARTICIPANT, VIA_MODEL, [sse('一'), sse('二')]);
    h.receive(...heard('item_1', 'いち'), ...heard('item_2', 'に'));
    await h.settled();
    expect(h.calls.map((c) => c.body.messages[1].content)).toEqual(['いち', 'に']);
    const translations = h.of('segmentOpened').map((e) => e.payload).filter((p) => p.side === 'translation');
    expect(translations.map((p) => p.origin)).toEqual(['item_1', 'item_2']);
    expect(h.of('busy').map((e) => e.payload)).toEqual([true, false]);
  });

  it('answers typed text itself: shown at once as its own source, then translated', async () => {
    const h = await live(SPEAKER, VIA_MODEL, [sse('経費精算')]);
    h.session.appendText('  报销 ');
    await h.settled();
    expect(h.sent().map((m) => m.type)).toEqual(['session.update']);
    expect(h.of('segmentOpened').map((e) => e.payload)).toEqual([
      { ref: FIRST_REF + 1, side: 'source', origin: 'sokuji_typed_1' },
      { ref: FIRST_REF + 2, side: 'translation', origin: 'sokuji_typed_1' },
    ]);
    expect(h.lastText(FIRST_REF + 1)?.text).toBe('报销');
    expect(h.lastText(FIRST_REF + 2)?.text).toBe('経費精算');
    expect(h.calls[0].body.messages[1].content).toBe('报销');
  });

  it('keeps the session through a model that fails, and says so: a lost translation, or typed text that cannot be answered', async () => {
    const h = await live(SPEAKER, VIA_MODEL, [new TypeError('Failed to fetch'), new Response('{"error":{"message":"model not found"}}', { status: 404 }), sse('好')]);
    h.receive(...heard('item_1', '一'));
    await h.settled();
    h.session.appendText('二');
    await h.settled();
    expect(h.of('degraded').map((e) => [e.payload.code, e.payload.message])).toEqual([
      ['translation_failed', 'The translation model (hy-mt2-1.8b) did not answer: Failed to fetch'],
      ['typed_translation_failed', 'The translation model (hy-mt2-1.8b) did not answer: HTTP 404: model not found'],
    ]);
    expect(h.of('failed')).toEqual([]);
    // The next one is answered.
    h.receive(...heard('item_3', '三'));
    await h.settled();
    expect(h.of('segmentOpened').map((e) => e.payload).filter((p) => p.side === 'translation').map((p) => p.origin)).toEqual(['item_3']);
  });

  it('on stop aborts the answer in flight, closes the socket, and says nothing more', async () => {
    const h = await live(PARTICIPANT, VIA_MODEL, ['hang']);
    h.receive(...heard('item_1', 'いち'));
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    const before = h.log.length;
    await h.session.stop();
    expect(h.calls[0].signal?.aborted).toBe(true);
    expect(h.socket.closedByClient).not.toBeNull();
    await new Promise((r) => setTimeout(r, 10));
    expect(h.log.length).toBe(before);
  });

  it('passes the inner session\'s failure on, and answers nothing after it', async () => {
    const h = await live(PARTICIPANT, VIA_MODEL, ['hang']);
    h.receive(...heard('item_1', 'いち'));
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    h.socket.serverClose(1011, 'boom');
    // The fake delivers a close as a browser does: after the current task.
    await vi.waitFor(() => expect(h.of('failed')).toHaveLength(1));
    expect(h.calls[0].signal?.aborted).toBe(true);
  });
});

describe('a leg on the server\'s own pipeline', () => {
  it('is the Realtime adapter untouched: a conversation session, and typed text asked of the server', async () => {
    const h = await live(SPEAKER, {});
    expect(h.config).not.toHaveProperty('stages');
    expect(h.config).not.toHaveProperty('transcribeOnly');
    expect((h.sent()[0].session as { type: string }).type).toBe('realtime');
    h.session.appendText('你好');
    expect(h.sent().slice(1).map((m) => m.type)).toEqual(['conversation.item.create', 'response.create']);
    expect(h.calls).toEqual([]);
  });
});

describe('a leg whose language is left to be detected', () => {
  // The leg's stages say so (`heard: 'auto'`): here it is said to a leg heard over a socket, which shows what the wrapper does with it.
  const detected = (config: LocalAIConfig) => { if (config.stages) config.stages.heard = 'auto'; };

  it('gives each sentence the language its writing shows, and translates it', async () => {
    const h = await live(PARTICIPANT, VIA_MODEL, [sse('你好。'), sse('你好！')], K, detected);
    h.receive(...heard('item_1', '안녕하세요.'));
    await h.settled();
    expect(h.lastText(1)).toMatchObject({ text: '안녕하세요.', language: 'ko' });
    h.receive(...heard('item_2', 'Привет!'));
    await h.settled();
    expect(h.lastText(2)).toMatchObject({ text: 'Привет!', language: 'ru' });
    expect(h.calls).toHaveLength(2);
  });

  it('names no language for a few words in Latin letters — the leg\u2019s own is not assumed — and still translates them', async () => {
    const h = await live(PARTICIPANT, VIA_MODEL, [sse('你好。')], K, detected);
    h.receive(...heard('item_1', 'Hello there.'));
    await h.settled();
    expect(h.lastText(1)).toMatchObject({ text: 'Hello there.', language: 'auto' });
    expect(h.calls).toHaveLength(1);
  });

  it('does not translate what was said in the reader\u2019s own language', async () => {
    const h = await live(PARTICIPANT, VIA_MODEL, [sse('こんにちは')], K, detected);
    h.receive(...heard('item_1', '你好，今天天气真不错。'));
    await vi.waitFor(() => expect(h.lastText(1)).toMatchObject({ language: 'zh' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.calls).toHaveLength(0);
    // The next one, in another language, is translated as ever.
    h.receive(...heard('item_2', '今日は天気がいいですね。'));
    await h.settled();
    expect(h.calls).toHaveLength(1);
    expect(h.lastText(2)).toMatchObject({ language: 'ja' });
  });
});

describe('a sentence already in the language the leg translates into', () => {
  it('is shown as said, in that language, and not translated: the other side speaking the reader\u2019s own', async () => {
    // Seen 2026-10-06: the other side, set to Japanese, spoke Chinese; each sentence was shown twice, the first marked JA.
    const h = await live(PARTICIPANT, { translateServerModel: 'hy-mt2-1.8b' }, [sse('今天天气真好。')]);
    h.receive(...heard('item_1', '毕竟VRC的朋友都是年轻人吧。'));
    await vi.waitFor(() => expect(h.of('segmentClosed')).toHaveLength(1));
    expect(h.lastText(1)).toMatchObject({ text: '毕竟VRC的朋友都是年轻人吧。', language: 'zh-CN' });
    // A Japanese sentence after it is translated as ever, and is the only one asked.
    h.receive(...heard('item_2', '今日は天気がいいですね。'));
    await h.settled();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].body.messages.slice(-1)[0]).toMatchObject({ content: expect.stringContaining('今日は天気がいいですね。') });
  });
});

describe('a coached speaker', () => {
  const COACH: Partial<LocalAISettings> = { coach: true, coachServerModel: 'qwen3-4b', translateServerModel: 'hy-mt2-1.8b' };

  it('is heard in the language they practise, and their speech is answered with feedback in their own', async () => {
    const h = await live(SPEAKER, COACH, [sse('昨日映画を見ました。\n', '“见”要用过去式。')]);
    expect((h.sent()[0].session as { type: string; audio: { input: { transcription: unknown } } }).audio.input.transcription).toEqual({ language: 'ja' });
    h.receive(...heard('item_1', '昨日映画を見ます。'));
    await h.settled();
    // The source is Japanese, though the leg's source language is Chinese: the row is told so.
    expect(h.lastText(1)).toMatchObject({ text: '昨日映画を見ます。', language: 'ja' });
    expect(h.calls[0].body.model).toBe('qwen3-4b');
    // The prompt for this pair — a Chinese speaker practising Japanese — and its worked examples as earlier turns, then what was said.
    const prompt = coachPrompt('ja', 'zh-CN');
    expect(h.calls[0].body.messages).toEqual([
      { role: 'system', content: prompt.system },
      ...prompt.shots.flatMap((shot) => [{ role: 'user', content: shot.said }, { role: 'assistant', content: shot.answer }]),
      { role: 'user', content: '昨日映画を見ます。' },
    ]);
    expect(h.lastText(FIRST_REF + 1)).toEqual({ ref: FIRST_REF + 1, text: '昨日映画を見ました。\n“见”要用过去式。', language: 'zh-CN' });
  });

  it('is not given feedback on a sentence in their own language: that one is translated, and said to be in their language', async () => {
    // Asked by the user 2026-10-06: with feedback on, a sentence said in Chinese went to the feedback model too.
    const h = await live(SPEAKER, COACH, [sse('ちょっとソフトを更新しないと。')]);
    h.receive(...heard('item_1', '我得更新一下这个软件。'));
    await h.settled();
    expect(h.lastText(1)).toMatchObject({ text: '我得更新一下这个软件。', language: 'zh-CN' });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].body.model).toBe('hy-mt2-1.8b');
    expect(h.lastText(FIRST_REF + 1)).toMatchObject({ text: 'ちょっとソフトを更新しないと。' });
  });

  it('is not coached on the voice of the other side come back through the microphone: that sentence is taken off the screen', async () => {
    // Asked by the user 2026-10-06: with loudspeakers on, what the other side said went to the feedback as the user's.
    const theirs = await live(PARTICIPANT, { translateServerModel: 'hy-mt2-1.8b' }, [sse('never mind')]);
    const mine = await live(SPEAKER, COACH, [sse('OK')]);
    // The other side is speaking; the microphone hears the same words, a little worse.
    theirs.receive(SERVER.committed('item_1'), SERVER.inputDelta('item_1', 'そうそうそう、それが好きなんですよ。'));
    mine.receive(...heard('item_1', 'そうそうそれが好きなんですよ'));
    await vi.waitFor(() => expect(mine.of('segmentClosed')).toHaveLength(1));
    expect(mine.lastText(1)).toMatchObject({ text: '' });
    expect(mine.calls).toHaveLength(0);
    // The other leg's writing may come after the microphone's: the sentence waits for it, and is dropped when it does.
    mine.receive(...heard('item_9', '今日は天気がいいですね'));
    expect(mine.of('segmentClosed')).toHaveLength(1);
    theirs.receive(SERVER.inputDelta('item_1', 'そうそうそう、それが好きなんですよ。今日は天気がいいですね。'));
    mine.clock.advance(500);
    expect(mine.of('segmentClosed')).toHaveLength(2);
    expect(mine.lastText(2)).toMatchObject({ text: '' });
    expect(mine.calls).toHaveLength(0);
    // What the user says over them is their own: coached once the other leg's writing has had its time to catch up.
    mine.receive(...heard('item_2', '昨日映画を見ました。'));
    const closedSoFar = mine.of('segmentClosed').length;
    mine.clock.advance(4900);
    expect(mine.calls).toHaveLength(0);
    expect(mine.of('segmentClosed')).toHaveLength(closedSoFar);
    mine.clock.advance(200);
    await mine.settled();
    expect(mine.calls).toHaveLength(1);
    expect(mine.calls[0].body.messages.slice(-1)[0]).toMatchObject({ content: '昨日映画を見ました。' });
    await theirs.session.stop();
    await mine.session.stop();
  });

  it('is coached on a sentence repeated after the other side has finished it', async () => {
    const theirs = await live(PARTICIPANT, { translateServerModel: 'hy-mt2-1.8b' }, [sse('对对对，我就是喜欢这个。')]);
    const mine = await live(SPEAKER, COACH, [sse('OK')]);
    theirs.receive(...heard('item_1', 'そうそうそう、それが好きなんですよ。'));
    await theirs.settled();
    // Their sentence is over; the user says it after them, to practise.
    mine.receive(...heard('item_1', 'そうそうそう、それが好きなんですよ。'));
    await mine.settled();
    expect(mine.calls).toHaveLength(1);
    await theirs.session.stop();
    await mine.session.stop();
  });

  it('is coached with the user\'s own prompt when there is one: the pair filled in, no examples', async () => {
    const h = await live(SPEAKER, { ...COACH, coachPrompt: '只检查{{SPOKEN}}的敬语，用{{NATIVE}}回答。' }, [sse('✓')]);
    h.receive(...heard('item_1', 'ありがとう'));
    await h.settled();
    expect(h.calls[0].body.messages).toHaveLength(2);
    expect(h.calls[0].body.messages[0].content).toMatch(/^只检查日语的敬语，用.*中文.*回答。$/);
  });

  it('still translates what they type, with the translation model', async () => {
    const h = await live(SPEAKER, COACH, [sse('経費精算')]);
    h.session.appendText('报销');
    await h.settled();
    expect(h.calls[0].body.model).toBe('hy-mt2-1.8b');
    expect(h.lastText(FIRST_REF + 2)).toEqual({ ref: FIRST_REF + 2, text: '経費精算' });
  });

  it('is refused while the feedback has no model to run on, and takes typed text whenever something can translate it', () => {
    // The other device does not say what its models are for: nothing is run on a guess.
    expect(buildLocalAI(SPEAKER, { ...LOCALAI_DEFAULTS, coach: true }, shared)).toMatchObject({ code: 'coach_unnamed' });
    // One that does: its first text model gives the feedback, and translates what is typed.
    const told = { ...shared, models: [{ id: 'gpt-realtime', kind: 'pipeline' as const }, { id: 'hy-mt2-1.8b', kind: 'text' as const }] };
    expect(buildLocalAI(SPEAKER, { ...LOCALAI_DEFAULTS, coach: true }, told)).toMatchObject({ stages: { speech: { kind: 'coach', model: 'hy-mt2-1.8b', baseUrl: '' }, typed: { kind: 'translate', model: 'hy-mt2-1.8b' } } });
    // An API of its own, with its own key; nothing then translates what is typed, and the run still starts.
    expect(buildLocalAI(SPEAKER, { ...LOCALAI_DEFAULTS, coach: true, coachAt: 'api', coachModel: 'gpt-x', coachBaseUrl: 'http://localhost:11434/v1', coachNeedsKey: true }, shared))
      .toMatchObject({ stages: { speech: { kind: 'coach', model: 'gpt-x', baseUrl: 'http://localhost:11434/v1', key: 'coachKey' }, typed: null } });
    // A service whose models think before they answer is asked not to: with the feedback, and with a translation.
    const deepseek = buildLocalAI(SPEAKER, { ...LOCALAI_DEFAULTS, coach: true, coachAt: 'api', coachModel: 'deepseek-flash', coachBaseUrl: 'https://api.deepseek.com/v1', coachNeedsKey: true, translateAt: 'api', translateBaseUrl: 'https://api.deepseek.com/v1', translateModel: 'deepseek-flash', translateNeedsKey: true }, shared);
    expect(deepseek).toMatchObject({ stages: { speech: { kind: 'coach', extra: { thinking: { type: 'disabled' } } }, typed: { kind: 'translate', extra: { thinking: { type: 'disabled' } } } } });
    const other = buildLocalAI(SPEAKER, { ...LOCALAI_DEFAULTS, coach: true, coachAt: 'api', coachModel: 'gpt-x', coachBaseUrl: 'https://api.openai.com/v1', coachNeedsKey: true }, shared);
    if ('refused' in other) throw new Error(other.refused);
    expect(other.stages?.speech).not.toHaveProperty('extra');
    expect(localaiProvider.textInput({ ...LOCALAI_DEFAULTS, coach: true })).toBe(true);
    expect(localaiProvider.textInput({ ...LOCALAI_DEFAULTS, coach: true, translateAt: 'api' })).toBe(false);
    expect(localaiProvider.textInput(LOCALAI_DEFAULTS)).toBe(true);
  });

  it('leaves the participant leg alone: it hears the other side and translates, by the device\'s pipeline or the model named', () => {
    const server = buildLocalAI(PARTICIPANT, { ...LOCALAI_DEFAULTS, coach: true, coachServerModel: 'qwen3-4b' }, shared);
    expect(server).not.toHaveProperty('stages');
    expect(server).toMatchObject({ transcription: { language: 'ja' } });
    const model = buildLocalAI(PARTICIPANT, { ...LOCALAI_DEFAULTS, ...COACH }, shared);
    expect(model).toMatchObject({ transcribeOnly: true, stages: { speech: { kind: 'translate', model: 'hy-mt2-1.8b' } } });
  });

  it('shows feedback that only approves as a bare ✓, and leaves a translation as written', () => {
    expect(tidyAnswer('coach', '✓')).toBe('✓');
    expect(tidyAnswer('coach', '✓ 很自然。')).toBe('✓');
    expect(tidyAnswer('coach', 'OK')).toBe('✓');
    expect(tidyAnswer('coach', '\n昨日映画を見ました。\n\n  “见”要用过去式。 ')).toBe('昨日映画を見ました。\n“见”要用过去式。');
    expect(tidyAnswer('coach', '1. 昨日映画を見ました。  \n2. 动词时态与过去时间不符。')).toBe('昨日映画を見ました。\n动词时态与过去时间不符。');
    expect(tidyAnswer('translate', ' こんにちは ')).toBe('こんにちは');
    expect(tidyAnswer('translate', '{"translation":"こんにちは"}')).toBe('こんにちは');
  });
});

describe('a stage one of this computer\u2019s native engines answers', () => {
  it('asks where the engine is before each request: a restart on another port loses nothing', async () => {
    const config = buildLocalAI(SPEAKER, { ...LOCALAI_DEFAULTS, ...VIA_MODEL }, shared);
    if ('refused' in config) throw new Error(config.refused);
    const speech = config.stages?.speech as { engine?: string; baseUrl: string; model: string };
    speech.engine = 'translator';
    speech.baseUrl = 'http://127.0.0.1:4200/v1';
    const sockets = fakeSockets();
    const { clock } = trackedClock();
    const { events } = recordEvents();
    const urls: string[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => { urls.push(String(input)); keys.push(new Headers(init?.headers).get('Authorization')); return sse('你好。'); });
    let port = 4200;
    const keys: Array<string | null> = [];
    const base = vi.fn(async (_engine: 'translator' | 'coach', _model: string) => ({ base: `http://127.0.0.1:${port}/v1`, key: `key-of-${port}` }));
    const starting = createPipelineAdapter({ openSocket: sockets.create, fetch: fetch as unknown as typeof globalThis.fetch, native: { bridge: {} as never, start: async () => { throw new Error('unused'); }, base } }).start({ context: SPEAKER, config, credentials: K, clock, signal: new AbortController().signal }, events);
    const socket = sockets.last();
    socket.open('');
    socket.receive(SERVER.created());
    socket.receive(SERVER.updated(config.transcribeOnly ? 'transcription' : 'realtime'));
    const session = await starting;
    for (const frame of heard('item_1', '今天天气真好。')) socket.receive(frame);
    await vi.waitFor(() => expect(urls).toHaveLength(1));
    expect(urls[0]).toBe('http://127.0.0.1:4200/v1/chat/completions');
    expect(base).toHaveBeenLastCalledWith('translator', speech.model);
    // The engine came back on another port: the next sentence goes there.
    port = 4311;
    for (const frame of heard('item_2', '谢谢你。')) socket.receive(frame);
    await vi.waitFor(() => expect(urls).toHaveLength(2));
    expect(urls[1]).toBe('http://127.0.0.1:4311/v1/chat/completions');
    // …with the key of that run: each start of the engine makes another.
    expect(keys.slice(0, 2)).toEqual(['Bearer key-of-4200', 'Bearer key-of-4311']);
    // Where it cannot be asked, the address the session was built with.
    base.mockRejectedValue(new Error('not up'));
    for (const frame of heard('item_3', '好的。')) socket.receive(frame);
    await vi.waitFor(() => expect(urls).toHaveLength(3));
    expect(urls[2]).toBe('http://127.0.0.1:4200/v1/chat/completions');
    await session.stop();
  });
});

describe('a stretch of several sentences, of a leg that translates what it hears', () => {
  // The recognizer goes on hearing one stretch; the leg closes its finished sentences as they come (`sentenceCut.ts`).
  const delta = (text: string) => SERVER.inputDelta('item_1', text);

  it('closes a finished sentence once the speaker has gone on and it has stood a moment, and answers it at once', async () => {
    const h = await live(PARTICIPANT, VIA_MODEL, [sse('这个季节的东西是什么来着？'), sse('对啊，会想到新年呢。')]);
    h.receive(SERVER.committed('item_1'), delta('でこの季節のものなんだっけ？'));
    // The last thing said: its mark may yet be rewritten.
    expect(h.calls).toHaveLength(0);
    h.receive(delta('そうだ'));
    // Gone on from — but only just seen so.
    expect(h.calls).toHaveLength(0);
    h.clock.advance(400);
    h.receive(delta('ね、'));
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    expect(h.calls[0].body.messages[1].content).toBe('でこの季節のものなんだっけ？');
    // The sentence is the stretch's own segment, closed with its text; what follows shows in a new one.
    expect(h.lastText(1)?.text).toBe('でこの季節のものなんだっけ？');
    const sources = h.of('segmentOpened').map((e) => e.payload).filter((p) => p.side === 'source').map((p) => p.ref);
    expect(sources).toHaveLength(2);
    const rest = sources[1];
    expect(rest).toBeGreaterThan(FIRST_REF);
    expect(h.lastText(rest)?.text).toBe('そうだね、');
    // The stretch ends: what is left of it is the last sentence, answered as any.
    h.receive(SERVER.inputDone('item_1', 'でこの季節のものなんだっけ？そうだね、やっぱりお正月だね。'));
    await h.settled();
    expect(h.calls.map((c) => c.body.messages[1].content)).toEqual(['でこの季節のものなんだっけ？', 'そうだね、やっぱりお正月だね。']);
    expect(h.lastText(rest)?.text).toBe('そうだね、やっぱりお正月だね。');
    // Each answer is paired with its own sentence.
    const opened = h.of('segmentOpened').map((e) => e.payload);
    const closedOrigin = (ref: number) => h.of('segmentClosed').find((e) => e.payload.ref === ref)?.payload.origin ?? opened.find((p) => p.ref === ref)?.origin;
    const answers = opened.filter((p) => p.side === 'translation');
    expect(answers.map((p) => p.origin)).toEqual([closedOrigin(1), closedOrigin(rest)]);
    expect(new Set(answers.map((p) => p.origin)).size).toBe(2);
  });

  it('does not close a sentence the recognizer is still rewriting', async () => {
    const h = await live(PARTICIPANT, VIA_MODEL, [sse('一'), sse('二')]);
    h.receive(SERVER.committed('item_1'), delta('今日は本当に寒いですね。明日'));
    h.clock.advance(300);
    h.receive(delta('も'));
    // Stood 300 ms: not yet.
    expect(h.calls).toHaveLength(0);
    h.clock.advance(300);
    h.receive(delta('寒い'));
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    expect(h.calls[0].body.messages[1].content).toBe('今日は本当に寒いですね。');
  });

  it('closes nothing more where the stretch ends right after its last sentence', async () => {
    const h = await live(PARTICIPANT, VIA_MODEL, [sse('一')]);
    h.receive(SERVER.committed('item_1'), delta('今日は本当に寒いですね。それ'));
    h.clock.advance(400);
    h.receive(delta('で'));
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    // The recognizer's last word on the stretch takes the three letters back.
    h.receive(SERVER.inputDone('item_1', '今日は本当に寒いですね。'));
    await h.settled();
    expect(h.calls).toHaveLength(1);
    const rest = h.of('segmentOpened').map((e) => e.payload).filter((p) => p.side === 'source')[1].ref;
    expect(h.lastText(rest)?.text).toBe('');
    expect(h.of('segmentClosed').map((e) => e.payload.ref)).toContain(rest);
  });

  it('answers a stretch whole where the recognizer writes it all at once', async () => {
    const h = await live(PARTICIPANT, VIA_MODEL, [sse('好')]);
    h.receive(...heard('item_1', '今日は本当に寒いですね。明日も寒いそうです。'));
    await h.settled();
    expect(h.calls.map((c) => c.body.messages[1].content)).toEqual(['今日は本当に寒いですね。明日も寒いそうです。']);
    expect(h.of('segmentOpened').map((e) => e.payload)).toEqual([
      { ref: 1, side: 'source', origin: 'item_1' },
      { ref: FIRST_REF + 1, side: 'translation', origin: 'item_1' },
    ]);
  });
});

describe('a coached speaker’s stretch of several sentences', () => {
  it('is answered whole: the feedback is on what they said', async () => {
    const h = await live(SPEAKER, { coach: true, coachServerModel: 'qwen3-4b', translateServerModel: 'hy-mt2-1.8b' }, [sse('✓')]);
    h.receive(SERVER.committed('item_1'), SERVER.inputDelta('item_1', '昨日映画を見ました。とても'));
    h.clock.advance(500);
    h.receive(SERVER.inputDelta('item_1', '面白かった'));
    h.clock.advance(500);
    h.receive(SERVER.inputDelta('item_1', 'です。'));
    expect(h.calls).toHaveLength(0);
    expect(h.of('segmentOpened').filter((e) => e.payload.side === 'source')).toHaveLength(1);
  });
});

describe('a sentence the speaker stops at, the stretch still open', () => {
  it('is not closed, however long the stop: the recognizer ends whatever it has heard so far with a full stop', async () => {
    // Closing it after 0.9 s was tried and cut "お正月の。" from "イメージあるよね。" (measured 2026-10-06).
    const h = await live(PARTICIPANT, VIA_MODEL, [sse('是啊，会想到新年呢。')]);
    h.receive(SERVER.committed('item_1'), SERVER.inputDelta('item_1', 'そうだね、やっぱりお正月の。'));
    h.clock.advance(5000);
    expect(h.calls).toHaveLength(0);
    expect(h.clock.pending()).toBe(0);
    expect(h.of('segmentClosed')).toHaveLength(0);
    h.receive(SERVER.inputDone('item_1', 'そうだね、やっぱりお正月のイメージあるよね。'));
    await h.settled();
    expect(h.calls.map((c) => c.body.messages[1].content)).toEqual(['そうだね、やっぱりお正月のイメージあるよね。']);
  });
});
