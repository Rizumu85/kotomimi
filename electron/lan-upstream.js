// Fork: a model server on this same computer (a LocalAI), shared through the
// app's own door.
//
// A computer that shares its models may hold two kinds: the ones the app
// downloaded, which the page runs, and the ones of a LocalAI installed here
// (`local-server.js`). To another device they are one computer, and should be
// one address, one access key and one switch. So the door (`lan-server.js`)
// asks this module about every request, and what is LocalAI's is passed on to
// it over the loopback:
//
//   - its recognizers and text models join the model lists the page answers;
//   - a chat request for one of its text models goes to it as it came;
//   - a Realtime socket whose session asks for one of its recognizers is
//     joined to a session of its own.
//
// Which model runs is the asking device's choice, made per stage in its own
// settings: a LocalAI loads a model when a request names it, and nothing is
// loaded for being listed. A recognizer is not named in a LocalAI's session
// but in its pipeline, so the one asked for is written there first
// (`setPipeline`), and the one it replaces is let go from memory.
//
// A device that leaves the choice to this computer gets the LocalAI's own
// pipeline, as it is set here — its owner installed it to be used — and the
// app's own models only when no LocalAI answers.
//
// No Electron import, and everything it touches is handed in, so its tests
// run with no LocalAI.
const http = require('http');
const { WebSocket } = require('ws');

/** What the LocalAI serves is asked again after this long: a model installed since joins the lists. */
const CACHE_MS = 5000;
/** What a socket may hold waiting for the LocalAI to announce its session: a few seconds of a device's audio, no more, so a LocalAI slow to load (or one that never answers) cannot grow this process without bound. */
const MAX_QUEUED_BYTES = 8 * 1024 * 1024;
/** The name the app's own pipeline answers to (`src/lib/lan/protocol.ts`): what a device asks when it leaves the model to this computer. */
const OWN_PIPELINE = 'kotomimi';
const NONE = { pipelines: [], recognizers: [], translators: [] };

/** A session's settings without the recognizer's name: a LocalAI's session takes none, its pipeline names it. */
function withoutRecognizer(update) {
  const copy = JSON.parse(JSON.stringify(update ?? {}));
  const transcription = copy?.session?.audio?.input?.transcription;
  if (transcription && typeof transcription === 'object') delete transcription.model;
  return copy;
}

/** A chat request as a LocalAI takes it: its own model's name, and none of the fields only a Kotomimi reads. */
function chatBody(body, model) {
  const { source_language: _source, target_language: _target, ...rest } = body ?? {};
  return { ...rest, model };
}

const wireError = (code, message) => ({ type: 'error', error: { type: 'server_error', code, message } });

/**
 * The LocalAI of this computer, as the door asks it.
 *   port                      where it listens, on the loopback
 *   pipelines()               `local-server.js`'s: its pipelines, recognizers and text models; empty while it is down
 *   setPipeline(name, change) `local-server.js`'s
 */
function createUpstream({ port, pipelines, setPipeline, now = Date.now, connect = (url) => new WebSocket(url), request = http.request }) {
  let cached = null;
  async function info(fresh = false) {
    if (!fresh && cached && now() - cached.at < CACHE_MS) return cached.value;
    let value = NONE;
    try {
      const found = await pipelines();
      if (found && Array.isArray(found.pipelines)) value = { pipelines: found.pipelines, recognizers: found.recognizers ?? [], translators: found.translators ?? [] };
    } catch {
      value = NONE;
    }
    cached = { at: now(), value };
    return value;
  }
  /** The pipeline a session is opened on: the one named as OpenAI names its own, else the first. */
  const pipelineOf = (found) => found.pipelines.find((p) => /^gpt-realtime/i.test(p.name)) ?? found.pipelines[0] ?? null;
  /** The name leaves the choice to this computer: the app's pipeline, one of the LocalAI's, or none at all. */
  const leftToUs = (found, wanted) => wanted === '' || wanted === OWN_PIPELINE || found.pipelines.some((p) => p.name === wanted);

  /** What joins the model lists: each recognizer and text model, with what it is for. */
  async function models() {
    const found = await info();
    const seen = new Set();
    const out = [];
    for (const [ids, capability] of [[found.recognizers, 'transcript'], [found.translators, 'chat']]) {
      for (const id of ids) {
        if (typeof id !== 'string' || !id || seen.has(id)) continue;
        seen.add(id);
        out.push({ id, capabilities: [capability] });
      }
    }
    return out;
  }

  /** The text model a chat request is passed on to, or null when the request is the page's. */
  async function chatModel(wanted) {
    const found = await info();
    const name = typeof wanted === 'string' ? wanted : '';
    if (found.translators.includes(name)) return name;
    if (!leftToUs(found, name)) return null;
    return pipelineOf(found)?.llm || null;
  }

  /** The pipeline a socket is joined to and the recognizer to name in it, or null when the socket is the page's. */
  async function recognizer(wanted) {
    const found = await info();
    const name = typeof wanted === 'string' ? wanted : '';
    const pipeline = pipelineOf(found);
    if (!pipeline) return null;
    if (found.recognizers.includes(name)) return { pipeline: pipeline.name, transcription: name };
    if (!leftToUs(found, name) || !pipeline.transcription) return null;
    return { pipeline: pipeline.name, transcription: '' };
  }

  /** One pipeline change at a time: the two legs of a run ask for the same recognizer at once. */
  let chain = Promise.resolve();
  function prepare(route) {
    const next = chain.then(async () => {
      if (!route.transcription) return;
      const found = await info(true);
      if (found.pipelines.find((p) => p.name === route.pipeline)?.transcription === route.transcription) return;
      const answer = await setPipeline(route.pipeline, { transcription: route.transcription });
      cached = null;
      if (!answer?.ok) throw new Error(answer?.error || 'The model could not be chosen.');
    });
    chain = next.catch(() => {});
    return next;
  }

  /**
   * Joins a device's socket to a session of the LocalAI's. `update` is the
   * device's first `session.update`, which said what it wants; `send` and
   * `close` reach the device. Answers what the door then hands every later
   * message to, and closes when the device goes.
   */
  function bridge(route, { update, send, close }) {
    let ws = null;
    let ready = false;
    let ended = false;
    const queue = [];
    let queuedBytes = 0;
    const fail = (message) => {
      if (ended) return;
      ended = true;
      send(JSON.stringify(wireError('upstream_failed', message)));
      close(1011, message);
    };
    prepare(route).then(() => {
      if (ended) return;
      ws = connect(`ws://127.0.0.1:${port}/v1/realtime?model=${encodeURIComponent(route.pipeline)}`);
      ws.on('message', (data, isBinary) => {
        if (ended || isBinary) return;
        const text = data.toString('utf8');
        if (!ready) {
          // Its own announcement: the device was already told a session began, by the door's first answer.
          let type = '';
          try {
            type = JSON.parse(text)?.type ?? '';
          } catch {
            type = '';
          }
          if (type !== 'session.created') return;
          ready = true;
          ws.send(JSON.stringify(withoutRecognizer(update)));
          for (const held of queue.splice(0)) ws.send(held);
          queuedBytes = 0;
          return;
        }
        send(text);
      });
      ws.on('close', () => {
        if (ended) return;
        ended = true;
        close(1011, 'The model server closed the session.');
      });
      ws.on('error', (error) => fail(`The model server could not be reached: ${error?.message ?? error}`));
    }, (error) => fail(error?.message ?? String(error)));
    return {
      send(text) {
        if (ended) return;
        if (ready) { ws.send(text); return; }
        // Held until the session is up; the oldest let go once there is more than a few seconds of it, so a slow or silent LocalAI cannot grow this process without bound.
        queue.push(text);
        queuedBytes += Buffer.byteLength(text);
        while (queuedBytes > MAX_QUEUED_BYTES && queue.length > 1) queuedBytes -= Buffer.byteLength(queue.shift());
      },
      close() {
        ended = true;
        try {
          ws?.close();
        } catch {
          // Already gone.
        }
      },
    };
  }

  /** Passes a chat request on, and its answer back as it comes — a stream as a stream. */
  function complete(body, model, response, headers = {}) {
    const text = JSON.stringify(chatBody(body, model));
    const refuse = (status, message) => {
      if (response.headersSent) {
        response.end();
        return;
      }
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
      response.end(JSON.stringify({ error: { message, type: 'server_error', code: 'upstream_failed' } }));
    };
    const passed = request({ host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', agent: false, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) } }, (answer) => {
      response.writeHead(answer.statusCode ?? 502, { 'Content-Type': answer.headers['content-type'] ?? 'application/json', ...headers });
      answer.pipe(response);
      answer.on('error', () => response.end());
    });
    passed.on('error', (error) => refuse(502, `The model server could not be reached: ${error?.message ?? error}`));
    // The device went away: the model server need not finish for no one.
    response.on('close', () => { if (!response.writableEnded) passed.destroy(); });
    passed.end(text);
  }

  return { models, chatModel, recognizer, bridge, complete };
}

module.exports = { createUpstream, withoutRecognizer, chatBody };
