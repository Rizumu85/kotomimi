// @vitest-environment node
// electron/lan-upstream.test.js
//
// Fork: a model server on this computer, shared through the app's own door.
// The LocalAI here is a stand-in on the loopback — a real HTTP server and a
// real socket — and what `local-server.js` answers is handed in as it would
// answer it.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';
import { WebSocketServer } from 'ws';

const require = createRequire(import.meta.url);
const { createUpstream, withoutRecognizer, chatBody } = require('./lan-upstream.js');

/** What a LocalAI with one pipeline, three recognizers and two text models answers `pipelines()` with. */
const LOCALAI = () => ({
  pipelines: [{ name: 'gpt-realtime', transcription: 'apple-speech-transcriber', llm: 'hy-mt2-1.8b' }],
  recognizers: ['apple-speech-transcriber', 'whisper-large-turbo', 'qwen3-asr-mlx'],
  translators: ['hy-mt2-1.8b', 'qwen3-4b'],
});
const DOWN = { pipelines: [], recognizers: [], translators: [] };

const until = async (check) => {
  for (let i = 0; i < 300; i += 1) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('never happened');
};

let closers = [];
afterEach(async () => {
  await Promise.all(closers.map((close) => close()));
  closers = [];
});

/** The stand-in: records what it is asked, answers a chat as a stream, and announces each socket's session as a LocalAI does. */
async function standIn() {
  const seen = { chats: [], sockets: [], frames: [] };
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (c) => chunks.push(c));
    request.on('end', () => {
      seen.chats.push({ url: request.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('data: {"choices":[{"delta":{"content":"こん"}}]}\n\n');
      response.end('data: [DONE]\n\n');
    });
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws, request) => {
    seen.sockets.push({ url: request.url, ws });
    ws.on('message', (data) => seen.frames.push(JSON.parse(data.toString('utf8'))));
    ws.send(JSON.stringify({ type: 'session.created', session: { id: 'sess_localai' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise((done) => { for (const s of seen.sockets) s.ws.terminate(); wss.close(); server.close(() => done()); server.closeAllConnections?.(); }));
  return { port: server.address().port, seen };
}

function upstreamOf({ port = 1, found = LOCALAI(), setPipeline, now, configureTimeoutMs } = {}) {
  const pipelines = vi.fn(async () => found);
  const set = setPipeline ?? vi.fn(async (name, change) => { found.pipelines[0] = { ...found.pipelines[0], ...change }; return { ok: true }; });
  return { upstream: createUpstream({ port, pipelines, setPipeline: set, ...(now ? { now } : {}), ...(configureTimeoutMs ? { configureTimeoutMs } : {}) }), pipelines, setPipeline: set };
}

describe('what a model server on this computer adds to the lists', () => {
  it('is each recognizer and each text model, with what it is for — and never its pipeline', async () => {
    const { upstream } = upstreamOf();
    expect(await upstream.models()).toEqual([
      { id: 'apple-speech-transcriber', capabilities: ['transcript'] },
      { id: 'whisper-large-turbo', capabilities: ['transcript'] },
      { id: 'qwen3-asr-mlx', capabilities: ['transcript'] },
      { id: 'hy-mt2-1.8b', capabilities: ['chat'] },
      { id: 'qwen3-4b', capabilities: ['chat'] },
    ]);
  });

  it('is nothing while no model server answers, and is asked again only after a while', async () => {
    let clock = 0;
    const { upstream, pipelines } = upstreamOf({ found: DOWN, now: () => clock });
    expect(await upstream.models()).toEqual([]);
    await upstream.models();
    expect(pipelines).toHaveBeenCalledTimes(1);
    clock = 6000;
    await upstream.models();
    expect(pipelines).toHaveBeenCalledTimes(2);
  });

  it('is nothing when asking it throws', async () => {
    const upstream = createUpstream({ port: 1, pipelines: async () => { throw new Error('gone'); }, setPipeline: async () => ({ ok: false }) });
    expect(await upstream.models()).toEqual([]);
    expect(await upstream.chatModel('kotomimi')).toBeNull();
    expect(await upstream.recognizer('')).toBeNull();
  });
});

describe('whose a request is', () => {
  it('passes a chat request on when it names one of the server\'s text models, or leaves the choice to this computer', async () => {
    const { upstream } = upstreamOf();
    expect(await upstream.chatModel('qwen3-4b')).toBe('qwen3-4b');
    // Left to this computer: the app's pipeline name, the server's own, or none — the pipeline's text model answers.
    expect(await upstream.chatModel('kotomimi')).toBe('hy-mt2-1.8b');
    expect(await upstream.chatModel('gpt-realtime')).toBe('hy-mt2-1.8b');
    expect(await upstream.chatModel('')).toBe('hy-mt2-1.8b');
    expect(await upstream.chatModel(undefined)).toBe('hy-mt2-1.8b');
    // One of the app's own models is the page's.
    expect(await upstream.chatModel('bing-translator')).toBeNull();
  });

  it('joins a socket to the server when its session names one of the server\'s recognizers, or leaves the choice', async () => {
    const { upstream } = upstreamOf();
    expect(await upstream.recognizer('whisper-large-turbo')).toEqual({ pipeline: 'gpt-realtime', transcription: 'whisper-large-turbo' });
    expect(await upstream.recognizer('')).toEqual({ pipeline: 'gpt-realtime', transcription: '' });
    expect(await upstream.recognizer('kotomimi')).toEqual({ pipeline: 'gpt-realtime', transcription: '' });
    // One of the app's own recognizers is the page's.
    expect(await upstream.recognizer('sensevoice-int8')).toBeNull();
  });

  it('leaves everything to the page while no model server answers', async () => {
    const { upstream } = upstreamOf({ found: DOWN });
    expect(await upstream.chatModel('kotomimi')).toBeNull();
    expect(await upstream.recognizer('')).toBeNull();
  });
});

describe('a chat request passed on', () => {
  it('names the server\'s own model, drops what only a Kotomimi reads, and comes back as the stream it is', async () => {
    const { port, seen } = await standIn();
    const { upstream } = upstreamOf({ port });
    expect(chatBody({ model: 'kotomimi', stream: true, source_language: 'zh', target_language: 'ja', messages: [] }, 'hy-mt2-1.8b')).toEqual({ model: 'hy-mt2-1.8b', stream: true, messages: [] });
    // The door's response is a server response: a real one, on a real server.
    const door = http.createServer((request, response) => {
      upstream.complete({ model: 'kotomimi', stream: true, source_language: 'zh', target_language: 'ja', messages: [{ role: 'user', content: '你好' }] }, 'hy-mt2-1.8b', response, { 'X-Kotomimi-Name': 'DESK' });
    });
    await new Promise((resolve) => door.listen(0, '127.0.0.1', resolve));
    closers.push(() => new Promise((done) => { door.close(() => done()); door.closeAllConnections?.(); }));
    const answer = await fetch(`http://127.0.0.1:${door.address().port}/v1/chat/completions`, { method: 'POST' });
    expect(answer.status).toBe(200);
    expect(answer.headers.get('content-type')).toBe('text/event-stream');
    expect(answer.headers.get('x-kotomimi-name')).toBe('DESK');
    expect(await answer.text()).toBe('data: {"choices":[{"delta":{"content":"こん"}}]}\n\ndata: [DONE]\n\n');
    expect(seen.chats).toEqual([{ url: '/v1/chat/completions', body: { model: 'hy-mt2-1.8b', stream: true, messages: [{ role: 'user', content: '你好' }] } }]);
  });

  it('answers 502 in OpenAI\'s shape when the model server is not there', async () => {
    const { upstream } = upstreamOf({ port: 9 });
    const door = http.createServer((request, response) => upstream.complete({ messages: [] }, 'hy-mt2-1.8b', response));
    await new Promise((resolve) => door.listen(0, '127.0.0.1', resolve));
    closers.push(() => new Promise((done) => { door.close(() => done()); door.closeAllConnections?.(); }));
    const answer = await fetch(`http://127.0.0.1:${door.address().port}/`, { method: 'POST' });
    expect(answer.status).toBe(502);
    expect((await answer.json()).error.code).toBe('upstream_failed');
  });
});

describe('a socket joined to the model server', () => {
  const UPDATE = { type: 'session.update', session: { type: 'transcription', audio: { input: { transcription: { model: 'whisper-large-turbo', language: 'ja' }, turn_detection: { type: 'server_vad' } } } } };

  it('names the recognizer asked for in the pipeline first, then opens a session that names none', async () => {
    const { port, seen } = await standIn();
    const { upstream, setPipeline } = upstreamOf({ port });
    expect(withoutRecognizer(UPDATE).session.audio.input.transcription).toEqual({ language: 'ja' });
    const sent = [];
    const link = upstream.bridge({ pipeline: 'gpt-realtime', transcription: 'whisper-large-turbo' }, { update: UPDATE, send: (t) => sent.push(JSON.parse(t)), close: vi.fn() });
    // Audio that comes before the server's session is up waits for it, in order.
    link.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: 'AAAA' }));
    await until(() => seen.frames.length === 2);
    expect(setPipeline).toHaveBeenCalledWith('gpt-realtime', { transcription: 'whisper-large-turbo' });
    expect(seen.sockets[0].url).toBe('/v1/realtime?model=gpt-realtime');
    expect(seen.frames[0]).toEqual({ type: 'session.update', session: { type: 'transcription', audio: { input: { transcription: { language: 'ja' }, turn_detection: { type: 'server_vad' } } } } });
    expect(seen.frames[1]).toEqual({ type: 'input_audio_buffer.append', audio: 'AAAA' });
    // The server's own announcement stays behind: the device was told its session began already.
    expect(sent).toEqual([]);
    seen.sockets[0].ws.send(JSON.stringify({ type: 'session.updated' }));
    await until(() => sent.length === 1);
    expect(sent[0]).toEqual({ type: 'session.updated' });
    link.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    await until(() => seen.frames.length === 3);
    link.close();
  });

  it('changes nothing in the pipeline when it names that recognizer already, or the choice is left to it', async () => {
    const { port, seen } = await standIn();
    const { upstream, setPipeline } = upstreamOf({ port });
    const a = upstream.bridge({ pipeline: 'gpt-realtime', transcription: 'apple-speech-transcriber' }, { update: UPDATE, send: () => {}, close: () => {} });
    const b = upstream.bridge({ pipeline: 'gpt-realtime', transcription: '' }, { update: UPDATE, send: () => {}, close: () => {} });
    await until(() => seen.frames.length === 2);
    expect(setPipeline).not.toHaveBeenCalled();
    a.close();
    b.close();
  });

  it('asks once for two sockets that want the same recognizer at the same time: a run\'s two legs', async () => {
    const { port, seen } = await standIn();
    const { upstream, setPipeline } = upstreamOf({ port });
    const route = { pipeline: 'gpt-realtime', transcription: 'qwen3-asr-mlx' };
    const a = upstream.bridge(route, { update: UPDATE, send: () => {}, close: () => {} });
    const b = upstream.bridge(route, { update: UPDATE, send: () => {}, close: () => {} });
    await until(() => seen.frames.length === 2);
    expect(setPipeline).toHaveBeenCalledTimes(1);
    a.close();
    b.close();
  });

  it('sets up a session that names another recognizer only once the server has answered the earlier one\'s settings', async () => {
    const { port, seen } = await standIn();
    const { upstream, setPipeline } = upstreamOf({ port });
    const a = upstream.bridge({ pipeline: 'gpt-realtime', transcription: 'whisper-large-turbo' }, { update: UPDATE, send: () => {}, close: () => {} });
    const b = upstream.bridge({ pipeline: 'gpt-realtime', transcription: 'qwen3-asr-mlx' }, { update: UPDATE, send: () => {}, close: () => {} });
    await until(() => seen.frames.length === 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(setPipeline.mock.calls.map((c) => c[1].transcription)).toEqual(['whisper-large-turbo']);
    expect(seen.sockets).toHaveLength(1);
    // The server's answer to the first session's settings: the second goes ahead.
    seen.sockets[0].ws.send(JSON.stringify({ type: 'session.updated' }));
    await until(() => seen.sockets.length === 2 && seen.frames.length === 2);
    expect(setPipeline.mock.calls.map((c) => c[1].transcription)).toEqual(['whisper-large-turbo', 'qwen3-asr-mlx']);
    // A refusal of the settings ends a turn too, and so does a limit when the server answers nothing.
    const c = upstream.bridge({ pipeline: 'gpt-realtime', transcription: 'whisper-large-turbo' }, { update: UPDATE, send: () => {}, close: () => {} });
    await new Promise((r) => setTimeout(r, 50));
    expect(seen.sockets).toHaveLength(2);
    seen.sockets[1].ws.send(JSON.stringify({ type: 'error', error: { message: 'no' } }));
    await until(() => seen.sockets.length === 3);
    a.close();
    b.close();
    c.close();
  });

  it('lets the next session go after a limit when the server never answers the settings, and at once when the device goes', async () => {
    const { port, seen } = await standIn();
    const limited = upstreamOf({ port, configureTimeoutMs: 100 });
    const a = limited.upstream.bridge({ pipeline: 'gpt-realtime', transcription: 'whisper-large-turbo' }, { update: UPDATE, send: () => {}, close: () => {} });
    const b = limited.upstream.bridge({ pipeline: 'gpt-realtime', transcription: 'qwen3-asr-mlx' }, { update: UPDATE, send: () => {}, close: () => {} });
    await until(() => seen.sockets.length === 2);
    expect(limited.setPipeline).toHaveBeenCalledTimes(2);
    a.close();
    b.close();
    // With the limit far off (30 s), only the device going lets the next one go.
    const { upstream } = upstreamOf({ port });
    const c = upstream.bridge({ pipeline: 'gpt-realtime', transcription: 'whisper-large-turbo' }, { update: UPDATE, send: () => {}, close: () => {} });
    await until(() => seen.sockets.length === 3);
    const d = upstream.bridge({ pipeline: 'gpt-realtime', transcription: 'qwen3-asr-mlx' }, { update: UPDATE, send: () => {}, close: () => {} });
    await new Promise((r) => setTimeout(r, 50));
    expect(seen.sockets).toHaveLength(3);
    c.close();
    await until(() => seen.sockets.length === 4);
    d.close();
  });

  it('tells the device why, and closes, when the recognizer cannot be chosen or the server goes', async () => {
    const { port, seen } = await standIn();
    const refused = upstreamOf({ port, setPipeline: vi.fn(async () => ({ ok: false, error: 'LocalAI lists no such model for that stage.' })) });
    const sent = [];
    const close = vi.fn();
    refused.upstream.bridge({ pipeline: 'gpt-realtime', transcription: 'whisper-large-turbo' }, { update: UPDATE, send: (t) => sent.push(JSON.parse(t)), close });
    await until(() => close.mock.calls.length === 1);
    expect(sent[0]).toMatchObject({ type: 'error', error: { code: 'upstream_failed', message: 'LocalAI lists no such model for that stage.' } });
    expect(seen.sockets).toHaveLength(0);

    const { upstream } = upstreamOf({ port });
    const told = [];
    const closed = vi.fn();
    upstream.bridge({ pipeline: 'gpt-realtime', transcription: '' }, { update: UPDATE, send: (t) => told.push(JSON.parse(t)), close: closed });
    await until(() => seen.frames.length === 1);
    seen.sockets[0].ws.close();
    await until(() => closed.mock.calls.length === 1);
    expect(told.pop()).toMatchObject({ type: 'error', error: { code: 'upstream_failed', message: 'The model server closed the session.' } });
    expect(closed.mock.calls[0][0]).toBe(1011);
  });
});
