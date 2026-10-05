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
// The pipeline is one for the whole LocalAI, and a session takes its
// recognizer from it when the session is configured. So setting a session up
// — the pipeline changed, LocalAI's session opened and confirmed — is one
// turn: a session that names another recognizer waits until it is over, and
// cannot change the pipeline under a session not yet confirmed. Sessions that
// name the same recognizer share a turn (a run's two legs); one that leaves
// the choice to this computer takes none.
//
// No Electron import, and everything it touches is handed in, so its tests
// run with no LocalAI.
const http = require('http');
const { WebSocket } = require('ws');

/** What the LocalAI serves is asked again after this long: a model installed since joins the lists. */
const CACHE_MS = 5000;
/** A session LocalAI never confirms holds the turn this long, and no longer: it does not keep every other device waiting. */
const CONFIGURE_TIMEOUT_MS = 30_000;
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

/** A frame's type, or '' for what is not JSON. */
function typeOf(text) {
  try {
    return JSON.parse(text)?.type ?? '';
  } catch {
    return '';
  }
}

/** A close code one side may send on to the other: not 1005 or 1006, which only say no code came or the connection dropped. */
const sendable = (code) => (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) || (code >= 3000 && code <= 4999);

/**
 * The LocalAI of this computer, as the door asks it.
 *   port                      where it listens, on the loopback
 *   pipelines()               `local-server.js`'s: its pipelines, recognizers and text models; empty while it is down
 *   setPipeline(name, change) `local-server.js`'s
 *   configureTimeoutMs        how long a session LocalAI does not confirm holds its turn
 *   ownFirst(ask)             whether a request that names no model is the app's own to answer though this LocalAI
 *                             could: the app has a native engine's model for it (`native-engine.js`,
 *                             `apple-speech.js`), and those are the ones measured best. `ask` is
 *                             `{ kind: 'asr', language }` or `{ kind: 'translate', source, target }`.
 */
function createUpstream({ port, pipelines, setPipeline, ownFirst = async () => false, now = Date.now, connect = (url) => new WebSocket(url), request = http.request, configureTimeoutMs = CONFIGURE_TIMEOUT_MS }) {
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
  async function chatModel(wanted, body) {
    const found = await info();
    const name = typeof wanted === 'string' ? wanted : '';
    if (found.translators.includes(name)) return name;
    if (!leftToUs(found, name)) return null;
    if (await ownFirst({ kind: 'translate', source: body?.source_language, target: body?.target_language }).catch(() => false)) return null;
    return pipelineOf(found)?.llm || null;
  }

  /** The pipeline a socket is joined to and the recognizer to name in it, or null when the socket is the page's. */
  async function recognizer(wanted, language) {
    const found = await info();
    const name = typeof wanted === 'string' ? wanted : '';
    const pipeline = pipelineOf(found);
    if (!pipeline) return null;
    if (found.recognizers.includes(name)) return { pipeline: pipeline.name, transcription: name };
    if (!leftToUs(found, name) || !pipeline.transcription) return null;
    if (await ownFirst({ kind: 'asr', language }).catch(() => false)) return null;
    return { pipeline: pipeline.name, transcription: '' };
  }

  /** The turn: the recognizer the sessions being set up named, how many there are, and who waits for another. */
  let turn = { recognizer: '', holders: 0 };
  const waiting = [];
  /** Resolves when a session that names `recognizer` may be set up, with what ends its part of the turn (once). */
  function takeTurn(recognizer) {
    if (!recognizer) return Promise.resolve(() => {});
    return new Promise((resolve) => {
      const start = () => {
        turn = { recognizer, holders: turn.holders + 1 };
        let holding = true;
        resolve(() => {
          if (!holding) return;
          holding = false;
          turn.holders -= 1;
          if (turn.holders > 0) return;
          // The next to wait goes, and with it everyone waiting for the same recognizer.
          const next = waiting.shift();
          if (!next) return;
          const together = [next, ...waiting.filter((w) => w.recognizer === next.recognizer)];
          for (const w of together.slice(1)) waiting.splice(waiting.indexOf(w), 1);
          for (const w of together) w.start();
        });
      };
      if (turn.holders === 0 || (turn.recognizer === recognizer && waiting.length === 0)) start();
      else waiting.push({ recognizer, start });
    });
  }

  /** The recognizers the open sessions were set up on, with how many sessions each: none of them is unloaded by a change of the pipeline. */
  const using = new Map();

  /**
   * One pipeline change at a time: the two legs of a run ask for the same
   * recognizer at once. Answers the recognizer the session will run on — the
   * one it named, or the pipeline's own when it named none.
   */
  let chain = Promise.resolve();
  function prepare(route) {
    const next = chain.then(async () => {
      const found = await info(Boolean(route.transcription));
      const current = found.pipelines.find((p) => p.name === route.pipeline)?.transcription ?? '';
      if (!route.transcription || current === route.transcription) return route.transcription || current;
      const answer = await setPipeline(route.pipeline, { transcription: route.transcription }, { keep: [...using.keys()] });
      cached = null;
      if (!answer?.ok) throw new Error(answer?.error || 'The model could not be chosen.');
      return route.transcription;
    });
    chain = next.catch(() => {});
    return next;
  }

  /**
   * Joins a device's socket to a session of the LocalAI's. `update` is the
   * device's first `session.update`, which said what it wants; `send` and
   * `close` reach the device. Answers what the door then hands every later
   * message to, and closes when the device goes. A close carries its code
   * and reason across, either way, when it had one to carry.
   */
  function bridge(route, { update, send, close }) {
    let ws = null;
    let ready = false;
    let configured = false;
    let ended = false;
    const queue = [];
    let leaveTurn = () => {};
    let limit = null;
    /** The recognizer this session runs on, counted among those in use until it ends. */
    let held = '';
    const hold = (recognizer) => {
      if (!recognizer || ended) return;
      held = recognizer;
      using.set(held, (using.get(held) ?? 0) + 1);
    };
    const release = () => {
      if (!held) return;
      const left = (using.get(held) ?? 1) - 1;
      if (left > 0) using.set(held, left);
      else using.delete(held);
      held = '';
    };
    /** The session is set up — confirmed, refused, or over: the pipeline may change from here on. */
    const settled = () => {
      configured = true;
      clearTimeout(limit);
      leaveTurn();
    };
    /** The session ends without the device asking: it is told why, then closed — with the model server's own code, when there was one. */
    const fail = (message, code = 1011, reason = message) => {
      if (ended) return;
      ended = true;
      settled();
      release();
      send(JSON.stringify(wireError('upstream_failed', message)));
      close(code, reason);
    };
    takeTurn(route.transcription).then((leave) => {
      leaveTurn = leave;
      if (ended) return settled();
      limit = setTimeout(settled, configureTimeoutMs);
      limit.unref?.();
      return prepare(route).then((recognizer) => {
        if (ended) return;
        hold(recognizer);
        ws = connect(`ws://127.0.0.1:${port}/v1/realtime?model=${encodeURIComponent(route.pipeline)}`);
        ws.on('message', (data, isBinary) => {
          if (ended || isBinary) return;
          const text = data.toString('utf8');
          if (!ready) {
            // Its own announcement: the device was already told a session began, by the door's first answer.
            if (typeOf(text) !== 'session.created') return;
            ready = true;
            ws.send(JSON.stringify(withoutRecognizer(update)));
            for (const held of queue.splice(0)) ws.send(held);
            return;
          }
          // Its answer to the session's settings, either way, ends the turn.
          if (!configured && ['session.updated', 'error'].includes(typeOf(text))) settled();
          send(text);
        });
        ws.on('close', (code, reason) => {
          const said = String(reason ?? '');
          const message = said ? `The model server closed the session: ${said}` : 'The model server closed the session.';
          if (sendable(code)) fail(message, code, said);
          else fail(message);
        });
        ws.on('error', (error) => fail(`The model server could not be reached: ${error?.message ?? error}`));
      }, (error) => fail(error?.message ?? String(error)));
    });
    return {
      send(text) {
        if (ended) return;
        if (ready) ws.send(text);
        else queue.push(text);
      },
      close(code, reason) {
        ended = true;
        settled();
        release();
        try {
          if (sendable(code)) ws?.close(code, String(reason ?? ''));
          else ws?.close();
        } catch {
          // Already gone.
        }
      },
    };
  }

  /**
   * Passes a chat request on, and its answer back as it comes — a stream as a
   * stream, and one cut off as cut off: a client reads a stream to its end, and
   * an end written for it would pass half an answer off as the whole.
   */
  function complete(body, model, response, headers = {}) {
    const text = JSON.stringify(chatBody(body, model));
    const refuse = (status, message) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
      response.end(JSON.stringify({ error: { message, type: 'server_error', code: 'upstream_failed' } }));
    };
    const passed = request({ host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', agent: false, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) } }, (answer) => {
      response.writeHead(answer.statusCode ?? 502, { 'Content-Type': answer.headers['content-type'] ?? 'application/json', ...headers });
      answer.pipe(response);
      answer.on('error', () => response.destroy());
    });
    passed.on('error', (error) => refuse(502, `The model server could not be reached: ${error?.message ?? error}`));
    // The device went away: the model server need not finish for no one.
    response.on('close', () => { if (!response.writableEnded) passed.destroy(); });
    passed.end(text);
  }

  return { models, chatModel, recognizer, bridge, complete };
}

module.exports = { createUpstream, withoutRecognizer, chatBody };
