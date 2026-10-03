// Fork: sharing this computer's models on the local network.
//
// The models run in the page (its workers hold them), so this process only
// holds the door: one HTTP server that takes OpenAI-shaped requests and a
// Realtime WebSocket, checks the access key when one is set, and hands
// everything inside to the page — which answers through `reply`, `send` and
// `closeSocket`. Nothing here knows a model, a language or a protocol event.
//
// What is served, and only this:
//   GET  /v1/models, /v1/models/capabilities
//   POST /v1/chat/completions
//   WS   /v1/realtime
//
// Kept apart from main.js, with no Electron import, so its tests start a real
// server on the loopback and talk to it.
const http = require('http');
const os = require('os');
const { WebSocketServer } = require('ws');

/** A request's JSON body may be this long: a chat request carries a sentence, not a file. */
const MAX_BODY_BYTES = 1024 * 1024;
/** One socket message: a chunk of audio as base64, a few kilobytes; this is far above it. */
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
/** The page has this long to answer a request before the caller is told it did not. */
const REPLY_TIMEOUT_MS = 120_000;
/** Sockets at once: each holds a recognizer in memory. */
const MAX_SOCKETS = 6;

const REALTIME_PATH = '/v1/realtime';
const ROUTES = new Set(['GET /v1/models', 'GET /v1/models/capabilities', 'POST /v1/chat/completions']);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Max-Age': '600',
};

/** A home or office network's own range: the address another device on the same network dials. */
const isPrivate = (address) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address);

/** This computer's IPv4 addresses, the ones another device could dial: its local network's first, then any other (a VPN's, a tunnel's). */
function lanAddresses(interfaces = os.networkInterfaces()) {
  const out = [];
  for (const list of Object.values(interfaces)) {
    for (const address of list ?? []) {
      if (address.family === 'IPv4' && !address.internal) out.push(address.address);
    }
  }
  return [...out.filter(isPrivate), ...out.filter((address) => !isPrivate(address))];
}

/** The key a request carries: a Bearer token, or — a browser's socket, which can set no header — the GA Realtime subprotocol. */
function keyOf(request) {
  const header = request.headers.authorization;
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  const offered = String(request.headers['sec-websocket-protocol'] ?? '').split(',').map((p) => p.trim());
  const carried = offered.find((p) => p.startsWith('openai-insecure-api-key.'));
  return carried ? carried.slice('openai-insecure-api-key.'.length) : '';
}

/** Compared in constant time for equal lengths: a key is short, and a timing probe on a LAN is still a probe. */
function sameKey(given, wanted) {
  if (given.length !== wanted.length) return false;
  let diff = 0;
  for (let i = 0; i < wanted.length; i += 1) diff |= given.charCodeAt(i) ^ wanted.charCodeAt(i);
  return diff === 0;
}

/**
 * Starts the server. `handlers` is the page's side:
 *   request({ id, method, path, body })   answered later through `reply(id, …)`
 *   socketOpen({ id, model, address })
 *   socketMessage({ id, data })
 *   socketClose({ id })
 * Resolves once listening, with what the page then calls back; rejects when
 * the port cannot be bound.
 */
function startLanServer({ port, key = '', host = '0.0.0.0' }, handlers) {
  const wanted = String(key ?? '');
  const allowed = (request) => wanted === '' || sameKey(keyOf(request), wanted);
  let nextId = 0;
  /** Requests the page has not answered yet. */
  const waiting = new Map();
  /** Open sockets, by the id the page knows them by. */
  const sockets = new Map();

  const json = (response, status, body, headers = {}) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...headers });
    response.end(text);
  };
  const refuse = (response, status, code, message) => json(response, status, { error: { message, type: 'invalid_request_error', code } });

  const server = http.createServer((request, response) => {
    const { pathname } = new URL(request.url ?? '/', 'http://kotomimi');
    const path = pathname.replace(/\/+$/, '') || '/';
    if (request.method === 'OPTIONS') {
      response.writeHead(204, CORS);
      response.end();
      return;
    }
    if (!ROUTES.has(`${request.method} ${path}`)) {
      refuse(response, 404, 'not_found', `Kotomimi shares no ${request.method} ${path}.`);
      return;
    }
    if (!allowed(request)) {
      refuse(response, 401, 'invalid_api_key', 'This Kotomimi asks for its access key.');
      return;
    }
    const chunks = [];
    let size = 0;
    let tooLong = false;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) tooLong = true;
      else chunks.push(chunk);
    });
    request.on('end', () => {
      if (tooLong) {
        refuse(response, 413, 'too_large', 'The request is too long.');
        return;
      }
      let body = null;
      if (request.method === 'POST') {
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
        } catch {
          refuse(response, 400, 'invalid_json', 'The request body is not JSON.');
          return;
        }
      }
      const id = `r${++nextId}`;
      const timer = setTimeout(() => {
        if (!waiting.delete(id)) return;
        refuse(response, 504, 'timeout', 'Kotomimi did not answer in time.');
      }, REPLY_TIMEOUT_MS);
      waiting.set(id, { response, timer });
      // The caller went away: the page's answer has no one to go to.
      response.on('close', () => {
        const pending = waiting.get(id);
        if (pending && !response.writableEnded) {
          clearTimeout(pending.timer);
          waiting.delete(id);
        }
      });
      handlers.request({ id, method: request.method, path, body });
    });
  });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_BYTES,
    // The GA client offers `realtime` beside its key; one that offers nothing (no key) is answered with nothing.
    handleProtocols: (protocols) => (protocols.has('realtime') ? 'realtime' : false),
  });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://kotomimi');
    const reject = (status, text) => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (url.pathname.replace(/\/+$/, '') !== REALTIME_PATH) return reject(404, 'Not Found');
    if (!allowed(request)) return reject(401, 'Unauthorized');
    if (sockets.size >= MAX_SOCKETS) return reject(503, 'Busy');
    wss.handleUpgrade(request, socket, head, (ws) => {
      const id = `s${++nextId}`;
      sockets.set(id, ws);
      ws.on('message', (data, isBinary) => {
        // The Realtime wire is JSON text; a binary frame is none of it.
        if (!isBinary) handlers.socketMessage({ id, data: data.toString('utf8') });
      });
      ws.on('close', () => {
        if (sockets.delete(id)) handlers.socketClose({ id });
      });
      ws.on('error', () => {});
      handlers.socketOpen({ id, model: url.searchParams.get('model') ?? '', address: request.socket.remoteAddress ?? '' });
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      server.on('error', () => {});
      resolve({
        port: server.address().port,
        addresses: lanAddresses(),
        /** The page's answer to a request: a status and a body — JSON, or text with its own content type. */
        reply(id, { status = 200, body = null, contentType } = {}) {
          const pending = waiting.get(id);
          if (!pending) return false;
          waiting.delete(id);
          clearTimeout(pending.timer);
          if (contentType) {
            pending.response.writeHead(status, { 'Content-Type': contentType, ...CORS });
            pending.response.end(String(body ?? ''));
          } else {
            json(pending.response, status, body);
          }
          return true;
        },
        /** One JSON text frame to a socket. */
        send(id, data) {
          const ws = sockets.get(id);
          if (!ws || ws.readyState !== 1) return false;
          ws.send(String(data));
          return true;
        },
        closeSocket(id, code = 1000, reason = '') {
          sockets.get(id)?.close(code, String(reason).slice(0, 120));
        },
        /** How many sockets are open now. */
        count: () => sockets.size,
        /** Stops listening, ends every socket and answers every waiting request. */
        close() {
          for (const [id, pending] of waiting) {
            clearTimeout(pending.timer);
            refuse(pending.response, 503, 'stopped', 'Kotomimi stopped sharing.');
            waiting.delete(id);
          }
          for (const ws of sockets.values()) ws.terminate();
          sockets.clear();
          wss.close();
          return new Promise((done) => {
            server.close(() => done());
            server.closeAllConnections?.();
          });
        },
      });
    });
  });
}

module.exports = { startLanServer, lanAddresses, MAX_SOCKETS };
