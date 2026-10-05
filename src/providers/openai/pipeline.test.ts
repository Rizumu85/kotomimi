import { describe, expect, it, vi } from 'vitest';
import type { SessionContext } from '../../lib/contract/adapter';
import { recordEvents, type AdapterEvent } from '../../lib/contract/events';
import { fakeSockets } from '../../lib/contract/testing/fakeSocket';
import { trackedClock } from '../../lib/contract/testing/trackedClock';
import { coachPrompt } from './coachPrompt';
import { buildLocalAI, LOCALAI_DEFAULTS, localaiProvider, type LocalAICredentials, type LocalAISettings } from './localai';
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
async function live(context: SessionContext, patch: Partial<LocalAISettings>, answers: Array<Response | Error | 'hang'> = [], credentials: LocalAICredentials = K) {
  const settings = { ...LOCALAI_DEFAULTS, ...patch };
  const config = buildLocalAI(context, settings, shared);
  if ('refused' in config) throw new Error(config.refused);
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
  return { config, socket, session, calls, log, of, lastText, settled, sent: () => socket.sentJson<Record<string, unknown>>(), receive: (...m: string[]) => { for (const x of m) socket.receive(x); } };
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
    h.receive(...heard('item_1', 'いち'));
    await h.settled();
    h.session.appendText('二');
    await h.settled();
    expect(h.of('degraded').map((e) => [e.payload.code, e.payload.message])).toEqual([
      ['translation_failed', 'The translation model (hy-mt2-1.8b) did not answer: Failed to fetch'],
      ['translation_unavailable', 'The translation model (hy-mt2-1.8b) did not answer: HTTP 404: model not found'],
    ]);
    expect(h.of('failed')).toEqual([]);
    // The next one is answered.
    h.receive(...heard('item_3', 'さん'));
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
