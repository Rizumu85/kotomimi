// Fork: sharing this computer's models on the local network.
//
// The models run in the page (its workers hold them), so this process only
// holds the door: one HTTP server that takes OpenAI-shaped requests and a
// Realtime WebSocket, checks the access key when one is set, and hands
// everything inside to the page — which answers through `reply`, `send` and
// `closeSocket`.
//
// One thing is not the page's: a model server on this same computer (a
// LocalAI), when the door is given one (`upstream`, `lan-upstream.js`). Its
// models join the lists the page answers, and what asks for one of them — a
// chat request by its model's name, a socket by the recognizer its first
// `session.update` names — is passed on to it. That is all the door reads of a
// request: a model's name.
//
// What is served, and only this:
//   GET  /v1/models, /v1/models/capabilities
//   POST /v1/chat/completions
//   WS   /v1/realtime
//
// A session left running is not left holding a model. A device that forgot
// to stop keeps sending its microphone's silence, and whatever hears it stays
// in memory for as long as the socket is open. So a device whose sockets
// have carried no speech for `idleSessionMs` has them ended, with an error
// that says why (`session_idle`, which the client words for its user); the
// recognizer is then let go, as at any close. A device is judged by all its
// sockets together: one leg of a run may be silent for as long as the other
// is spoken in.
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
/** A device none of whose sockets has carried speech for this long has them ended. */
const IDLE_SESSION_MS = 30 * 60_000;
/** How often that is looked at. */
const IDLE_CHECK_MS = 30_000;
/** What a frame that means "someone is speaking" holds: the start of speech, or any word of a transcript. */
const SPEECH = /"input_audio_buffer\.speech_started"|"conversation\.item\.input_audio_transcription\./;
/** Sockets at once: each holds a recognizer in memory. */
const MAX_SOCKETS = 6;

const REALTIME_PATH = '/v1/realtime';
const ROUTES = new Set(['GET /v1/models', 'GET /v1/models/capabilities', 'POST /v1/chat/completions']);

/** On a model list that holds a local model server's models too: a searching device then lists this computer once (`lan-discover.js`). */
const INCLUDES_HEADER = 'X-Kotomimi-Includes';
const INCLUDES_MODEL_SERVER = 'model-server';
/** The owner the passed-on models name: anything but the app's own (`src/lib/lan/protocol.ts`), by which a client knows a model is a chat model like any other. */
const UPSTREAM_OWNER = 'localai';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'X-Kotomimi-Name, X-Kotomimi-Includes',
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

/**
 * A close's reason as a close frame can carry it: 123 bytes of UTF-8 at most
 * (RFC 6455), cut on a character's edge. Longer, the socket throws rather than
 * close — and words from LocalAI or a path in a user's home need not be ASCII.
 */
function closeReason(text) {
  const chars = Array.from(String(text ?? '')).slice(0, 123);
  while (Buffer.byteLength(chars.join('')) > 123) chars.pop();
  return chars.join('');
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
 *   socketProxied({ id })                  the socket is the model server's from here on: the page lets go of it, and still counts it
 * `upstream` is the model server on this computer, when there is one to share
 * (`lan-upstream.js`): asked for its models, and for whether a request is its.
 * Resolves once listening, with what the page then calls back; rejects when
 * the port cannot be bound. `name` is this computer's: every answer carries it
 * in a header, so a device searching the network (`lan-discover.js`) can list
 * this one by a name its owner knows.
 */
function startLanServer({ port, key = '', host = '0.0.0.0', name = os.hostname(), upstream = null, idleSessionMs = IDLE_SESSION_MS, idleCheckMs = IDLE_CHECK_MS }, handlers) {
  const wanted = String(key ?? '');
  const NAMED = { ...CORS, 'X-Kotomimi-Name': encodeURIComponent(String(name).slice(0, 80)) };
  const allowed = (request) => wanted === '' || sameKey(keyOf(request), wanted);
  let nextId = 0;
  /** Requests the page has not answered yet. */
  const waiting = new Map();
  /** Open sockets, by the id the page knows them by. */
  const sockets = new Map();
  /** The model server's side of a socket that was passed on to it, by the same id. */
  const links = new Map();
  /** The device each socket came from, and when speech was last carried for each device. */
  const devices = new Map();
  const spoken = new Map();
  /** What goes to a device: noted when it says someone is speaking. */
  const out = (id, ws, data) => {
    if (ws.readyState !== 1) return false;
    const text = String(data);
    if (SPEECH.test(text)) spoken.set(devices.get(id), Date.now());
    ws.send(text);
    return true;
  };
  const idle = setInterval(() => {
    const now = Date.now();
    for (const [id, ws] of sockets) {
      if (now - (spoken.get(devices.get(id)) ?? now) < idleSessionMs) continue;
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', code: 'session_idle', message: `No speech for ${Math.round(idleSessionMs / 60_000)} minutes: the session was ended so this computer can let its models go. Start again to continue.` } }));
      ws.close(1000, 'idle');
    }
  }, idleCheckMs);
  idle.unref?.();

  const json = (response, status, body, headers = {}) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...NAMED, ...headers });
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
      /** To the page, as everything is; `extra` is the model server's list, joined to the page's when both have come. */
      const hand = (extra = null) => {
        const id = `r${++nextId}`;
        const timer = setTimeout(() => {
          if (!waiting.delete(id)) return;
          refuse(response, 504, 'timeout', 'Kotomimi did not answer in time.');
        }, REPLY_TIMEOUT_MS);
        waiting.set(id, { response, timer, extra, path });
        // The caller went away: the page's answer has no one to go to.
        response.on('close', () => {
          const pending = waiting.get(id);
          if (pending && !response.writableEnded) {
            clearTimeout(pending.timer);
            waiting.delete(id);
          }
        });
        handlers.request({ id, method: request.method, path, body });
      };
      if (!upstream) return hand();
      if (request.method === 'GET') return hand(Promise.resolve().then(() => upstream.models()).catch(() => []));
      // A chat request: the model server's when it names one of its models, or leaves the choice to a computer that has one.
      Promise.resolve().then(() => upstream.chatModel(body?.model)).then((model) => {
        if (model) upstream.complete(body, model, response, NAMED);
        else hand();
      }, () => hand());
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
      const device = request.socket.remoteAddress ?? id;
      devices.set(id, device);
      // A device that opens a session is using this computer now: its quiet time starts over.
      spoken.set(device, Date.now());
      // Whose the socket is. The page opens every session; the first `session.update` then says which recognizer is
      // wanted, and one of the model server's makes the socket its own from there on.
      let whose = upstream ? 'undecided' : 'page';
      const held = [];
      const toPage = (text) => handlers.socketMessage({ id, data: text });
      const decide = (text, wanted) => {
        whose = 'deciding';
        Promise.resolve().then(() => upstream.recognizer(wanted)).catch(() => null).then((route) => {
          if (!sockets.has(id)) return;
          if (!route) {
            whose = 'page';
            toPage(text);
            for (const later of held.splice(0)) toPage(later);
            return;
          }
          whose = 'upstream';
          handlers.socketProxied?.({ id });
          let update = {};
          try {
            update = JSON.parse(text);
          } catch {
            update = {};
          }
          const link = upstream.bridge(route, {
            update,
            send: (data) => { out(id, ws, data); },
            close: (code, reason) => ws.close(code, closeReason(reason)),
          });
          links.set(id, link);
          for (const later of held.splice(0)) link.send(later);
        });
      };
      ws.on('message', (data, isBinary) => {
        // The Realtime wire is JSON text; a binary frame is none of it.
        if (isBinary) return;
        const text = data.toString('utf8');
        if (whose === 'page') return toPage(text);
        if (whose === 'upstream') return links.get(id)?.send(text);
        if (whose === 'deciding') return held.push(text);
        let event = null;
        try {
          event = JSON.parse(text);
        } catch {
          event = null;
        }
        if (event?.type !== 'session.update') return toPage(text);
        const named = event.session?.audio?.input?.transcription?.model;
        return decide(text, typeof named === 'string' ? named : '');
      });
      ws.on('close', (code, reason) => {
        links.get(id)?.close(code, reason);
        links.delete(id);
        devices.delete(id);
        if (![...devices.values()].includes(device)) spoken.delete(device);
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
        name: String(name),
        /** The page's answer to a request: a status and a body — JSON, or text with its own content type. */
        reply(id, { status = 200, body = null, contentType } = {}) {
          const pending = waiting.get(id);
          if (!pending) return false;
          waiting.delete(id);
          clearTimeout(pending.timer);
          if (contentType) {
            pending.response.writeHead(status, { 'Content-Type': contentType, ...NAMED });
            pending.response.end(String(body ?? ''));
          } else if (pending.extra && status === 200 && body && Array.isArray(body.data)) {
            // A model list: the model server's models after the page's, each once.
            pending.extra.then((extra) => {
              const have = new Set(body.data.map((m) => m?.id));
              const more = (Array.isArray(extra) ? extra : []).filter((m) => m && typeof m.id === 'string' && !have.has(m.id));
              const data = [...body.data, ...more.map((m) => (pending.path.endsWith('/capabilities') ? { id: m.id, capabilities: m.capabilities } : { id: m.id, object: 'model', owned_by: UPSTREAM_OWNER }))];
              json(pending.response, status, { ...body, data }, more.length > 0 ? { [INCLUDES_HEADER]: INCLUDES_MODEL_SERVER } : {});
            });
          } else {
            json(pending.response, status, body);
          }
          return true;
        },
        /** One JSON text frame to a socket. */
        send(id, data) {
          const ws = sockets.get(id);
          return ws ? out(id, ws, data) : false;
        },
        closeSocket(id, code = 1000, reason = '') {
          sockets.get(id)?.close(code, closeReason(reason));
        },
        /** How many sockets are open now. */
        count: () => sockets.size,
        /** Stops listening, ends every socket and answers every waiting request. */
        close() {
          clearInterval(idle);
          for (const [id, pending] of waiting) {
            clearTimeout(pending.timer);
            refuse(pending.response, 503, 'stopped', 'Kotomimi stopped sharing.');
            waiting.delete(id);
          }
          for (const link of links.values()) link.close();
          links.clear();
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

module.exports = { startLanServer, lanAddresses, MAX_SOCKETS, IDLE_SESSION_MS };
