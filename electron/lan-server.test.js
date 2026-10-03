// @vitest-environment node
// electron/lan-server.test.js
//
// Fork: the door of "share this computer's models" — a real server on the
// loopback, a real client. What is behind the door (the page) is a recorder
// here: this file holds only what the door itself decides.
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import WebSocket from 'ws';

const require = createRequire(import.meta.url);
const { startLanServer, lanAddresses } = require('./lan-server.js');

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

/** A socket, settled: open with its subprotocol, or refused with the HTTP status. */
const dial = (url, protocols) => new Promise((resolve) => {
  const socket = new WebSocket(url, protocols);
  socket.on('open', () => resolve({ socket, protocol: socket.protocol }));
  socket.on('unexpected-response', (_request, response) => resolve({ status: response.statusCode }));
  socket.on('error', () => {});
});

describe('the shared models\' door: HTTP', () => {
  it('hands a GET to the page and answers with what the page replies, readable from any origin', async () => {
    const { server, seen, base } = await start();
    const answer = fetch(`${base}/v1/models`);
    await until(() => seen.requests.length === 1);
    expect(seen.requests[0]).toMatchObject({ method: 'GET', path: '/v1/models', body: null });
    expect(server.reply(seen.requests[0].id, { body: { object: 'list', data: [{ id: 'kotomimi' }] } })).toBe(true);
    const response = await answer;
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
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
    expect(preflight.headers.get('access-control-allow-headers')).toContain('Authorization');
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
});
