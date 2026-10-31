import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionContext } from '../../lib/contract/adapter';
import { createVirtualClock } from '../../lib/contract/clock';
import { Conversation } from '../../lib/conversation/Conversation';
import { recordEvents, type AdapterEvent } from '../../lib/contract/events';
import { flush } from '../../lib/contract/testing/drive';
import { fakeSockets } from '../../lib/contract/testing/fakeSocket';
import { LAN_PIPELINE } from '../../lib/lan/protocol';
import { LanTranscriber, type RecognitionModel } from '../../lib/lan/transcriber';
import { createFakeEngines } from '../localInference/fakeEngines';
import { buildLocalAI, LOCALAI_DEFAULTS, type LocalAISettings } from './localai';
import type { LocalAIModel } from './localaiModels';
import { createPipelineAdapter } from './pipeline';
import { SHARED } from './testing';

const SPEAKER: SessionContext = { direction: { source: 'en', target: 'fr' }, speech: false, turns: 'auto' };
const PARTICIPANT: SessionContext = { direction: { source: 'fr', target: 'en' }, speech: false, turns: 'auto' };
const MODELS: LocalAIModel[] = [
  { id: LAN_PIPELINE, host: 'kotomimi', kind: 'pipeline' },
  { id: 'apple-speech:en', host: 'kotomimi', kind: 'asr', languages: ['en'], bilingual: true },
  { id: 'apple-speech:fr', host: 'kotomimi', kind: 'asr', languages: ['fr'], bilingual: true },
  { id: 'translation-model', host: 'kotomimi', kind: 'translate', languages: ['en', 'fr'] },
  { id: 'feedback-model', host: 'kotomimi', kind: 'feedback', languages: ['en', 'fr'] },
];
const ENGLISH = 'We will meet near the station tomorrow. Everyone should bring a notebook for the lesson';
const FRENCH = 'Nous allons nous retrouver demain matin. Chaque personne apporte un cahier pour la lecon';
const stops: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

interface TextCall {
  url: string;
  body: { model: string; source_language?: string; target_language?: string; messages: Array<{ role: string; content: string }> };
}

/** The real client and LAN server exchange JSON; only the Mac's ASR and text-model answers are simulated. */
async function live(context: SessionContext, patch: Partial<LocalAISettings>, wire = (event: Record<string, unknown>) => event) {
  const config = buildLocalAI(context, {
    ...LOCALAI_DEFAULTS,
    model: LAN_PIPELINE,
    asrModel: 'apple-speech:en',
    translateServerModel: 'translation-model',
    coachServerModel: 'feedback-model',
    translateBySentence: true,
    ...patch,
  }, { ...SHARED, models: MODELS, reversed: (direction) => direction.source === 'fr' });
  if ('refused' in config) throw new Error(config.refused);
  const { events, log } = recordEvents();
  const clock = createVirtualClock(0);
  const fakes = createFakeEngines();
  const sockets = fakeSockets();
  const calls: TextCall[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as TextCall['body'];
    calls.push({ url: String(input), body });
    const content = body.model === 'feedback-model' ? 'Your sentence is clear.' : `Translation into ${body.target_language}`;
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { headers: { 'Content-Type': 'application/json' } });
  });
  const starting = createPipelineAdapter({ openSocket: sockets.create, fetch }).start({
    context, config, credentials: { apiKey: '', endpoint: 'ws://mac.local:8792/v1/realtime' }, clock, signal: new AbortController().signal,
  }, events);
  const socket = sockets.last();
  const serverEvents: Array<Record<string, unknown>> = [];
  const resolve = vi.fn((language: string, wanted: string, also?: string): RecognitionModel | null => {
    const primary = MODELS.find((model) => model.id === wanted && model.languages?.includes(language));
    const secondary = MODELS.find((model) => model.id === `apple-speech:${also}` && model.bilingual);
    return primary?.bilingual && secondary && also ? { modelId: primary.id, streaming: true, also } : null;
  });
  const recognizer = vi.fn((_model: RecognitionModel) => fakes.asr);
  const server = new LanTranscriber({
    clock, resolve, recognizer,
    send: (event) => {
      serverEvents.push(event);
      const delivered = wire(event);
      queueMicrotask(() => { if (socket.readyState === socket.OPEN) socket.receive(JSON.stringify(delivered)); });
    },
    close: (code, reason) => socket.serverClose(code, reason),
  }, 'mac_session', LAN_PIPELINE);
  const send = socket.send.bind(socket);
  vi.spyOn(socket, 'send').mockImplementation((data) => {
    send(data);
    if (typeof data === 'string') queueMicrotask(() => server.receive(data));
  });
  socket.open();
  server.open();
  const session = await starting.catch((error: unknown) => { server.dispose(); throw error; });
  fakes.asr.ready();
  await flush();
  stops.push(async () => { await session.stop(); server.dispose(); });
  const of = <K extends AdapterEvent['kind']>(kind: K) => log.filter((event): event is Extract<AdapterEvent, { kind: K }> => event.kind === kind);
  const lastText = (ref: number) => of('segmentText').filter((event) => event.payload.ref === ref).pop()?.payload;
  const settled = (count: number) => vi.waitFor(() => {
    expect(calls).toHaveLength(count);
    expect(of('busy').map((event) => event.payload).pop()).toBe(false);
  });
  return { config, socket, serverEvents, resolve, recognizer, asr: fakes.asr, clock, calls, of, lastText, settled, log };
}

type Live = Awaited<ReturnType<typeof live>>;

function expectPair(h: Live, primary: string, secondary: string) {
  const sent = h.socket.sentJson<{ type: string; session: { type: string; audio: { input: { transcription: unknown } } } }>();
  expect(sent.map((event) => event.type)).toEqual(['session.update']);
  expect(sent[0].session.type).toBe('transcription');
  expect(sent[0].session.audio.input.transcription).toEqual({ model: `apple-speech:${primary}`, language: primary, languages: [primary, secondary] });
  expect(h.resolve).toHaveBeenCalledTimes(1);
  expect(h.resolve).toHaveBeenCalledWith(primary, `apple-speech:${primary}`, secondary);
  expect(h.recognizer).toHaveBeenCalledWith({ modelId: `apple-speech:${primary}`, streaming: true, also: secondary });
  expect(h.asr.inits[0]).toMatchObject({ modelId: `apple-speech:${primary}`, options: { language: primary, punctuationEndpoint: true } });
  expect(h.config.stages?.requiresLanguage).toBe(true);
}

/** The second growing partial has stood long enough to cut a sentence if final language gating is lost. */
async function tentative(h: Live, ref: number, text: string) {
  const calls = h.calls.length;
  h.asr.speechStart();
  h.asr.partial(text.slice(0, text.lastIndexOf(' ')));
  h.asr.partial(text);
  await flush();
  h.clock.advance(1000);
  h.asr.partial(`${text} later`);
  await flush();
  expect(h.lastText(ref)).toEqual({ ref, text });
  expect(h.calls).toHaveLength(calls);
  expect(h.of('segmentClosed').map((event) => event.payload.ref)).not.toContain(ref);
}

function expectHeard(h: Live, ref: number, text: string, language: string) {
  expect(h.lastText(ref)).toEqual({ ref, text, language });
  expect(h.of('segmentOpened').find((event) => event.payload.ref === ref)?.payload).toEqual({
    ref, side: 'source', origin: `item_mac_session_${ref}`,
  });
  expect(h.serverEvents).toContainEqual({
    type: 'conversation.item.input_audio_transcription.completed', item_id: `item_mac_session_${ref}`, content_index: 0, transcript: text, language,
  });
}

const userText = (call: TextCall) => call.body.messages[call.body.messages.length - 1].content;

describe('paired Apple recognition across the LAN wire and client pipeline', () => {
  it('translates both directions with grammar feedback attached only to spoken foreign sentences', async () => {
    const h = await live(SPEAKER, { speakBoth: true, coach: true });
    expectPair(h, 'en', 'fr');
    expect(h.config.stages).toMatchObject({ heard: 'auto', feedback: { language: 'fr', stage: { kind: 'coach' } } });
    await tentative(h, 1, FRENCH);
    h.asr.final(FRENCH, 'fr');
    await h.settled(2);
    expectHeard(h, 1, FRENCH, 'fr');
    expect(h.calls.map((call) => call.body.model)).toEqual(['translation-model', 'feedback-model']);
    expect(h.calls[0].body).toMatchObject({ source_language: 'fr', target_language: 'en' });
    expect(h.calls.map(userText)).toEqual([FRENCH, FRENCH]);
    const answers = h.of('segmentOpened').filter((event) => event.payload.side === 'translation');
    expect(answers.map((event) => ({ origin: event.payload.origin, purpose: event.payload.purpose }))).toEqual([
      { origin: 'item_mac_session_1', purpose: 'translation' },
      { origin: 'item_mac_session_1', purpose: 'feedback' },
    ]);
    expect(new Set(answers.map((event) => event.payload.ref)).size).toBe(2);
    expect(answers.find((event) => event.payload.purpose === 'feedback')?.payload.accompaniesTranslation).toBe(true);

    await tentative(h, 2, ENGLISH);
    h.asr.final(ENGLISH, 'en');
    await h.settled(3);
    expectHeard(h, 2, ENGLISH, 'en');
    expect(h.calls[2].body).toMatchObject({ model: 'translation-model', source_language: 'en', target_language: 'fr' });
    expect(h.of('segmentOpened').filter((event) => event.payload.purpose === 'feedback')).toHaveLength(1);
  });

  it('rejects a legacy server that acknowledges only the primary language', async () => {
    await expect(live(SPEAKER, { speakBoth: true }, (event) => {
      if (event.type !== 'session.updated') return event;
      const session = event.session as { audio: { input: { transcription: Record<string, unknown> } } };
      const { languages: _languages, ...transcription } = session.audio.input.transcription;
      return { ...event, session: { ...session, audio: { ...session.audio, input: { ...session.audio.input, transcription } } } };
    })).rejects.toMatchObject({ code: 'server_no_bilingual', params: { source: 'en', target: 'fr' } });
  });

  it.each([undefined, 'de'])('reports a paired final with invalid wire language (%j) and translates the next valid utterance', async (language) => {
    let corrupted = false;
    const h = await live(SPEAKER, { speakBoth: true, coach: true }, (event) => {
      if (event.type !== 'conversation.item.input_audio_transcription.completed' || corrupted) return event;
      corrupted = true;
      return { ...event, language };
    });
    await tentative(h, 1, FRENCH);
    h.asr.final(FRENCH, 'fr');
    await flush();
    expect(h.calls).toEqual([]);
    expect(h.lastText(1)).toEqual({ ref: 1, text: '' });
    expect(h.of('segmentClosed').map((event) => event.payload.ref)).toContain(1);
    expect(h.of('degraded').map((event) => event.payload)).toEqual([{
      code: 'transcription_failed', reason: 'bilingual_final_invalid', message: expect.any(String),
    }]);
    expect(h.of('failed')).toEqual([]);
    expect(h.socket.closedByClient).toBeNull();

    await tentative(h, 2, ENGLISH);
    h.asr.final(ENGLISH, 'en');
    await h.settled(1);
    expectHeard(h, 2, ENGLISH, 'en');
    expect(h.calls[0].body).toMatchObject({ model: 'translation-model', source_language: 'en', target_language: 'fr' });
    expect(userText(h.calls[0])).toBe(ENGLISH);
  });

  it('does not translate partial words after an empty paired ASR final and recovers on the next utterance', async () => {
    const h = await live(SPEAKER, { speakBoth: true });
    await tentative(h, 1, FRENCH);
    h.asr.final('   ', 'fr');
    await flush();
    expect(h.calls).toEqual([]);
    expect(h.lastText(1)).toEqual({ ref: 1, text: '' });
    expect(h.of('segmentClosed').map((event) => event.payload.ref)).toContain(1);
    expect(h.serverEvents).toContainEqual({
      type: 'conversation.item.input_audio_transcription.failed', item_id: 'item_mac_session_1', content_index: 0,
      error: expect.objectContaining({ code: 'transcription_failed' }),
    });
    expect(h.serverEvents.filter((event) => event.type === 'conversation.item.input_audio_transcription.completed')).toEqual([]);
    expect(h.of('degraded').map((event) => event.payload.code)).toEqual(['transcription_failed']);
    expect(h.of('frame').some((event) => event.payload.type === 'conversation.item.input_audio_transcription.failed')).toBe(true);
    const conversation = new Conversation({ leg: 'speaker', session: 'test', languages: { source: 'en', target: 'fr' }, clock: h.clock });
    h.log.forEach((event) => conversation.apply(event));
    expect(conversation.snapshot().notices).toEqual([]);
    expect(conversation.snapshot().segments).toMatchObject([{ text: '', final: true }]);
    expect(h.of('failed')).toEqual([]);
    expect(h.socket.closedByClient).toBeNull();

    await tentative(h, 2, ENGLISH);
    h.asr.final(ENGLISH, 'en');
    await h.settled(1);
    expectHeard(h, 2, ENGLISH, 'en');
    expect(h.calls[0].body).toMatchObject({ model: 'translation-model', source_language: 'en', target_language: 'fr' });
    expect(userText(h.calls[0])).toBe(ENGLISH);
  });

  it('translates either language into the other on a speaker with speakBoth enabled', async () => {
    const h = await live(SPEAKER, { speakBoth: true });
    expectPair(h, 'en', 'fr');
    await tentative(h, 1, ENGLISH);
    h.asr.final(ENGLISH, 'en');
    await h.settled(1);
    expectHeard(h, 1, ENGLISH, 'en');
    expect(h.calls[0]).toMatchObject({
      url: 'http://mac.local:8792/v1/chat/completions',
      body: { model: 'translation-model', source_language: 'en', target_language: 'fr' },
    });
    expect(userText(h.calls[0])).toBe(ENGLISH);

    await tentative(h, 2, FRENCH);
    h.asr.final(FRENCH, 'fr');
    await h.settled(2);
    expectHeard(h, 2, FRENCH, 'fr');
    expect(h.calls[1].body).toMatchObject({ model: 'translation-model', source_language: 'fr', target_language: 'en' });
    expect(userText(h.calls[1])).toBe(FRENCH);
    const answers = h.of('segmentOpened').filter((event) => event.payload.side === 'translation').map((event) => event.payload);
    expect(answers.map((answer) => answer.origin)).toEqual(['item_mac_session_1', 'item_mac_session_2']);
    expect(h.lastText(answers[1].ref)).toMatchObject({ text: 'Translation into en', language: 'en' });
    expect(h.of('degraded')).toEqual([]);
    expect(h.of('failed')).toEqual([]);
  });

  it.each([false, true])('translates French and leaves English as said on the participant leg (speaker feedback: %s)', async (coach) => {
    const h = await live(PARTICIPANT, { speakBoth: true, coach });
    expect(h.config.stages?.feedback).toBeUndefined();
    expectPair(h, 'fr', 'en');
    await tentative(h, 1, FRENCH);
    h.asr.final(FRENCH, 'fr');
    await h.settled(1);
    expectHeard(h, 1, FRENCH, 'fr');
    expect(h.calls[0].body).toMatchObject({ model: 'translation-model', source_language: 'fr', target_language: 'en' });
    expect(userText(h.calls[0])).toBe(FRENCH);

    await tentative(h, 2, ENGLISH);
    h.asr.final(ENGLISH, 'en');
    await flush();
    expectHeard(h, 2, ENGLISH, 'en');
    expect(h.calls).toHaveLength(1);
    expect(h.of('segmentClosed').map((event) => event.payload.ref)).toContain(2);
    expect(h.of('segmentOpened').filter((event) => event.payload.side === 'translation').map((event) => event.payload.origin)).toEqual(['item_mac_session_1']);
    expect(h.of('degraded')).toEqual([]);
    expect(h.of('failed')).toEqual([]);
  });

  it('sends French for feedback and English for translation on a coached speaker', async () => {
    const h = await live(SPEAKER, { coach: true });
    expectPair(h, 'fr', 'en');
    await tentative(h, 1, FRENCH);
    h.asr.final(FRENCH, 'fr');
    await h.settled(1);
    expectHeard(h, 1, FRENCH, 'fr');
    expect(h.calls[0].body.model).toBe('feedback-model');
    expect(userText(h.calls[0])).toBe(FRENCH);
    const feedback = h.of('segmentOpened').find((event) => event.payload.side === 'translation')!.payload;
    expect(feedback.origin).toBe('item_mac_session_1');
    expect(h.lastText(feedback.ref)).toEqual({ ref: feedback.ref, text: 'Your sentence is clear.', language: 'en' });

    await tentative(h, 2, ENGLISH);
    h.asr.final(ENGLISH, 'en');
    await h.settled(2);
    expectHeard(h, 2, ENGLISH, 'en');
    expect(h.calls[1].body).toMatchObject({ model: 'translation-model', source_language: 'en', target_language: 'fr' });
    expect(userText(h.calls[1])).toBe(ENGLISH);
    expect(h.calls.map((call) => call.body.model)).toEqual(['feedback-model', 'translation-model']);
    expect(h.of('degraded')).toEqual([]);
    expect(h.of('failed')).toEqual([]);
  });

  it('clears an unconfirmed practice guess before closing it so the chatbox cannot publish it', async () => {
    const h = await live(SPEAKER, { coach: true });
    await tentative(h, 1, FRENCH);
    h.asr.final(FRENCH);
    await flush();
    expect(h.lastText(1)).toEqual({ ref: 1, text: '' });
    expect(h.of('segmentClosed').map((event) => event.payload.ref)).toContain(1);
    expect(h.calls).toEqual([]);
    expect(h.of('degraded')).toHaveLength(1);
  });
});
