// @vitest-environment node
// electron/lan-door.e2e.test.js
//
// Fork: "share this computer's models", the whole way through. The unit tests
// beside this file hold each part to a stand-in for the others; here the parts
// run together, wired as main.js wires them:
//
//   another device ──HTTP/WS──▶ the door (startLanServer)
//                                 └─ createUpstream ──loopback──▶ LocalAI
//                                      └─ createLocalServer (pipelines, setPipeline)
//
// Nothing of lan-server.js, lan-upstream.js or local-server.js is replaced.
// What stands in is only what is not this repository's: the LocalAI (a real
// HTTP and WebSocket server on 127.0.0.1, recording everything it is asked)
// and the page (the renderer, which answers what is the app's own). The other
// device is a real HTTP client and a real WebSocket.
//
// Every test starts and stops its own servers on ports the system picks, and
// ends by checking that no socket and no timer it caused is left on either
// side — the door's or the LocalAI's — through a ledger of the process's TCP
// handles and timers.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createHook } from 'node:async_hooks';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';

const require = createRequire(import.meta.url);
const { startLanServer } = require('./lan-server.js');
const { createUpstream } = require('./lan-upstream.js');
const { createLocalServer } = require('./local-server.js');

/** This computer's name, as the door is told it: not ASCII, so the header's encoding is exercised too. */
const NAME = '里兹的 Mac mini';
/** An access key distinctive enough that finding it anywhere it should not be is a real finding. */
const KEY = 'k0to-mimi-door-key-7f9a';

// ---------------------------------------------------------------------------
// The ledger: every TCP handle and timer the process makes, and whether it is
// gone again. Both servers and the device run in this one process, so this is
// both sides of every connection.

const live = new Map();
let made = 0;
const THIS_FILE = /lan-door\.e2e\.test\.js/;
const RUNNER = /node_modules[\\/](@vitest|vitest|tinypool|birpc)[\\/]/;
/** Where a resource was made: the first frame that is neither Node's own nor this hook. */
function maker() {
  const prepare = Error.prepareStackTrace;
  const limit = Error.stackTraceLimit;
  Error.prepareStackTrace = (_error, sites) => sites;
  Error.stackTraceLimit = 40;
  const holder = {};
  Error.captureStackTrace(holder, maker);
  const sites = holder.stack;
  Error.prepareStackTrace = prepare;
  Error.stackTraceLimit = limit;
  const files = sites.map((site) => `${site.getFileName() ?? ''}:${site.getLineNumber() ?? ''}`);
  return { first: files.slice(1).find((file) => !file.startsWith('node:')) ?? 'node', all: files.join(' ') };
}
const hook = createHook({
  init(asyncId, type) {
    if (type !== 'TCPWRAP' && type !== 'TCPSERVERWRAP' && type !== 'Timeout') return;
    const { first, all } = maker();
    // A timer this file sets (a poll, a pause, the stand-ins') or the runner sets is not what is under test.
    if (type === 'Timeout' && (THIS_FILE.test(first) || RUNNER.test(all))) return;
    live.set(asyncId, { n: ++made, type, at: first });
  },
  destroy(asyncId) {
    live.delete(asyncId);
  },
});
hook.enable();
afterAll(() => hook.disable());

/** What was made after `mark` and is still there. */
const leftSince = (mark) => [...live.values()].filter((r) => r.n > mark);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, what = 'the condition', ms = 3000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error(`Never happened: ${what}`);
    await sleep(5);
  }
}
/** Waits until nothing made since `mark` is left; fails naming what is. */
async function nothingLeftSince(mark, ms = 2000) {
  try {
    await until(() => leftSince(mark).length === 0, 'everything closed', ms);
  } catch {
    throw new Error(`Left open: ${leftSince(mark).map((r) => `${r.type} from ${r.at}`).join(', ')}`);
  }
}

let stops = [];
let mark = 0;
/** Everything a device heard: status lines aside, every header, body, frame and close reason. */
let heard = [];
beforeEach(() => {
  stops = [];
  heard = [];
  mark = made;
});
afterEach(async () => {
  for (const stop of stops.reverse()) await stop();
  stops = [];
  await nothingLeftSince(mark);
});

// ---------------------------------------------------------------------------
// The LocalAI: what the app reads of one, and nothing more. One pipeline
// (`gpt-realtime`), three recognizers, two text models and a VAD.

const RECOGNIZERS = ['apple-speech-transcriber', 'whisper-large-turbo', 'qwen3-asr-mlx'];
const TEXT_MODELS = ['hy-mt2-1.8b', 'qwen3-4b'];
const CAPABILITIES = new Map([
  ['gpt-realtime', []],
  ...RECOGNIZERS.map((id) => [id, ['transcript']]),
  ['hy-mt2-1.8b', ['chat', 'completion']],
  ['qwen3-4b', ['chat']],
  ['silero-vad', ['vad']],
]);

async function fakeLocalAI() {
  let seq = 0;
  /** Every request it was sent, in order: HTTP ones with their headers and body, and each socket's handshake. */
  const log = [];
  /** Every Realtime session opened on it. */
  const sessions = [];
  const connections = new Set();
  let config = { name: 'gpt-realtime', pipeline: { vad: 'silero-vad', transcription: 'apple-speech-transcriber', llm: 'hy-mt2-1.8b', turn_detection: { type: 'server_vad' } } };
  let holding = null;
  let stopped = false;

  const json = (response, status, body) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  const fake = {
    log,
    sessions,
    port: 0,
    pipeline: () => config.pipeline,
    patches: () => log.filter((e) => e.method === 'PATCH').map((e) => JSON.parse(e.body).pipeline),
    shutdowns: () => log.filter((e) => e.url === '/backend/shutdown').map((e) => JSON.parse(e.body).model),
    /** Open TCP connections to it, sockets included. */
    connections: () => connections.size,
    /** Set, a pipeline change is refused with these words, as LocalAI refuses one it cannot write. */
    refusePatch: '',
    /** How it answers a chat request; a test may swap it. */
    chat(body, response) {
      if (!body.stream) return json(response, 200, { object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'こんにちは' }, finish_reason: 'stop' }] });
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const piece of ['こん', 'にちは']) response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
      response.end('data: [DONE]\n\n');
    },
    /** While held, a new session's own announcement waits: a LocalAI busy loading a model. */
    hold() {
      holding = [];
      return () => {
        const waiting = holding ?? [];
        holding = null;
        for (const announce of waiting) announce();
      };
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      for (const session of sessions) session.ws.terminate();
      wss.close();
      await new Promise((done) => {
        server.close(() => done());
        server.closeAllConnections();
      });
    },
  };

  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const entry = { seq: ++seq, kind: 'http', method: request.method, url: request.url, headers: { ...request.headers }, body: Buffer.concat(chunks).toString('utf8'), aborted: false };
      log.push(entry);
      response.on('close', () => { entry.aborted = !response.writableEnded; });
      const route = `${request.method} ${new URL(request.url, 'http://localai').pathname}`;
      if (route === 'GET /readyz') return json(response, 200, 'OK');
      if (route === 'GET /v1/models') return json(response, 200, { object: 'list', data: [...CAPABILITIES.keys()].map((id) => ({ id, object: 'model' })) });
      if (route === 'GET /v1/models/capabilities') return json(response, 200, { data: [...CAPABILITIES].map(([id, capabilities]) => ({ id, capabilities })) });
      if (route === 'GET /api/models/config-json/gpt-realtime') return json(response, 200, config);
      if (route === 'PATCH /api/models/config-json/gpt-realtime' && fake.refusePatch) return json(response, 500, { error: { message: fake.refusePatch } });
      if (route === 'PATCH /api/models/config-json/gpt-realtime') {
        config = { ...config, ...JSON.parse(entry.body) };
        return json(response, 200, { success: true });
      }
      if (route === 'POST /backend/shutdown') return json(response, 200, {});
      if (route === 'POST /v1/chat/completions') return fake.chat(JSON.parse(entry.body), response, entry);
      return json(response, 404, { error: { message: `no ${route}` } });
    });
  });
  server.on('connection', (socket) => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
  });

  const wss = new WebSocketServer({ server, path: '/v1/realtime' });
  wss.on('connection', (ws, request) => {
    const session = { seq: ++seq, url: request.url, headers: { ...request.headers }, ws, received: [], sent: [], recognizer: null, appended: 0, closed: null };
    log.push({ seq: session.seq, kind: 'ws', url: request.url, headers: session.headers });
    sessions.push(session);
    session.say = (event) => {
      const text = JSON.stringify(event);
      session.sent.push(text);
      ws.send(text);
    };
    ws.on('message', (data) => {
      const text = data.toString('utf8');
      session.received.push(text);
      const event = JSON.parse(text);
      if (event.type === 'session.update') {
        const transcription = event.session?.audio?.input?.transcription ?? {};
        // As LocalAI does (FORK.md, 2026-10-03): a transcription session takes no recognizer but its pipeline's.
        if (event.session?.type === 'transcription' && transcription.model && transcription.model !== config.pipeline.transcription) {
          session.say({ type: 'error', error: { type: 'invalid_request_error', message: 'Failed to update session: model is not a valid pipeline model' } });
          return;
        }
        // The pipeline is read when the session is configured: the recognizer it names now is the one this session runs.
        session.recognizer = config.pipeline.transcription;
        session.say({ type: 'session.updated', session: { ...event.session, audio: { input: { ...event.session?.audio?.input, transcription: { ...transcription, model: session.recognizer } } } } });
      } else if (event.type === 'input_audio_buffer.append') {
        session.appended += 1;
      } else if (event.type === 'input_audio_buffer.commit') {
        const item = `item_${session.seq}_${session.sent.length}`;
        session.say({ type: 'input_audio_buffer.committed', item_id: item });
        session.say({ type: 'conversation.item.input_audio_transcription.delta', item_id: item, delta: 'heard ' });
        session.say({ type: 'conversation.item.input_audio_transcription.completed', item_id: item, transcript: `${session.appended} chunks heard by ${session.recognizer}` });
      }
    });
    ws.on('close', (code, reason) => { session.closed = { code, reason: reason.toString() }; });
    ws.on('error', () => {});
    const announce = () => session.say({ type: 'session.created', session: { id: `sess_localai_${session.seq}` } });
    if (holding) holding.push(announce);
    else announce();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.port = server.address().port;
  stops.push(() => fake.stop());
  return fake;
}

/** A port nothing listens on: a LocalAI that is installed but not running. */
async function deadPort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// ---------------------------------------------------------------------------
// The page: the renderer's side of the door. It answers the app's own lists
// and chat, opens every session (as the real page does, over IPC: never in
// the same turn), and answers the sessions that stay its own.

const APP_MODELS = [{ id: 'sensevoice-int8', kind: 'asr' }, { id: 'opus-mt-ja-zh', kind: 'translate' }];
const APP_LIST = [{ id: 'kotomimi', object: 'model', owned_by: 'kotomimi' }, ...APP_MODELS.map((m) => ({ id: m.id, object: 'model', owned_by: 'kotomimi' }))];
const APP_CAPABILITIES = [{ id: 'kotomimi', capabilities: null }, ...APP_MODELS.map((m) => ({ id: m.id, capabilities: [m.kind === 'asr' ? 'transcript' : 'translate'], languages: [] }))];

function fakePage() {
  const seen = { requests: [], opened: [], messages: [], closed: [], proxied: [] };
  let door = null;
  const later = (fn) => setImmediate(fn);
  const answer = (request) => {
    if (request.path === '/v1/models') return { body: { object: 'list', data: APP_LIST } };
    if (request.path === '/v1/models/capabilities') return { body: { object: 'list', data: APP_CAPABILITIES } };
    return { body: { object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'from the page' } }] } };
  };
  return {
    seen,
    attach: (server) => { door = server; },
    handlers: {
      request: (request) => {
        seen.requests.push(request);
        later(() => door.reply(request.id, answer(request)));
      },
      socketOpen: (socket) => {
        seen.opened.push(socket);
        later(() => door.send(socket.id, JSON.stringify({ type: 'session.created', session: { id: `sess_page_${socket.id}` } })));
      },
      socketMessage: (message) => {
        seen.messages.push(message);
        const event = JSON.parse(message.data);
        if (event.type === 'session.update') later(() => door.send(message.id, JSON.stringify({ type: 'session.updated', session: event.session })));
      },
      socketClose: (socket) => seen.closed.push(socket),
      socketProxied: (socket) => seen.proxied.push(socket),
    },
  };
}

/** The door, opened as main.js opens it on `lan:start`, in front of the LocalAI on `localaiPort`. */
async function share(localaiPort, { key = '', idleSessionMs, idleCheckMs } = {}) {
  const local = createLocalServer({ address: `127.0.0.1:${localaiPort}`, home: path.join(os.tmpdir(), 'kotomimi-e2e-no-home'), exists: () => false, readFile: () => { throw new Error('ENOENT'); } });
  const upstream = createUpstream({ port: local.port, pipelines: () => local.pipelines(), setPipeline: (name, change) => local.setPipeline(name, change) });
  const page = fakePage();
  const idle = { ...(idleSessionMs ? { idleSessionMs } : {}), ...(idleCheckMs ? { idleCheckMs } : {}) };
  const door = await startLanServer({ port: 0, host: '127.0.0.1', key, name: NAME, upstream, ...idle }, page.handlers);
  page.attach(door);
  stops.push(() => door.close());
  // `ready`: what is made from here on is the requests' and the sessions' — gone again once they are, with both servers still up.
  return { door, page, ready: made, base: `http://127.0.0.1:${door.port}`, realtime: `ws://127.0.0.1:${door.port}/v1/realtime?model=kotomimi` };
}

// ---------------------------------------------------------------------------
// The other device.

/** One HTTP request, on a connection of its own that closes after the answer. */
function call(url, { method = 'GET', key, body } = {}) {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? null : JSON.stringify(body);
    const headers = { ...(key !== undefined ? { Authorization: `Bearer ${key}` } : {}), ...(text !== null ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) } : {}) };
    const request = http.request(url, { method, agent: false, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const answer = { status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString('utf8') };
        heard.push(JSON.stringify(answer.headers), answer.text);
        resolve({ ...answer, json: () => JSON.parse(answer.text) });
      });
    });
    request.on('error', reject);
    request.end(text ?? undefined);
  });
}

/** A chat request read as it streams: each piece as it came, and whether the answer was whole. */
function streamChat(base, body, { key } = {}) {
  const got = { status: 0, headers: {}, pieces: [], complete: null, request: null };
  got.done = new Promise((resolve) => {
    const text = JSON.stringify(body);
    got.request = http.request(`${base}/v1/chat/completions`, { method: 'POST', agent: false, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), ...(key ? { Authorization: `Bearer ${key}` } : {}) } }, (response) => {
      got.status = response.statusCode;
      got.headers = response.headers;
      heard.push(JSON.stringify(response.headers));
      response.on('data', (chunk) => {
        got.pieces.push(chunk.toString('utf8'));
        heard.push(chunk.toString('utf8'));
      });
      response.on('error', () => {});
      response.on('close', () => {
        // `complete`: the message came to its end as HTTP frames one — not cut off.
        got.complete = response.complete;
        resolve(got);
      });
    });
    got.request.on('error', () => resolve(got));
    got.request.end(text);
  });
  return got;
}

/** A Realtime socket, settled: open, or refused with the HTTP status. `key` rides the GA way, as a subprotocol. */
function dial(url, { key, bearer, localAddress } = {}) {
  return new Promise((resolve) => {
    const protocols = key === undefined ? [] : ['realtime', `openai-insecure-api-key.${key}`];
    const options = { ...(bearer ? { headers: { Authorization: `Bearer ${bearer}` } } : {}), ...(localAddress ? { localAddress } : {}) };
    const socket = new WebSocket(url, protocols, options);
    const device = {
      socket,
      frames: [],
      closed: null,
      handshake: null,
      events: () => device.frames.map((text) => JSON.parse(text)),
      send: (event) => socket.send(typeof event === 'string' ? event : JSON.stringify(event)),
      async next(type) {
        await until(() => device.events().some((e) => e.type === type), `the device hears ${type}`);
        return device.events().find((e) => e.type === type);
      },
    };
    socket.on('upgrade', (response) => {
      device.handshake = { status: response.statusCode, headers: response.headers };
      heard.push(JSON.stringify(response.headers));
    });
    socket.on('message', (data) => {
      device.frames.push(data.toString('utf8'));
      heard.push(data.toString('utf8'));
    });
    socket.on('close', (code, reason) => {
      device.closed = { code, reason: reason.toString() };
      heard.push(reason.toString());
    });
    socket.on('error', () => {});
    socket.on('open', () => resolve(device));
    socket.on('unexpected-response', (request, response) => {
      heard.push(JSON.stringify(response.headers));
      response.resume();
      request.destroy();
      resolve({ refused: response.statusCode });
    });
  });
}

/** A session's first configuration, as the client sends it (FORK.md, "给服务器一侧的约定"). */
const UPDATE = (recognizer, language = 'ja') => ({
  type: 'session.update',
  session: { type: 'transcription', audio: { input: { transcription: { ...(recognizer ? { model: recognizer } : {}), language }, turn_detection: { type: 'server_vad' }, noise_reduction: null } } },
});

/** A session, live: the page's announcement heard, the configuration sent, its confirmation heard. */
async function session(realtime, recognizer, options = {}) {
  const device = await dial(realtime, options);
  await device.next('session.created');
  device.send(UPDATE(recognizer));
  await device.next('session.updated');
  return device;
}

/** A few chunks of audio and a commit: the LocalAI answers with a transcript naming the recognizer that heard it. */
async function speak(device, chunks = 2) {
  const before = device.events().filter((e) => e.type === 'conversation.item.input_audio_transcription.completed').length;
  for (let i = 0; i < chunks; i += 1) device.send({ type: 'input_audio_buffer.append', audio: 'AAAAAAAA' });
  device.send({ type: 'input_audio_buffer.commit' });
  await until(() => device.events().filter((e) => e.type === 'conversation.item.input_audio_transcription.completed').length > before, 'a transcript');
  return device.events().filter((e) => e.type === 'conversation.item.input_audio_transcription.completed').pop().transcript;
}

// ===========================================================================

describe('the shared door, end to end: the model lists', () => {
  it('lists the app\'s own models, then the LocalAI\'s recognizers and text models as LocalAI\'s, and says it includes a model server', async () => {
    const fake = await fakeLocalAI();
    const { base, ready } = await share(fake.port);
    const list = await call(`${base}/v1/models`);
    expect(list.status).toBe(200);
    expect(list.headers['x-kotomimi-includes']).toBe('model-server');
    expect(decodeURIComponent(list.headers['x-kotomimi-name'])).toBe(NAME);
    expect(list.json().data).toEqual([
      ...APP_LIST,
      ...[...RECOGNIZERS, ...TEXT_MODELS].map((id) => ({ id, object: 'model', owned_by: 'localai' })),
    ]);
    // Its pipeline and its VAD are not models another device could choose.
    expect(list.text).not.toContain('gpt-realtime');
    expect(list.text).not.toContain('silero-vad');

    const kinds = await call(`${base}/v1/models/capabilities`);
    expect(kinds.headers['x-kotomimi-includes']).toBe('model-server');
    expect(kinds.json().data).toEqual([
      ...APP_CAPABILITIES,
      ...RECOGNIZERS.map((id) => ({ id, capabilities: ['transcript'] })),
      ...TEXT_MODELS.map((id) => ({ id, capabilities: ['chat'] })),
    ]);
    // Asked over the loopback, as LocalAI's own API answers it — and never for a key.
    expect(fake.log.map((e) => e.url)).toEqual(expect.arrayContaining(['/v1/models', '/v1/models/capabilities', '/api/models/config-json/gpt-realtime']));
    await nothingLeftSince(ready);
  });

  it('lists only the app\'s own models, with no error and no model-server mark, while LocalAI is not running', async () => {
    const { base, page, ready } = await share(await deadPort());
    const list = await call(`${base}/v1/models`);
    expect(list.status).toBe(200);
    expect(list.headers['x-kotomimi-includes']).toBeUndefined();
    expect(decodeURIComponent(list.headers['x-kotomimi-name'])).toBe(NAME);
    expect(list.json()).toEqual({ object: 'list', data: APP_LIST });
    const kinds = await call(`${base}/v1/models/capabilities`);
    expect(kinds.status).toBe(200);
    expect(kinds.json()).toEqual({ object: 'list', data: APP_CAPABILITIES });
    expect(page.seen.requests.map((r) => r.path)).toEqual(['/v1/models', '/v1/models/capabilities']);
    await nothingLeftSince(ready);
  });
});

describe('the shared door, end to end: the access key', () => {
  it('refuses a request or a handshake without the key or with a wrong one, and nothing of it reaches LocalAI or the page', async () => {
    const fake = await fakeLocalAI();
    const { base, realtime, page, door, ready } = await share(fake.port, { key: KEY });
    expect((await call(`${base}/v1/models`)).status).toBe(401);
    expect((await call(`${base}/v1/models`, { key: 'wrong' })).status).toBe(401);
    expect((await call(`${base}/v1/models/capabilities`, { key: `${KEY}x` })).status).toBe(401);
    const chat = await call(`${base}/v1/chat/completions`, { method: 'POST', key: 'wrong', body: { model: 'hy-mt2-1.8b', messages: [] } });
    expect(chat.status).toBe(401);
    expect(chat.json().error.code).toBe('invalid_api_key');
    expect(await dial(realtime)).toEqual({ refused: 401 });
    expect(await dial(realtime, { key: 'wrong' })).toEqual({ refused: 401 });
    expect(await dial(realtime, { bearer: 'wrong' })).toEqual({ refused: 401 });
    expect(fake.log).toEqual([]);
    expect(page.seen.requests).toEqual([]);
    expect(page.seen.opened).toEqual([]);
    expect(door.count()).toBe(0);
    // A refusal does not echo the key it was given.
    expect(heard.join('\n')).not.toContain(KEY);
    await nothingLeftSince(ready);
  });

  it('passes the right key\'s requests on without it: nothing LocalAI is sent carries the key, and nothing the device hears does', async () => {
    const fake = await fakeLocalAI();
    const { base, realtime, ready } = await share(fake.port, { key: KEY });
    expect((await call(`${base}/v1/models`, { key: KEY })).json().data).toHaveLength(APP_LIST.length + 5);
    expect((await call(`${base}/v1/models/capabilities`, { key: KEY })).status).toBe(200);
    const chat = streamChat(base, { model: 'hy-mt2-1.8b', stream: true, messages: [{ role: 'user', content: '你好' }] }, { key: KEY });
    await chat.done;
    expect(chat.status).toBe(200);
    expect(chat.pieces.join('')).toContain('[DONE]');
    // The socket the GA way, the key a subprotocol beside `realtime`: only `realtime` is echoed.
    const device = await session(realtime, 'whisper-large-turbo', { key: KEY });
    expect(device.handshake.headers['sec-websocket-protocol']).toBe('realtime');
    expect(await speak(device)).toBe('2 chunks heard by whisper-large-turbo');
    device.socket.close(1000, 'done');
    await until(() => fake.sessions[0].closed !== null, 'LocalAI\'s session closes');
    // A Bearer header on the socket is a key too.
    const other = await session(realtime, 'whisper-large-turbo', { bearer: KEY });
    other.socket.close();
    await until(() => fake.sessions[1]?.closed, 'the second LocalAI session closes');

    expect(fake.log.some((e) => e.kind === 'ws')).toBe(true);
    expect(fake.log.some((e) => e.method === 'POST' && e.url === '/v1/chat/completions')).toBe(true);
    expect(JSON.stringify(fake.log)).not.toContain(KEY);
    expect(JSON.stringify(fake.sessions.map((s) => s.received))).not.toContain(KEY);
    for (const entry of fake.log) expect(entry.headers.authorization).toBeUndefined();
    expect(heard.length).toBeGreaterThan(10);
    expect(heard.join('\n')).not.toContain(KEY);
    await nothingLeftSince(ready);
  });
});

describe('the shared door, end to end: a chat request for one of LocalAI\'s text models', () => {
  it('reaches LocalAI as it was sent, and its answer comes back as it was given', async () => {
    const fake = await fakeLocalAI();
    const { base, page, ready } = await share(fake.port);
    const body = { model: 'qwen3-4b', stream: false, temperature: 0.2, max_tokens: 64, messages: [{ role: 'system', content: 'Translate.' }, { role: 'user', content: '今日は天気がいい' }] };
    const answer = await call(`${base}/v1/chat/completions`, { method: 'POST', body });
    expect(answer.status).toBe(200);
    expect(answer.headers['content-type']).toBe('application/json');
    expect(decodeURIComponent(answer.headers['x-kotomimi-name'])).toBe(NAME);
    expect(answer.json()).toEqual({ object: 'chat.completion', model: 'qwen3-4b', choices: [{ index: 0, message: { role: 'assistant', content: 'こんにちは' }, finish_reason: 'stop' }] });
    const chats = fake.log.filter((e) => e.url === '/v1/chat/completions');
    expect(chats).toHaveLength(1);
    expect(JSON.parse(chats[0].body)).toEqual(body);
    expect(page.seen.requests).toEqual([]);

    // Only what a Kotomimi alone reads is left out (FORK.md, "LocalAI 的模型一起共享").
    await call(`${base}/v1/chat/completions`, { method: 'POST', body: { ...body, source_language: 'ja', target_language: 'zh' } });
    expect(JSON.parse(fake.log.filter((e) => e.url === '/v1/chat/completions')[1].body)).toEqual(body);

    // One of the app's own models is the page's: LocalAI never hears of it.
    const own = await call(`${base}/v1/chat/completions`, { method: 'POST', body: { ...body, model: 'opus-mt-ja-zh' } });
    expect(own.json().choices[0].message.content).toBe('from the page');
    expect(fake.log.filter((e) => e.url === '/v1/chat/completions')).toHaveLength(2);
    await nothingLeftSince(ready);
  });

  it('streams back piece by piece, each as LocalAI writes it', async () => {
    const fake = await fakeLocalAI();
    const { base, ready } = await share(fake.port);
    const pieces = ['data: {"choices":[{"delta":{"content":"今日"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"は"}}]}\n\n', 'data: [DONE]\n\n'];
    let chat = null;
    fake.chat = async (body, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const [i, piece] of pieces.entries()) {
        if (i === pieces.length - 1) response.end(piece);
        else response.write(piece);
        // The next piece is written only once the device holds this one: nothing waits for the whole answer.
        await until(() => chat.pieces.join('') === pieces.slice(0, i + 1).join(''), `the device holds piece ${i + 1} alone`);
      }
    };
    chat = streamChat(base, { model: 'hy-mt2-1.8b', stream: true, messages: [] });
    await chat.done;
    expect(chat.status).toBe(200);
    expect(chat.headers['content-type']).toBe('text/event-stream');
    expect(chat.pieces).toEqual(pieces);
    expect(chat.complete).toBe(true);
    await nothingLeftSince(ready);
  });

  it('is ended at LocalAI when the device goes away mid-stream', async () => {
    const fake = await fakeLocalAI();
    const { base, ready } = await share(fake.port);
    fake.chat = (body, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('data: {"choices":[{"delta":{"content":"今"}}]}\n\n');
      // ...and it would go on, for as long as the model takes.
    };
    const chat = streamChat(base, { model: 'hy-mt2-1.8b', stream: true, messages: [] });
    await until(() => chat.pieces.length === 1, 'the first piece');
    chat.request.destroy();
    await until(() => fake.log.find((e) => e.url === '/v1/chat/completions')?.aborted, 'LocalAI\'s request is ended');
    await until(() => fake.connections() === 0, 'no connection to LocalAI is left');
    // With both servers still up: what the request made — its sockets on both sides, any timer — is gone.
    await nothingLeftSince(ready);
  });
});

describe('the shared door, end to end: a session on one of LocalAI\'s recognizers', () => {
  it('names the recognizer in the pipeline first, then opens LocalAI\'s session, and carries messages both ways as they are', async () => {
    const fake = await fakeLocalAI();
    const { realtime, page, ready } = await share(fake.port);
    const device = await dial(realtime);
    await device.next('session.created');
    device.send(UPDATE('whisper-large-turbo'));
    // Audio sent before LocalAI's session is up waits for it, in order.
    device.send({ type: 'input_audio_buffer.append', audio: 'AQID' });
    const updated = await device.next('session.updated');
    expect(updated.session.audio.input.transcription).toEqual({ language: 'ja', model: 'whisper-large-turbo' });

    // The pipeline was changed — the whole of it sent back, one part changed — and the replaced recognizer let go, before the session opened.
    const patch = fake.log.find((e) => e.method === 'PATCH');
    const shutdown = fake.log.find((e) => e.url === '/backend/shutdown');
    const socket = fake.log.find((e) => e.kind === 'ws');
    expect(JSON.parse(patch.body)).toEqual({ pipeline: { vad: 'silero-vad', transcription: 'whisper-large-turbo', llm: 'hy-mt2-1.8b', turn_detection: { type: 'server_vad' } } });
    expect(JSON.parse(shutdown.body)).toEqual({ model: 'apple-speech-transcriber' });
    expect(patch.seq).toBeLessThan(socket.seq);
    expect(shutdown.seq).toBeLessThan(socket.seq);
    expect(socket.url).toBe('/v1/realtime?model=gpt-realtime');

    // LocalAI's session was configured with no recognizer named (it takes none), and runs the pipeline's.
    const [localai] = fake.sessions;
    expect(JSON.parse(localai.received[0])).toEqual({ type: 'session.update', session: { type: 'transcription', audio: { input: { transcription: { language: 'ja' }, turn_detection: { type: 'server_vad' }, noise_reduction: null } } } });
    expect(localai.received[1]).toBe('{"type":"input_audio_buffer.append","audio":"AQID"}');
    expect(localai.recognizer).toBe('whisper-large-turbo');
    // The device heard the page's announcement, not LocalAI's: the door already said a session began.
    expect(device.events().map((e) => e.type)).toEqual(['session.created', 'session.updated']);
    expect(device.events()[0].session.id).toMatch(/^sess_page_/);
    expect(page.seen.proxied).toEqual([{ id: page.seen.opened[0].id }]);

    // From here on, both ways, frame for frame.
    const from = device.frames.length;
    const sentAt = localai.sent.length;
    const appends = [1, 2, 3].map((i) => JSON.stringify({ type: 'input_audio_buffer.append', audio: `AAAA${i}` }));
    for (const text of appends) device.send(text);
    device.send({ type: 'input_audio_buffer.commit' });
    await until(() => device.frames.length >= from + 3, 'the transcript');
    expect(localai.received.slice(2)).toEqual([...appends, '{"type":"input_audio_buffer.commit"}']);
    expect(device.frames.slice(from)).toEqual(localai.sent.slice(sentAt));
    expect(device.events().pop()).toMatchObject({ type: 'conversation.item.input_audio_transcription.completed', transcript: '4 chunks heard by whisper-large-turbo' });
    // The page heard none of it.
    expect(page.seen.messages).toEqual([]);

    device.socket.close();
    await until(() => localai.closed !== null && page.seen.closed.length === 1, 'both sides close');
    await nothingLeftSince(ready);
  });

  it('closes LocalAI\'s side when the device closes, with the device\'s close code', async () => {
    const fake = await fakeLocalAI();
    const { realtime, door, ready } = await share(fake.port);
    const device = await session(realtime, 'whisper-large-turbo');
    device.socket.close(4000, 'stopped by the user');
    await until(() => fake.sessions[0].closed !== null, 'LocalAI\'s session closes');
    expect(fake.sessions[0].closed).toEqual({ code: 4000, reason: 'stopped by the user' });
    await until(() => door.count() === 0 && fake.connections() === 0, 'nothing left open');
    await nothingLeftSince(ready);
  });

  it('closes the device\'s side when LocalAI closes, with LocalAI\'s close code', async () => {
    const fake = await fakeLocalAI();
    const { realtime, door, page, ready } = await share(fake.port);
    const device = await session(realtime, 'whisper-large-turbo');
    fake.sessions[0].ws.close(4002, 'pipeline reloaded');
    await until(() => device.closed !== null, 'the device\'s socket closes');
    expect(device.closed).toEqual({ code: 4002, reason: 'pipeline reloaded' });
    // The device did not ask for it: it is told, in LocalAI's words.
    expect(device.events().pop()).toMatchObject({ type: 'error', error: { code: 'upstream_failed', message: 'The model server closed the session: pipeline reloaded' } });
    await until(() => door.count() === 0 && page.seen.closed.length === 1 && fake.connections() === 0, 'nothing left open');
    await nothingLeftSince(ready);
  });

  it('tells the device LocalAI\'s own words when it refuses the recognizer, and closes the socket, whatever script the words are in', async () => {
    const fake = await fakeLocalAI();
    fake.refusePatch = 'モデルの設定を書き込めません：/Users/里兹/.localai/models は読み取り専用のファイルシステムです';
    const { realtime, door, ready } = await share(fake.port);
    const device = await dial(realtime);
    await device.next('session.created');
    device.send(UPDATE('whisper-large-turbo'));
    await until(() => device.closed !== null, 'the device\'s socket closes');
    const { error } = device.events().pop();
    expect(error).toMatchObject({ code: 'upstream_failed', message: expect.stringContaining(fake.refusePatch) });
    expect(device.closed.code).toBe(1011);
    // A close frame holds 123 bytes of reason: the same words, cut there on a character's edge.
    expect(Buffer.byteLength(device.closed.reason)).toBeLessThanOrEqual(123);
    expect(device.closed.reason.length).toBeGreaterThan(20);
    expect(error.message.startsWith(device.closed.reason)).toBe(true);
    // Nothing was changed or unloaded, and no session was opened on LocalAI.
    expect(fake.pipeline().transcription).toBe('apple-speech-transcriber');
    expect(fake.shutdowns()).toEqual([]);
    expect(fake.sessions).toEqual([]);
    expect(door.count()).toBe(0);
    await nothingLeftSince(ready);
  });

  it('leaves a session on one of the app\'s own recognizers with the page: LocalAI hears nothing of it', async () => {
    const fake = await fakeLocalAI();
    const { realtime, page, ready } = await share(fake.port);
    const device = await session(realtime, 'sensevoice-int8');
    device.send({ type: 'input_audio_buffer.append', audio: 'AAAA' });
    await until(() => page.seen.messages.length === 2, 'the page hears the audio');
    expect(page.seen.proxied).toEqual([]);
    expect(fake.sessions).toEqual([]);
    expect(fake.log.filter((e) => e.method !== 'GET')).toEqual([]);
    device.socket.close();
    await until(() => page.seen.closed.length === 1, 'the page hears the close');
    await nothingLeftSince(ready);
  });
});

describe('the shared door, end to end: changing recognizers', () => {
  it('rewrites the pipeline for a later session that asks for another recognizer, and leaves it for one that asks for the same or leaves the choice', async () => {
    const fake = await fakeLocalAI();
    const { realtime, ready } = await share(fake.port);
    for (const recognizer of ['whisper-large-turbo', 'qwen3-asr-mlx', 'qwen3-asr-mlx', '']) {
      const device = await session(realtime, recognizer);
      expect(await speak(device, 1)).toBe(`1 chunks heard by ${recognizer || 'qwen3-asr-mlx'}`);
      device.socket.close();
      await until(() => fake.sessions.at(-1).closed !== null, 'its LocalAI session closes');
    }
    expect(fake.patches().map((p) => p.transcription)).toEqual(['whisper-large-turbo', 'qwen3-asr-mlx']);
    // Each replaced recognizer let go from memory, once.
    expect(fake.shutdowns()).toEqual(['apple-speech-transcriber', 'whisper-large-turbo']);
    expect(fake.sessions.map((s) => s.recognizer)).toEqual(['whisper-large-turbo', 'qwen3-asr-mlx', 'qwen3-asr-mlx', 'qwen3-asr-mlx']);
    await nothingLeftSince(ready);
  });

  it('changes the pipeline once for a run\'s two legs that ask for the same recognizer at once', async () => {
    const fake = await fakeLocalAI();
    const { realtime, ready } = await share(fake.port);
    const [me, them] = await Promise.all([session(realtime, 'qwen3-asr-mlx'), session(realtime, 'qwen3-asr-mlx')]);
    expect(await speak(me)).toBe('2 chunks heard by qwen3-asr-mlx');
    expect(await speak(them, 3)).toBe('3 chunks heard by qwen3-asr-mlx');
    expect(fake.patches()).toHaveLength(1);
    expect(fake.shutdowns()).toEqual(['apple-speech-transcriber']);
    me.socket.close();
    them.socket.close();
    await until(() => fake.sessions.every((s) => s.closed), 'both LocalAI sessions close');
    await nothingLeftSince(ready);
  });

  // Current behaviour, written down (see the PR): the pipeline is LocalAI-wide, and the later session's choice wins.
  // The earlier session is not told, and the recognizer it runs on is unloaded under it.
  it('two sessions at once on different recognizers: the later rewrites the pipeline and unloads the earlier one\'s recognizer while it is still open', async () => {
    const fake = await fakeLocalAI();
    const { realtime, ready } = await share(fake.port);
    const first = await session(realtime, 'whisper-large-turbo');
    expect(await speak(first)).toBe('2 chunks heard by whisper-large-turbo');
    const second = await session(realtime, 'qwen3-asr-mlx');
    expect(await speak(second)).toBe('2 chunks heard by qwen3-asr-mlx');

    expect(fake.patches().map((p) => p.transcription)).toEqual(['whisper-large-turbo', 'qwen3-asr-mlx']);
    expect(fake.pipeline().transcription).toBe('qwen3-asr-mlx');
    // The first session's recognizer is shut down while that session is open...
    expect(fake.shutdowns()).toEqual(['apple-speech-transcriber', 'whisper-large-turbo']);
    expect(fake.sessions[0].closed).toBeNull();
    expect(first.closed).toBeNull();
    // ...and nobody tells it: no error, and its socket still carries what it carried.
    expect(first.events().filter((e) => e.type === 'error')).toEqual([]);
    expect(second.events().filter((e) => e.type === 'error')).toEqual([]);
    const before = fake.sessions[0].received.length;
    first.send({ type: 'input_audio_buffer.append', audio: 'AAAA' });
    await until(() => fake.sessions[0].received.length === before + 1, 'the first session still carries audio');
    first.socket.close();
    second.socket.close();
    await until(() => fake.sessions.every((s) => s.closed), 'both LocalAI sessions close');
    await nothingLeftSince(ready);
  });

  // Current behaviour, written down (see the PR): pipeline changes are taken one at a time, but a session is not
  // configured inside its turn. When LocalAI is slow to bring a session up (loading a model takes 12-20 s, FORK.md),
  // a second device's change lands first, and the first device's session runs on the second device's recognizer.
  it('two sessions starting at once on different recognizers: the earlier one can come up on the later one\'s recognizer, and is not told', async () => {
    const fake = await fakeLocalAI();
    const { realtime, ready } = await share(fake.port);
    const release = fake.hold();
    const first = await dial(realtime);
    await first.next('session.created');
    first.send(UPDATE('whisper-large-turbo'));
    await until(() => fake.sessions.length === 1, 'the first LocalAI session opens');
    const second = await dial(realtime);
    await second.next('session.created');
    second.send(UPDATE('qwen3-asr-mlx'));
    await until(() => fake.sessions.length === 2, 'the second LocalAI session opens');
    expect(fake.patches().map((p) => p.transcription)).toEqual(['whisper-large-turbo', 'qwen3-asr-mlx']);
    release();
    await first.next('session.updated');
    await second.next('session.updated');

    // The first device asked for whisper; LocalAI's session for it runs qwen3, and says so only in its own confirmation.
    expect(fake.sessions.map((s) => s.recognizer)).toEqual(['qwen3-asr-mlx', 'qwen3-asr-mlx']);
    expect((await first.next('session.updated')).session.audio.input.transcription.model).toBe('qwen3-asr-mlx');
    expect(await speak(first)).toBe('2 chunks heard by qwen3-asr-mlx');
    expect(first.events().filter((e) => e.type === 'error')).toEqual([]);
    first.socket.close();
    second.socket.close();
    await until(() => fake.sessions.every((s) => s.closed), 'both LocalAI sessions close');
    await nothingLeftSince(ready);
  });

  // The two tests above are what happens today. What should is a choice, not a fix (see the PR): the later device waits
  // while another session holds the pipeline, or the earlier one is told its recognizer was replaced, or keeps it.
  it.todo('two devices on different recognizers at once: neither runs on a recognizer it did not ask for without being told');
});

describe('the shared door, end to end: a session left silent', () => {
  const IDLE = { idleSessionMs: 250, idleCheckMs: 10 };

  it('is ended with `session_idle`, and LocalAI\'s session with it', async () => {
    const fake = await fakeLocalAI();
    const { realtime, door, page, ready } = await share(fake.port, IDLE);
    const device = await session(realtime, 'whisper-large-turbo');
    await until(() => device.closed !== null, 'the idle session is ended', 2000);
    expect(device.events().pop()).toMatchObject({ type: 'error', error: { code: 'session_idle' } });
    expect(device.closed).toEqual({ code: 1000, reason: 'idle' });
    await until(() => fake.sessions[0].closed !== null && door.count() === 0 && page.seen.closed.length === 1, 'every side closes');
    // LocalAI is told why, too.
    expect(fake.sessions[0].closed).toEqual({ code: 1000, reason: 'idle' });
    await until(() => fake.connections() === 0, 'no connection to LocalAI is left');
    await nothingLeftSince(ready);
  });

  it('is kept while LocalAI hears speech in it, well past the limit, and ended once the speech stops', async () => {
    const fake = await fakeLocalAI();
    const { realtime, ready } = await share(fake.port, IDLE);
    const device = await session(realtime, 'whisper-large-turbo');
    for (let i = 0; i < 15; i += 1) {
      fake.sessions[0].say({ type: 'conversation.item.input_audio_transcription.delta', item_id: `i${i}`, delta: 'あ' });
      await sleep(50);
    }
    // 750 ms of speech, three times the limit: still open.
    expect(device.closed).toBeNull();
    expect(device.events().some((e) => e.type === 'error')).toBe(false);
    await until(() => device.closed !== null, 'the session is ended once silent', 2000);
    expect(device.events().pop()).toMatchObject({ type: 'error', error: { code: 'session_idle' } });
    await until(() => fake.sessions[0].closed !== null, 'LocalAI\'s session closes');
    await nothingLeftSince(ready);
  });

  // Two devices need two source addresses: Linux routes all of 127/8 to the loopback, macOS only 127.0.0.1.
  it.runIf(process.platform === 'linux')('is judged by device: a silent device\'s session ends while another device speaks', async () => {
    const fake = await fakeLocalAI();
    const { realtime, ready } = await share(fake.port, IDLE);
    const silent = await session(realtime, 'whisper-large-turbo', { localAddress: '127.0.0.2' });
    const speaking = await session(realtime, 'whisper-large-turbo', { localAddress: '127.0.0.1' });
    const spoken = fake.sessions[1];
    for (let i = 0; i < 12 && silent.closed === null; i += 1) {
      spoken.say({ type: 'input_audio_buffer.speech_started', item_id: `i${i}` });
      await sleep(50);
    }
    await until(() => silent.closed !== null, 'the silent device\'s session is ended', 2000);
    expect(silent.events().pop()).toMatchObject({ type: 'error', error: { code: 'session_idle' } });
    expect(speaking.closed).toBeNull();
    speaking.socket.close();
    await until(() => fake.sessions.every((s) => s.closed), 'both LocalAI sessions close');
    await nothingLeftSince(ready);
  });
});

describe('the shared door, end to end: LocalAI going away', () => {
  it('mid-session: the device is told why, its socket closes, and nothing is left open on this computer', async () => {
    const fake = await fakeLocalAI();
    const { realtime, door, page, ready } = await share(fake.port);
    const device = await session(realtime, 'whisper-large-turbo');
    expect(await speak(device)).toBe('2 chunks heard by whisper-large-turbo');
    await fake.stop();
    await until(() => device.closed !== null, 'the device\'s socket closes');
    expect(device.events().pop()).toMatchObject({ type: 'error', error: { code: 'upstream_failed', message: 'The model server closed the session.' } });
    expect(device.closed).toEqual({ code: 1011, reason: 'The model server closed the session.' });
    expect(door.count()).toBe(0);
    await until(() => page.seen.closed.length === 1, 'the page hears the close');
    // Everything the session made — its socket, the door's socket to LocalAI, every timer — is gone, with the door still listening.
    await nothingLeftSince(ready);
  });

  // What the door knows of LocalAI is asked again after 5 s (`CACHE_MS`), or as soon as a pipeline change finds it gone.
  // Until then a request for one of its models is passed on, and fails in words; after, it is the page's. Never left waiting.
  it('after it went: what still names its models is told and closed, then what follows is the page\'s', async () => {
    const fake = await fakeLocalAI();
    const { base, realtime, door, page, ready } = await share(fake.port);
    // A session that leaves the recognizer to this computer: LocalAI's pipeline, as it is, with nothing changed.
    const first = await session(realtime, '');
    first.socket.close();
    await until(() => fake.sessions[0].closed !== null, 'LocalAI\'s session closes');
    await fake.stop();

    // Still remembered as LocalAI's: a chat is answered 502 in OpenAI's shape...
    const chat = await call(`${base}/v1/chat/completions`, { method: 'POST', body: { model: 'hy-mt2-1.8b', messages: [] } });
    expect(chat.status).toBe(502);
    expect(chat.json().error.code).toBe('upstream_failed');
    // ...and a session is told why, and closed: one on the pipeline as it is (nothing to change, so LocalAI is dialled)...
    const left = await dial(realtime);
    await left.next('session.created');
    left.send(UPDATE(''));
    await until(() => left.closed !== null, 'the session that left the choice is closed');
    expect(left.events().pop()).toMatchObject({ type: 'error', error: { code: 'upstream_failed', message: expect.stringContaining('could not be reached') } });
    expect(left.closed.code).toBe(1011);
    // ...and one that names another recognizer (the pipeline change finds LocalAI gone; see the PR on the words).
    const named = await dial(realtime);
    await named.next('session.created');
    named.send(UPDATE('qwen3-asr-mlx'));
    await until(() => named.closed !== null, 'the session that named a recognizer is closed');
    expect(named.events().pop()).toMatchObject({ type: 'error', error: { code: 'upstream_failed' } });
    expect(named.closed.code).toBe(1011);

    // Known to be gone now: the page has the session, and the lists are the app's alone.
    const later = await session(realtime, 'whisper-large-turbo');
    expect(page.seen.messages.map((m) => JSON.parse(m.data).type)).toEqual(['session.update']);
    expect(page.seen.proxied).toHaveLength(3);
    later.socket.close();
    const list = await call(`${base}/v1/models`);
    expect(list.json().data).toEqual(APP_LIST);
    expect(list.headers['x-kotomimi-includes']).toBeUndefined();
    await until(() => door.count() === 0, 'every socket closed');
    await nothingLeftSince(ready);
  });

  // Not changed (see the PR): the upstream is handed `pipelines()` alone, which answers alike for a LocalAI that is down
  // and one that lists no such pipeline; so a device that names a recognizer just after LocalAI went hears the latter.
  it.fails('after it went: a session that names one of its recognizers is told LocalAI could not be reached', async () => {
    const fake = await fakeLocalAI();
    const { realtime, ready } = await share(fake.port);
    const first = await session(realtime, '');
    first.socket.close();
    await until(() => fake.sessions[0].closed !== null, 'LocalAI\'s session closes');
    await fake.stop();
    const device = await dial(realtime);
    await device.next('session.created');
    device.send(UPDATE('qwen3-asr-mlx'));
    await until(() => device.closed !== null, 'the session is closed');
    const { error } = device.events().pop();
    expect(error.message).toContain('could not be reached');
    await nothingLeftSince(ready);
  });

  it('a device that goes before LocalAI\'s session is up leaves nothing open on either side', async () => {
    const fake = await fakeLocalAI();
    const { realtime, door, page, ready } = await share(fake.port);
    // Gone while LocalAI is still bringing its session up.
    const release = fake.hold();
    const slow = await dial(realtime);
    await slow.next('session.created');
    slow.send(UPDATE('whisper-large-turbo'));
    await until(() => fake.sessions.length === 1, 'LocalAI\'s session opens');
    slow.socket.close();
    await until(() => fake.sessions[0].closed !== null, 'LocalAI\'s side closes');
    release();
    // Gone the moment it asked: before the pipeline is read, or while it is changed.
    const hasty = await dial(realtime);
    await hasty.next('session.created');
    hasty.send(UPDATE('qwen3-asr-mlx'));
    hasty.socket.close();
    await until(() => door.count() === 0 && page.seen.closed.length === 2, 'the door lets both go');
    await until(() => fake.sessions.every((s) => s.closed !== null) && fake.connections() === 0, 'no connection to LocalAI is left');
    await nothingLeftSince(ready);
  });

  it('mid-stream: the device\'s chat answer is cut off as HTTP says, not ended as if whole', async () => {
    const fake = await fakeLocalAI();
    const { base, ready } = await share(fake.port);
    fake.chat = (body, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('data: {"choices":[{"delta":{"content":"今日は"}}]}\n\n');
      setImmediate(() => response.socket.destroy());
    };
    const chat = streamChat(base, { model: 'hy-mt2-1.8b', stream: true, messages: [] });
    await chat.done;
    expect(chat.pieces.join('')).toBe('data: {"choices":[{"delta":{"content":"今日は"}}]}\n\n');
    // A client that reads to the end (`textModel.ts`) would otherwise show half a translation as the whole of it.
    expect(chat.complete).toBe(false);
    await nothingLeftSince(ready);
  });
});

describe('the shared door, end to end: sharing switched off', () => {
  it('ends every session — LocalAI\'s side too — and every answer under way, and leaves nothing open', async () => {
    const fake = await fakeLocalAI();
    const { door, base, realtime, ready } = await share(fake.port);
    const bridged = await session(realtime, 'whisper-large-turbo');
    const own = await session(realtime, 'sensevoice-int8');
    fake.chat = (body, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('data: {"choices":[{"delta":{"content":"今"}}]}\n\n');
    };
    const chat = streamChat(base, { model: 'hy-mt2-1.8b', stream: true, messages: [] });
    await until(() => chat.pieces.length === 1, 'the chat is under way');
    await door.close();
    await until(() => bridged.closed !== null && own.closed !== null && chat.complete !== null, 'every device hears the end');
    // Ended at once, with no close frame: a client reports this as a lost connection.
    expect(bridged.closed.code).toBe(1006);
    expect(own.closed.code).toBe(1006);
    expect(chat.complete).toBe(false);
    await until(() => fake.sessions[0].closed !== null, 'LocalAI\'s session closes');
    await until(() => fake.log.find((e) => e.url === '/v1/chat/completions')?.aborted, 'LocalAI\'s answer is ended');
    await until(() => fake.connections() === 0, 'no connection to LocalAI is left');
    await nothingLeftSince(ready);
  });
});
