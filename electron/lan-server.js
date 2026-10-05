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
const crypto = require('crypto');
const http = require('http');
const net = require('net');
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
/** And from one device: a session of two legs, and one more of each while it reconnects. The rest are for the others. */
const MAX_SOCKETS_PER_DEVICE = 4;
/** What is kept of a socket's messages while it is decided whose the socket is: a minute of audio is under 4 MiB as base64. */
const MAX_HELD_BYTES = 8 * 1024 * 1024;
/** How long that decision may take before the page takes the socket, as it takes every other. */
const DECIDE_TIMEOUT_MS = 15_000;
/** A socket says what it wants (`session.update`) within this long of opening, or it is closed: an open socket holds a place. */
const HANDSHAKE_TIMEOUT_MS = 30_000;
/** Wrong keys from one address, within a minute, before it is turned away for a minute: a short key is not guessed at a thousand tries a second. */
const KEY_TRIES = 10;
const KEY_WINDOW_MS = 60_000;

const REALTIME_PATH = '/v1/realtime';
const ROUTES = new Set(['GET /v1/models', 'GET /v1/models/capabilities', 'POST /v1/chat/completions']);

/** On a model list that holds a local model server's models too: a searching device then lists this computer once (`lan-discover.js`). */
const INCLUDES_HEADER = 'X-Kotomimi-Includes';
const INCLUDES_MODEL_SERVER = 'model-server';
/** The owner the passed-on models name: anything but the app's own (`src/lib/lan/protocol.ts`), by which a client knows a model is a chat model like any other. */
const UPSTREAM_OWNER = 'localai';

/**
 * The origins a request may name. The app's own page is a file, and its
 * requests name `file://` or nothing; a program names nothing. A web page
 * names its site — and no web page has any business here: with a wildcard
 * answer any page open in a browser on this network could read the model list
 * and run the models (security review, 2026-10-06).
 */
const OWN_ORIGINS = new Set(['file://']);
const originOf = (request) => (typeof request?.headers?.origin === 'string' ? request.headers.origin : '');
/** What a page of the app's own is answered with: its origin by name, never a wildcard. Nothing for a request that names none. */
const corsFor = (request) => {
  const origin = originOf(request);
  if (!origin || !OWN_ORIGINS.has(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
    'Access-Control-Expose-Headers': 'X-Kotomimi-Name, X-Kotomimi-Includes',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '600',
  };
};

/** The names only a local network gives a computer: a web site's name never ends in one, so a page cannot be pointed here under its own name. */
const LOCAL_SUFFIXES = ['.local', '.lan', '.home', '.internal', '.localdomain', '.home.arpa', '.fritz.box'];
/**
 * Whether the name a request was sent to is one this computer goes by on its
 * own network: an address, `localhost`, a bare name, or a name of a local
 * domain. A site's name — `rebind.example.com` — is how a page in a browser
 * reaches a computer on its visitor's network (DNS rebinding): refused.
 */
function isLocalHost(header) {
  if (typeof header !== 'string' || header === '') return true;
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(header);
  const host = (bracketed ? bracketed[1] : header.replace(/:\d+$/, '')).toLowerCase();
  if (net.isIP(host)) return true;
  if (!/^[a-z0-9._-]+$/.test(host)) return false;
  return !host.includes('.') || LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * Whether an address is this computer's, or one of a private network: a home
 * or office network, a link-local address, the range a VPN such as Tailscale
 * hands out, IPv6's own private ranges. A public address is not a neighbour,
 * whatever interface it came in by.
 */
function isNeighbour(address) {
  const text = String(address ?? '').replace(/^::ffff:/i, '').replace(/%.*$/, '').toLowerCase();
  if (net.isIPv4(text)) {
    const [a, b] = text.split('.').map(Number);
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIPv6(text)) return text === '::1' || /^f[cd]/.test(text) || /^fe[89ab]/.test(text);
  return false;
}

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

/**
 * The address a request names, or null when it cannot be read (`GET //%`, `GET http://x:99999/`). Never thrown:
 * a throw in a listener is an uncaught exception, and the main process ends the app on one.
 */
function urlOf(target) {
  try {
    return new URL(target ?? '/', 'http://kotomimi');
  } catch {
    return null;
  }
}

/** Compared in constant time, whatever their lengths: both are hashed first, so neither a key's letters nor its length shows in how long the answer takes. */
function sameKey(given, wanted) {
  const digest = (text) => crypto.createHash('sha256').update(String(text), 'utf8').digest();
  return crypto.timingSafeEqual(digest(given), digest(wanted));
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
function startLanServer({ port, key = '', host = '0.0.0.0', name = os.hostname(), upstream = null, idleSessionMs = IDLE_SESSION_MS, idleCheckMs = IDLE_CHECK_MS, heldMaxBytes = MAX_HELD_BYTES, decideTimeoutMs = DECIDE_TIMEOUT_MS, handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS, keyTries = KEY_TRIES, keyWindowMs = KEY_WINDOW_MS, addressOf = (request) => request.socket.remoteAddress }, handlers) {
  const wanted = String(key ?? '');
  const NAME = { 'X-Kotomimi-Name': encodeURIComponent(String(name).slice(0, 80)) };
  /** A response's own headers: this computer's name, and what its request's origin is owed. */
  const named = (request) => ({ ...corsFor(request), ...NAME });
  /** Wrong keys by address: how many since when. A key that is right, or none at all (a device only looking), counts for nothing. */
  const tries = new Map();
  /** 'ok', 'refused' (no key, or a wrong one), or 'throttled' (too many wrong ones from this address lately). */
  const keyCheck = (request) => {
    if (wanted === '') return 'ok';
    const address = addressOf(request) ?? '';
    const now = Date.now();
    const seen = tries.get(address);
    if (seen && now - seen.since >= keyWindowMs) tries.delete(address);
    else if (seen && seen.count >= keyTries) return 'throttled';
    const given = keyOf(request);
    if (sameKey(given, wanted)) return 'ok';
    if (given !== '') {
      const counted = tries.get(address) ?? { count: 0, since: now };
      counted.count += 1;
      tries.set(address, counted);
    }
    return 'refused';
  };
  /**
   * Who is turned away before anything else is looked at: an address that is
   * not a neighbour's, a web page (a request that names a site as its origin),
   * and a request sent to this computer under a site's name. Null: let in.
   */
  const stranger = (request) => {
    if (!isNeighbour(addressOf(request))) return 'This Kotomimi shares with its own network only.';
    const origin = originOf(request);
    if (origin && !OWN_ORIGINS.has(origin)) return 'This Kotomimi answers no web page.';
    if (!isLocalHost(request.headers.host)) return 'This Kotomimi is not reached by that name.';
    return null;
  };
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
    for (const [address, seen] of tries) if (now - seen.since >= keyWindowMs) tries.delete(address);
    for (const [id, ws] of sockets) {
      if (now - (spoken.get(devices.get(id)) ?? now) < idleSessionMs) continue;
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', code: 'session_idle', message: `No speech for ${Math.round(idleSessionMs / 60_000)} minutes: the session was ended so this computer can let its models go. Start again to continue.` } }));
      ws.close(1000, 'idle');
    }
  }, idleCheckMs);
  idle.unref?.();

  const json = (response, status, body, headers = {}) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...named(response.req), ...headers });
    response.end(text);
  };
  const refuse = (response, status, code, message) => json(response, status, { error: { message, type: 'invalid_request_error', code } });

  const server = http.createServer((request, response) => {
    const url = urlOf(request.url);
    if (!url) {
      refuse(response, 400, 'bad_request', 'The request names no readable address.');
      return;
    }
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const turnedAway = stranger(request);
    if (turnedAway) {
      refuse(response, 403, 'forbidden', turnedAway);
      return;
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, corsFor(request));
      response.end();
      return;
    }
    if (!ROUTES.has(`${request.method} ${path}`)) {
      refuse(response, 404, 'not_found', `Kotomimi shares no ${request.method} ${path}.`);
      return;
    }
    const key = keyCheck(request);
    if (key === 'throttled') {
      refuse(response, 429, 'too_many_attempts', 'Too many wrong access keys from this device. Try again in a minute.');
      return;
    }
    if (key !== 'ok') {
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
      Promise.resolve().then(() => upstream.chatModel(body?.model, body)).then((model) => {
        if (model) upstream.complete(body, model, response, named(request));
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
    const url = urlOf(request.url);
    const reject = (status, text) => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (!url) return reject(400, 'Bad Request');
    if (stranger(request)) return reject(403, 'Forbidden');
    if (url.pathname.replace(/\/+$/, '') !== REALTIME_PATH) return reject(404, 'Not Found');
    const key = keyCheck(request);
    if (key === 'throttled') return reject(429, 'Too Many Requests');
    if (key !== 'ok') return reject(401, 'Unauthorized');
    if (sockets.size >= MAX_SOCKETS) return reject(503, 'Busy');
    // One device does not take every place: the others' sessions need theirs.
    const from = addressOf(request) ?? '';
    if ([...devices.values()].filter((device) => device === from).length >= MAX_SOCKETS_PER_DEVICE) return reject(503, 'Busy');
    wss.handleUpgrade(request, socket, head, (ws) => {
      const id = `s${++nextId}`;
      sockets.set(id, ws);
      const device = addressOf(request) ?? id;
      devices.set(id, device);
      // A device that opens a session is using this computer now: its quiet time starts over.
      spoken.set(device, Date.now());
      // Whose the socket is. The page opens every session; the first `session.update` then says which recognizer is
      // wanted, and one of the model server's makes the socket its own from there on.
      let whose = upstream ? 'undecided' : 'page';
      const held = [];
      let heldBytes = 0;
      /** Ends the wait for the decision, when the socket goes first. */
      let deciding = () => {};
      // A socket that never says what it wants holds a place for nothing: it is given a while, then closed.
      let configured = false;
      const handshake = setTimeout(() => { if (!configured && ws.readyState === 1) ws.close(1008, 'No session was set up.'); }, handshakeTimeoutMs);
      handshake.unref?.();
      const toPage = (text) => handlers.socketMessage({ id, data: text });
      const decide = (text, wanted, language) => {
        whose = 'deciding';
        // A model server slow to say what it serves does not keep the device waiting, or the door holding its
        // messages, for ever: after a while the page takes the socket, as it takes every other.
        let patience = null;
        const tooLong = new Promise((resolve) => { patience = setTimeout(() => resolve(null), decideTimeoutMs); patience.unref?.(); });
        deciding = () => clearTimeout(patience);
        Promise.race([Promise.resolve().then(() => upstream.recognizer(wanted, language)).catch(() => null), tooLong]).then((route) => {
          clearTimeout(patience);
          if (!sockets.has(id) || whose !== 'deciding') return;
          heldBytes = 0;
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
        if (!configured && text.includes('"session.update"')) {
          configured = true;
          clearTimeout(handshake);
        }
        if (whose === 'page') return toPage(text);
        if (whose === 'upstream') return links.get(id)?.send(text);
        if (whose === 'deciding') {
          // Kept only up to a bound: a device that streams while the decision is awaited does not fill this
          // computer's memory (security review, 2026-10-06: one socket took the process to 900 MB in six seconds).
          heldBytes += text.length;
          if (heldBytes > heldMaxBytes) {
            held.length = 0;
            whose = 'closed';
            return ws.close(1009, 'Too much was sent before the session was set up.');
          }
          return held.push(text);
        }
        if (whose === 'closed') return undefined;
        let event = null;
        try {
          event = JSON.parse(text);
        } catch {
          event = null;
        }
        if (event?.type !== 'session.update') return toPage(text);
        const named = event.session?.audio?.input?.transcription?.model;
        const language = event.session?.audio?.input?.transcription?.language;
        return decide(text, typeof named === 'string' ? named : '', typeof language === 'string' ? language : '');
      });
      ws.on('close', (code, reason) => {
        clearTimeout(handshake);
        deciding();
        held.length = 0;
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
            pending.response.writeHead(status, { 'Content-Type': contentType, ...named(pending.response.req) });
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

module.exports = { startLanServer, lanAddresses, isNeighbour, isLocalHost, MAX_SOCKETS, MAX_SOCKETS_PER_DEVICE, MAX_HELD_BYTES, IDLE_SESSION_MS };
