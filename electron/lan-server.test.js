// @vitest-environment node
// electron/lan-server.test.js
//
// Fork: the door of "share this computer's models" — a real server on the
// loopback, a real client. What is behind the door (the page) is a recorder
// here: this file holds only what the door itself decides.
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import net from 'node:net';
import http from 'node:http';
import WebSocket from 'ws';

const require = createRequire(import.meta.url);
const { startLanServer, lanAddresses, isNeighbour, isLocalHost, MAX_SOCKETS_PER_DEVICE } = require('./lan-server.js');

let running = [];
afterEach(async () => {
  await Promise.all(running.map((server) => server.close()));
  running = [];
});

/** A server on a free loopback port, and everything the page was handed. */
async function start(key = '') {
  const seen = { requests: [], opened: [], messages: [], closed: [] };
  const server = await startLanServer({ port: 0, key, host: '127.0.0.1', name: '里兹 PC' }, {
    request: (r) => seen.requests.push(r),
    socketOpen: (s) => seen.opened.push(s),
    socketMessage: (m) => seen.messages.push(m),
    socketClose: (c) => seen.closed.push(c),
  });
  running.push(server);
  return { server, seen, base: `http://127.0.0.1:${server.port}`, ws: `ws://127.0.0.1:${server.port}` };
}

const until = async (check) => {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('never happened');
};

/** The status line's code for a request written byte for byte: what no fetch can send, any program on the network can. */
const rawStatus = (port, text) => new Promise((resolve, reject) => {
  const socket = net.connect(port, '127.0.0.1', () => socket.write(text));
  let got = '';
  socket.on('data', (chunk) => {
    got += chunk.toString('latin1');
    const line = got.split('\r\n')[0];
    if (got.includes('\r\n')) {
      socket.destroy();
      resolve(Number(line.split(' ')[1]));
    }
  });
  socket.on('error', reject);
});

/** A socket, settled: open with its subprotocol, or refused with the HTTP status. */
const dial = (url, protocols) => new Promise((resolve) => {
  const socket = new WebSocket(url, protocols);
  socket.on('open', () => resolve({ socket, protocol: socket.protocol }));
  socket.on('unexpected-response', (_request, response) => resolve({ status: response.statusCode }));
  socket.on('error', () => {});
});

describe('the shared models\' door: HTTP', () => {
  it('hands a GET\'s query to the page with it, and none where there is none (fork)', async () => {
    const { server, seen, base } = await start();
    const answer = fetch(`${base}/v1/models/capabilities?asks=ko&model=apple-speech%3Aja`);
    await until(() => seen.requests.length === 1);
    expect(seen.requests[0]).toMatchObject({ method: 'GET', path: '/v1/models/capabilities', query: { asks: 'ko', model: 'apple-speech:ja' } });
    server.reply(seen.requests[0].id, { body: { object: 'list', data: [] } });
    expect((await answer).status).toBe(200);
    const plain = fetch(`${base}/v1/models`);
    await until(() => seen.requests.length === 2);
    expect(seen.requests[1].query).toBeUndefined();
    server.reply(seen.requests[1].id, { body: { object: 'list', data: [] } });
    await plain;
  });

  it('hands a GET to the page and answers with what the page replies', async () => {
    const { server, seen, base } = await start();
    const answer = fetch(`${base}/v1/models`);
    await until(() => seen.requests.length === 1);
    expect(seen.requests[0]).toMatchObject({ method: 'GET', path: '/v1/models', body: null });
    expect(server.reply(seen.requests[0].id, { body: { object: 'list', data: [{ id: 'kotomimi' }] } })).toBe(true);
    const response = await answer;
    expect(response.status).toBe(200);
    // A program names no origin, and is owed no cross-origin header: there is no wildcard for a web page to read by.
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    // This computer's name rides on every answer: a device searching the network lists it by that.
    expect(decodeURIComponent(response.headers.get('x-kotomimi-name'))).toBe('里兹 PC');
    expect(server.name).toBe('里兹 PC');
    expect(await response.json()).toEqual({ object: 'list', data: [{ id: 'kotomimi' }] });
    // Answered once: a second reply has no one to go to.
    expect(server.reply(seen.requests[0].id, { body: {} })).toBe(false);
  });

  it('hands a chat request\'s JSON body over, and can answer in another content type', async () => {
    const { server, seen, base } = await start();
    const answer = fetch(`${base}/v1/chat/completions/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'kotomimi', messages: [] }) });
    await until(() => seen.requests.length === 1);
    expect(seen.requests[0]).toMatchObject({ method: 'POST', path: '/v1/chat/completions', body: { model: 'kotomimi', messages: [] } });
    server.reply(seen.requests[0].id, { status: 200, body: 'data: [DONE]\n\n', contentType: 'text/event-stream' });
    const response = await answer;
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(await response.text()).toBe('data: [DONE]\n\n');
  });

  it('answers a preflight itself, and refuses what it does not share and what is not JSON without troubling the page', async () => {
    const { seen, base } = await start();
    const preflight = await fetch(`${base}/v1/chat/completions`, { method: 'OPTIONS' });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
    expect((await fetch(`${base}/v1/audio/speech`, { method: 'POST', body: '{}' })).status).toBe(404);
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: 'not json' })).status).toBe(400);
    expect((await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: 'x'.repeat(1024 * 1024 + 10) })).status).toBe(413);
    expect(seen.requests).toEqual([]);
  });

  it('asks for the access key when one is set: a Bearer token, and nothing reaches the page without it', async () => {
    const { server, seen, base } = await start('s3cret');
    const refused = await fetch(`${base}/v1/models`);
    expect(refused.status).toBe(401);
    // Named even when it will say nothing else without its key.
    expect(decodeURIComponent(refused.headers.get('x-kotomimi-name'))).toBe('里兹 PC');
    expect((await refused.json()).error.code).toBe('invalid_api_key');
    expect((await fetch(`${base}/v1/models`, { headers: { Authorization: 'Bearer wrong!' } })).status).toBe(401);
    expect(seen.requests).toEqual([]);
    const answer = fetch(`${base}/v1/models`, { headers: { Authorization: 'Bearer s3cret' } });
    await until(() => seen.requests.length === 1);
    server.reply(seen.requests[0].id, { body: {} });
    expect((await answer).status).toBe(200);
  });

  it('answers a request whose address cannot be read with 400, before the key, and keeps serving', async () => {
    const { server, seen, base } = await start('k');
    // `new URL` throws on these: thrown in the listener, it took the whole app down (main.js exits on an uncaught exception).
    for (const target of ['//%', 'http://x:99999/']) {
      expect(await rawStatus(server.port, `GET ${target} HTTP/1.1\r\nHost: x\r\n\r\n`)).toBe(400);
      expect(await rawStatus(server.port, `GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`)).toBe(400);
    }
    expect(seen.requests).toEqual([]);
    expect((await fetch(`${base}/v1/models`)).status).toBe(401);
  });

  it('answers the waiting requests when it stops', async () => {
    const { server, seen, base } = await start();
    const answer = fetch(`${base}/v1/models`);
    await until(() => seen.requests.length === 1);
    running = [];
    await server.close();
    expect((await answer).status).toBe(503);
  });
});

describe('the addresses another device is told', () => {
  it('lists the local network\'s own first, then any other, and never the loopback or IPv6', () => {
    expect(lanAddresses({
      Tailscale: [{ family: 'IPv4', internal: false, address: '100.95.1.2' }],
      Loopback: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
      'Wi-Fi': [{ family: 'IPv6', internal: false, address: 'fe80::1' }, { family: 'IPv4', internal: false, address: '192.168.1.20' }],
      Ethernet: [{ family: 'IPv4', internal: false, address: '10.0.0.5' }],
    })).toEqual(['192.168.1.20', '10.0.0.5', '100.95.1.2']);
  });
});

describe('the shared models\' door: the Realtime socket', () => {
  it('opens at /v1/realtime with no subprotocol when none is offered, and carries text both ways', async () => {
    const { server, seen, ws } = await start();
    const { socket, protocol } = await dial(`${ws}/v1/realtime?model=kotomimi`);
    expect(protocol).toBe('');
    await until(() => seen.opened.length === 1);
    expect(seen.opened[0]).toMatchObject({ model: 'kotomimi' });
    const { id } = seen.opened[0];
    const got = [];
    socket.on('message', (data) => got.push(data.toString()));
    expect(server.send(id, JSON.stringify({ type: 'session.created' }))).toBe(true);
    socket.send(JSON.stringify({ type: 'session.update' }));
    await until(() => got.length === 1 && seen.messages.length === 1);
    expect(got).toEqual(['{"type":"session.created"}']);
    expect(seen.messages[0]).toEqual({ id, data: '{"type":"session.update"}' });
    expect(server.count()).toBe(1);
    socket.close();
    await until(() => seen.closed.length === 1);
    expect(seen.closed[0]).toEqual({ id });
    expect(server.count()).toBe(0);
    expect(server.send(id, '{}')).toBe(false);
  });

  it('takes the key the GA way — a subprotocol beside `realtime` — and echoes `realtime` alone', async () => {
    const { seen, ws } = await start('s3cret');
    expect((await dial(`${ws}/v1/realtime`)).status).toBe(401);
    expect((await dial(`${ws}/v1/realtime`, ['realtime', 'openai-insecure-api-key.nope'])).status).toBe(401);
    expect(seen.opened).toEqual([]);
    const { socket, protocol } = await dial(`${ws}/v1/realtime`, ['realtime', 'openai-insecure-api-key.s3cret']);
    expect(protocol).toBe('realtime');
    socket.close();
  });

  it('refuses any other path', async () => {
    const { ws } = await start();
    expect((await dial(`${ws}/v1/other`)).status).toBe(404);
  });

  it('can end a socket from the page\'s side, with a reason', async () => {
    const { server, seen, ws } = await start();
    const { socket } = await dial(`${ws}/v1/realtime`);
    await until(() => seen.opened.length === 1);
    const closed = new Promise((resolve) => socket.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    server.closeSocket(seen.opened[0].id, 1011, 'the model could not load');
    expect(await closed).toEqual({ code: 1011, reason: 'the model could not load' });
  });

  it('cuts a long reason to what a close frame holds — 123 bytes, not 123 characters — on a character\'s edge', async () => {
    const { server, seen, ws } = await start();
    const { socket } = await dial(`${ws}/v1/realtime`);
    await until(() => seen.opened.length === 1);
    const closed = new Promise((resolve) => socket.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    // 60 characters, 180 bytes: cut by characters alone, the socket would throw instead of closing.
    server.closeSocket(seen.opened[0].id, 1011, 'モデルを読み込めませんでした'.repeat(5).slice(0, 60));
    const { code, reason } = await closed;
    expect(code).toBe(1011);
    expect(reason).toBe('モデルを読み込めませんでした'.repeat(5).slice(0, 41));
    expect(Buffer.byteLength(reason)).toBe(123);
  });
});

describe('the shared models\' door: a session left running', () => {
  async function startIdle(idleSessionMs) {
    const seen = { opened: [], closed: [] };
    const server = await startLanServer({ port: 0, host: '127.0.0.1', name: 'MAC', idleSessionMs, idleCheckMs: 20 }, {
      request: () => {},
      socketOpen: (s) => seen.opened.push(s),
      socketMessage: () => {},
      socketClose: (c) => seen.closed.push(c),
    });
    running.push(server);
    return { server, seen, ws: `ws://127.0.0.1:${server.port}` };
  }

  it('is ended, with the reason, once its device has carried no speech for long enough: the model it held is let go', async () => {
    const { seen, ws } = await startIdle(120);
    const { socket } = await dial(`${ws}/v1/realtime?model=kotomimi`);
    const got = [];
    let closed = null;
    socket.on('message', (data) => got.push(JSON.parse(data.toString())));
    socket.on('close', (code, reason) => { closed = { code, reason: reason.toString() }; });
    await until(() => closed !== null);
    expect(got.pop()).toMatchObject({ type: 'error', error: { code: 'session_idle' } });
    expect(closed).toEqual({ code: 1000, reason: 'idle' });
    await until(() => seen.closed.length === 1);
  });

  it('is kept while anything of its device is spoken in: one silent leg beside a spoken one stays', async () => {
    const { server, seen, ws } = await startIdle(250);
    const quiet = await dial(`${ws}/v1/realtime?model=kotomimi`);
    const spoken = await dial(`${ws}/v1/realtime?model=kotomimi`);
    await until(() => seen.opened.length === 2);
    let closes = 0;
    quiet.socket.on('close', () => { closes += 1; });
    spoken.socket.on('close', () => { closes += 1; });
    // Someone speaks on the second socket, again and again: both stay, well past the limit.
    for (let i = 0; i < 6; i += 1) {
      server.send(seen.opened[1].id, JSON.stringify({ type: 'input_audio_buffer.speech_started', item_id: `i${i}` }));
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(closes).toBe(0);
    // Then no one does: both go.
    await until(() => closes === 2);
  });
});

// From the security review of 2026-10-06 (docs/fork/lan-and-phone.md): what the door refuses.
describe('the shared models\' door: who is turned away', () => {
  /** An HTTP request with its own headers, answered with the status and the headers. */
  const ask = (port, path, headers) => new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path, headers }, (response) => {
      response.resume();
      resolve({ status: response.statusCode, headers: response.headers });
    });
    request.on('error', reject);
  });

  it('refuses a Realtime socket opened by a web page, key or not', async () => {
    const { server, ws } = await start();
    // A browser always sends Origin on a WebSocket; the app's own client runs in Node or Electron's main process, or sends its own origin.
    const answer = await new Promise((resolve) => {
      const socket = new WebSocket(`${ws}/v1/realtime`, { headers: { Origin: 'https://attacker.example' } });
      socket.on('open', () => { socket.close(); resolve({ status: 101 }); });
      socket.on('unexpected-response', (_request, response) => resolve({ status: response.statusCode }));
      socket.on('error', () => {});
    });
    expect(answer.status).toBe(403);
    expect(server.count()).toBe(0);
  });

  it('gives a cross-origin page no readable answer: no wildcard', async () => {
    const { server, seen } = await start();
    const answer = ask(server.port, '/v1/models', { Origin: 'https://attacker.example' });
    await new Promise((r) => setTimeout(r, 50));
    for (const r of seen.requests) server.reply(r.id, { body: { object: 'list', data: [] } });
    const { headers } = await answer;
    expect(headers['access-control-allow-origin']).not.toBe('*');
  });

  it('refuses a request sent to this computer under a site\u2019s name (DNS rebinding)', async () => {
    const { server, seen } = await start();
    const answer = ask(server.port, '/v1/models', { Host: `rebind.attacker.example:${server.port}` });
    await new Promise((r) => setTimeout(r, 50));
    for (const r of seen.requests) server.reply(r.id, { body: { object: 'list', data: [] } });
    expect([403, 421]).toContain((await answer).status);
    expect(seen.requests).toHaveLength(0);
  });

  it('answers the app\u2019s own page by its origin, and a web page not at all', async () => {
    const { server, seen } = await start();
    const own = ask(server.port, '/v1/models', { Origin: 'file://' });
    await until(() => seen.requests.length === 1);
    server.reply(seen.requests[0].id, { body: { object: 'list', data: [] } });
    const answered = await own;
    expect(answered.status).toBe(200);
    expect(answered.headers['access-control-allow-origin']).toBe('file://');
    // A web page, whether it reads the answer or only fires the request: refused before the page is troubled.
    for (const origin of ['https://attacker.example', 'http://192.168.1.50', 'null']) {
      expect((await ask(server.port, '/v1/models', { Origin: origin })).status, origin).toBe(403);
    }
    const blind = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, { method: 'POST', headers: { Origin: 'https://attacker.example', 'Content-Type': 'text/plain' }, body: '{"model":"x","messages":[]}' });
    expect(blind.status).toBe(403);
    expect(seen.requests).toHaveLength(1);
  });

  it('is reached by an address, a bare name or a local name, and by no site\u2019s name', () => {
    for (const host of ['192.168.4.29:8790', '[fe80::1]:8790', 'localhost:8790', 'RizumPC:8790', 'rizum-mac.local:8790', 'pc.lan', '', undefined]) expect(isLocalHost(host), String(host)).toBe(true);
    for (const host of ['rebind.attacker.example:8790', 'rizumpc.attacker.com', 'a b', 'evil.com.']) expect(isLocalHost(host), String(host)).toBe(false);
  });

  it('lets in this computer and private networks — a VPN\u2019s range among them — and no public address', async () => {
    for (const address of ['127.0.0.1', '::1', '::ffff:192.168.4.105', '10.0.0.5', '172.16.3.4', '172.31.255.1', '169.254.1.1', '100.101.102.103', 'fe80::1%eth0', 'fd12::1']) expect(isNeighbour(address), address).toBe(true);
    for (const address of ['203.0.113.7', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2001:db8::1', '', undefined]) expect(isNeighbour(address), String(address)).toBe(false);
    // The server itself: a caller from a public address is refused on both doors.
    const seen = { requests: [] };
    const server = await startLanServer({ port: 0, host: '127.0.0.1', addressOf: () => '203.0.113.7' }, { request: (r) => seen.requests.push(r), socketOpen() {}, socketMessage() {}, socketClose() {} });
    running.push(server);
    expect((await ask(server.port, '/v1/models', {})).status).toBe(403);
    expect(await dial(`ws://127.0.0.1:${server.port}/v1/realtime`, ['realtime'])).toEqual({ status: 403 });
    expect(seen.requests).toHaveLength(0);
  });

  it('still names itself to a device that has no key yet: that is how a search lists it, and the name is the network\u2019s to see anyway', async () => {
    // Weighed in the review (F7) and kept: without the name a keyed computer is an address in the list.
    const { server } = await start('the-key');
    const { status, headers } = await ask(server.port, '/v1/models', {});
    expect(status).toBe(401);
    expect(decodeURIComponent(headers['x-kotomimi-name'])).toBe('里兹 PC');
  });

  it('turns an address away for a while after ten wrong keys, and counts neither a right key nor none', async () => {
    const seen = { requests: [] };
    const server = await startLanServer({ port: 0, key: 'the-key', host: '127.0.0.1', keyTries: 3, keyWindowMs: 150 }, { request: (r) => seen.requests.push(r), socketOpen() {}, socketMessage() {}, socketClose() {} });
    running.push(server);
    const wrong = () => ask(server.port, '/v1/models', { Authorization: 'Bearer nope' });
    // A device only looking sends no key: answered 401 every time, and never counted.
    for (let i = 0; i < 6; i += 1) expect((await ask(server.port, '/v1/models', {})).status).toBe(401);
    for (let i = 0; i < 3; i += 1) expect((await wrong()).status).toBe(401);
    expect((await wrong()).status).toBe(429);
    // The right key too, for that while: the count is of the address.
    expect((await ask(server.port, '/v1/models', { Authorization: 'Bearer the-key' })).status).toBe(429);
    expect(await dial(`ws://127.0.0.1:${server.port}/v1/realtime`, ['realtime', 'openai-insecure-api-key.the-key'])).toEqual({ status: 429 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const right = ask(server.port, '/v1/models', { Authorization: 'Bearer the-key' });
    await until(() => seen.requests.length === 1);
    server.reply(seen.requests[0].id, { body: { object: 'list', data: [] } });
    expect((await right).status).toBe(200);
  });

  it('gives one device no more than its share of the sockets', async () => {
    const { server, ws } = await start();
    const mine = [];
    for (let i = 0; i < MAX_SOCKETS_PER_DEVICE; i += 1) mine.push((await dial(`${ws}/v1/realtime`, ['realtime'])).socket);
    expect(mine.every(Boolean)).toBe(true);
    expect(await dial(`${ws}/v1/realtime`, ['realtime'])).toEqual({ status: 503 });
    expect(server.count()).toBe(MAX_SOCKETS_PER_DEVICE);
    // One closed makes room for one.
    mine[0].close();
    await until(() => server.count() === MAX_SOCKETS_PER_DEVICE - 1);
    expect((await dial(`${ws}/v1/realtime`, ['realtime'])).socket).toBeTruthy();
  });

  it('closes a socket that never says what it wants, and leaves one that does', async () => {
    const seen = { closed: [] };
    const server = await startLanServer({ port: 0, host: '127.0.0.1', handshakeTimeoutMs: 80 }, { request() {}, socketOpen() {}, socketMessage() {}, socketClose: (c) => seen.closed.push(c) });
    running.push(server);
    const silent = await dial(`ws://127.0.0.1:${server.port}/v1/realtime`, ['realtime']);
    const spoken = await dial(`ws://127.0.0.1:${server.port}/v1/realtime`, ['realtime']);
    spoken.socket.send(JSON.stringify({ type: 'session.update', session: {} }));
    let code = null;
    silent.socket.on('close', (c) => { code = c; });
    await until(() => code !== null);
    expect(code).toBe(1008);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(spoken.socket.readyState).toBe(1);
    expect(server.count()).toBe(1);
  });
});
