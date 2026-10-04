// Fork: finding, on the local network, what this app can use another
// device's models through — a Kotomimi sharing its models, or a server that
// speaks OpenAI's wire (a LocalAI).
//
// A person asked for "the server's address" has no way to know whether the
// one they see is right. So the app looks instead: it asks every address of
// its own network, on the two ports these servers keep by default, for
// `GET /v1/models`, and lists whatever answers like one. Nothing is sent
// but that request, and nothing is asked beyond this computer's own
// network: a network wider than 256 addresses is searched only around this
// computer's own address, and a VPN's or a tunnel's not at all.
//
// A Kotomimi says so in every model it lists (`owned_by`), and gives its
// computer's name in a header. A server that asks for a key is still found:
// it answers 401, and is listed as wanting one.
//
// No Electron import: its tests search a real server on the loopback.
const http = require('http');
const os = require('os');
const dns = require('dns');

/** Where a sharing Kotomimi listens unless told otherwise, and where a LocalAI does. */
const KOTOMIMI_PORT = 8790;
const SERVER_PORT = 8080;
/** A device on the same network answers in a few milliseconds: this long is for a busy one. */
const PROBE_TIMEOUT_MS = 600;
/** Requests in flight at once. */
const CONCURRENCY = 170;
/** A model list is a few kilobytes: more than this is something else. */
const MAX_LIST_BYTES = 512 * 1024;
/** The header a sharing Kotomimi names its computer in (`lan-server.js`). */
const NAME_HEADER = 'x-kotomimi-name';
/** Set by a Kotomimi whose model list holds the models of a model server on its own computer (`lan-server.js`). */
const INCLUDES_HEADER = 'x-kotomimi-includes';

/** A home or office network's own range. */
const isPrivate = (address) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address);

const toNumber = (address) => address.split('.').reduce((n, part) => n * 256 + Number(part), 0);
const toAddress = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

/**
 * The addresses to ask, for one of this computer's own: its network's, when
 * that is 256 addresses or fewer, else the 256 around it — without the
 * network's own address and its broadcast address.
 */
function neighbours(address, netmask) {
  const own = toNumber(address);
  const mask = Math.max(toNumber(netmask || '255.255.255.0'), 0xffffff00) >>> 0;
  const base = (own & mask) >>> 0;
  const size = (~mask >>> 0) + 1;
  const out = [];
  for (let i = 1; i < size - 1; i += 1) out.push(toAddress(base + i));
  return out;
}

/**
 * Every address and port to ask. This computer's own addresses are asked
 * too — a server may run beside the app — as the loopback, and only on the
 * ports this app does not listen on itself (`ownPorts`).
 */
function targets(interfaces = os.networkInterfaces(), { ports = [KOTOMIMI_PORT, SERVER_PORT], ownPorts = [] } = {}) {
  const own = new Set();
  const hosts = new Set();
  for (const list of Object.values(interfaces)) {
    for (const entry of list ?? []) {
      if (entry.family !== 'IPv4' || entry.internal || !isPrivate(entry.address)) continue;
      own.add(entry.address);
      for (const host of neighbours(entry.address, entry.netmask)) hosts.add(host);
    }
  }
  const out = [];
  for (const port of ports) {
    if (!ownPorts.includes(port)) out.push({ host: '127.0.0.1', port, self: true });
    for (const host of hosts) if (!own.has(host)) out.push({ host, port, self: false });
  }
  return out;
}

/** What an answer to `GET /v1/models` says of the server, or null when it is no such server. */
function readAnswer(status, headers, body) {
  const named = typeof headers[NAME_HEADER] === 'string' ? headers[NAME_HEADER] : '';
  let name = '';
  try {
    name = decodeURIComponent(named).slice(0, 80);
  } catch {
    name = '';
  }
  // A Kotomimi that shares the models of a model server on its own computer says so: that server is then not listed apart.
  const includes = headers[INCLUDES_HEADER] === 'model-server';
  if (status === 401 || status === 403) return { kind: named ? 'kotomimi' : 'server', name, models: 0, needsKey: true, includes: false };
  if (status !== 200) return null;
  let list;
  try {
    list = JSON.parse(body);
  } catch {
    return null;
  }
  if (!list || !Array.isArray(list.data)) return null;
  const models = list.data.filter((m) => m && typeof m.id === 'string');
  const kotomimi = models.some((m) => m.owned_by === 'kotomimi');
  // A sharing Kotomimi lists its pipeline first, which is no model of its own to count.
  return { kind: kotomimi ? 'kotomimi' : 'server', name, models: kotomimi ? Math.max(models.length - 1, 0) : models.length, needsKey: false, includes: kotomimi && includes };
}

/** One GET. Resolves with the answer, or null when there was none in time: never rejects. */
function get(host, port, path, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      request.destroy();
      resolve(value);
    };
    const request = http.get({ host, port, path, agent: false, headers: { Accept: 'application/json' } }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_LIST_BYTES) finish(null);
        else chunks.push(chunk);
      });
      response.on('end', () => finish({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', () => finish(null));
    });
    const timer = setTimeout(() => finish(null), timeoutMs);
    request.on('error', () => finish(null));
  });
}

/** Asks one address. Resolves with what is there, or null. */
async function probe({ host, port, self }, timeoutMs = PROBE_TIMEOUT_MS) {
  const answer = await get(host, port, '/v1/models', timeoutMs);
  const found = answer && readAnswer(answer.status, answer.headers, answer.body);
  return found ? { address: `${host}:${port}`, host, port, self, ...found } : null;
}

/**
 * What a server that is no Kotomimi is, where it can be told: a LocalAI
 * answers `GET /version` with its version, which no other server of this
 * wire does. Blank for anything else.
 */
async function productOf({ host, port }, timeoutMs = PROBE_TIMEOUT_MS) {
  const answer = await get(host, port, '/version', timeoutMs);
  if (!answer || answer.status !== 200) return '';
  try {
    return typeof JSON.parse(answer.body)?.version === 'string' ? 'LocalAI' : '';
  } catch {
    return '';
  }
}

/** A computer's name for an address, where the network knows one: asked briefly, and never waited for long. */
function nameOf(host, reverse = dns.promises.reverse, waitMs = 400) {
  return Promise.race([
    reverse(host).then((names) => String(names?.[0] ?? '').replace(/\.(local|lan|home|localdomain)\.?$/i, ''), () => ''),
    new Promise((resolve) => setTimeout(() => resolve(''), waitMs)),
  ]);
}

/** What of everything that answered is listed. */
function shown(found) {
  // A Kotomimi that shares its computer's model server speaks for it: that computer is listed once, by its Kotomimi.
  const spokenFor = new Set(found.filter((s) => s.kind === 'kotomimi' && s.includes && !s.self).map((s) => s.host));
  // A Kotomimi on this very computer — a second copy of the app — is no other device: "this computer" is the choice for it.
  return found.filter((s) => !(s.self && s.kind === 'kotomimi') && !(s.kind === 'server' && spokenFor.has(s.host)));
}

/**
 * Everything found, Kotomimis first, then by address. `ownPorts` are the
 * ports this app listens on now: it is not shown itself.
 */
async function discoverServers({ interfaces, ports, ownPorts = [], timeoutMs = PROBE_TIMEOUT_MS, concurrency = CONCURRENCY, reverse } = {}) {
  const queue = targets(interfaces, { ports, ownPorts });
  const found = [];
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const answer = await probe(next, timeoutMs);
      if (answer) found.push(answer);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  const others = shown(found);
  await Promise.all(others.map(async (s) => {
    // A server that did not name itself: the network may know its computer's name, and the server what it is.
    const [name, product] = await Promise.all([
      s.name || s.self ? s.name : nameOf(s.host, reverse),
      s.kind === 'server' ? productOf(s, timeoutMs) : '',
    ]);
    s.name = name;
    s.product = product;
  }));
  const order = (s) => `${s.kind === 'kotomimi' ? 0 : 1}${s.self ? 0 : 1}${toNumber(s.host).toString().padStart(10, '0')}${String(s.port).padStart(5, '0')}`;
  return others.sort((a, b) => order(a).localeCompare(order(b))).map(({ address, kind, name, product, models, needsKey, self }) => ({ address, kind, name, product, models, needsKey, self }));
}

module.exports = { discoverServers, targets, neighbours, readAnswer, probe, productOf, nameOf, shown, KOTOMIMI_PORT, SERVER_PORT, NAME_HEADER, INCLUDES_HEADER };
