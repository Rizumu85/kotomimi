// Fork: several native recognizers as one.
//
// A Mac has two: the system's own speech recognition (apple-speech.js), for
// the languages the system offers, and the runtime the app downloads
// (native-engine.js), for a model that hears the others. Each answers the
// same questions about its own models; this joins them, so that the page asks
// one engine and never has to know there are two.
//
// What is joined:
//  - the models: every engine's, each asked of its own engine;
//  - the state of the runtime: folded into each model's own state — a model
//    whose runtime is not there yet is not downloaded, whatever of it is on
//    disk — so that the whole is "ready" wherever any engine can run;
//  - the run: the one started last, which is the one the page waits for. An
//    engine started earlier stays up — a device this computer shares with
//    may still be listening through it — and is stopped once it has had no
//    recognition open for a while, or when everything is stopped;
//  - the recognitions: opened on the engine of the model they name, under
//    ids of their own.
//
// No Electron import, and the engines are handed in, so its tests need none
// of them.

/** An engine that is not the one started last is stopped after this long with no recognition open. */
const IDLE_MS = 10 * 60_000;

const STOPPED = { state: 'stopped', model: null, port: 0, tail: '' };
const isUp = (run) => run?.state === 'starting' || run?.state === 'warming' || run?.state === 'ready';

/**
 * `makers`: one function for each engine, given the two callbacks an engine
 * tells its changes and its recognitions' events through, returning the
 * engine. The first is asked first, and its models are listed first.
 */
function joinEngines(makers, deps = {}) {
  const { onChange = () => {}, onStream = () => {}, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout, idleMs = IDLE_MS } = deps;
  /** Each engine's state as it last said it; null until it has. */
  const last = makers.map(() => null);
  /** The engine started last; null while none is. */
  let active = null;
  /** Recognitions: this module's id → the engine and its own id; and back, for each engine. */
  const streams = new Map();
  const outerOf = makers.map(() => new Map());
  let nextStream = 1;
  /** When each engine last had a recognition open, and the timer that looks at it. */
  const usedAt = makers.map(() => 0);
  let idleTimer = null;

  const engines = makers.map((make, at) => make({
    onChange: (status) => { last[at] = status; tell(); },
    onStream: (event) => {
      const id = outerOf[at].get(event?.id);
      if (id === undefined) return;
      if (event.type !== 'delta' && event.type !== 'partial') forget(id);
      onStream({ ...event, id });
    },
  }));

  function forget(id) {
    const stream = streams.get(id);
    if (!stream) return;
    streams.delete(id);
    outerOf[stream.at].delete(stream.inner);
    usedAt[stream.at] = now();
    watchIdle();
  }

  const openOn = (at) => [...streams.values()].some((stream) => stream.at === at);

  /** A model as the whole shows it: its own state, unless its runtime is not there to run it. */
  const modelOf = (status, model) => {
    if (status.engine === 'ready') return model;
    if (status.engine === 'downloading') return model.state === 'absent' || model.state === 'failed' ? { ...model, state: 'downloading' } : model;
    return model.state === 'downloaded' ? { ...model, state: 'absent' } : model;
  };

  function merge() {
    const known = last.map((status) => status ?? { supported: false, engine: 'unsupported', engineBytes: 0, models: {}, run: STOPPED });
    const supported = known.some((status) => status.supported);
    const models = {};
    for (const status of known) {
      if (!status.supported) continue;
      for (const [id, model] of Object.entries(status.models)) models[id] ??= modelOf(status, model);
    }
    const run = active !== null && known[active].run.state !== 'stopped' ? known[active].run : known.map((status) => status.run).find((one) => one.state !== 'stopped') ?? STOPPED;
    return { supported, engine: supported ? 'ready' : 'unsupported', engineBytes: 0, models, run: { ...run } };
  }

  const tell = () => { if (last.every(Boolean)) onChange(merge()); };

  async function status() {
    await Promise.all(engines.map(async (engine, at) => { last[at] = await engine.status(); }));
    return merge();
  }

  /** The engine a model is of: the first that lists it. */
  async function ownerOf(id) {
    if (!last.every(Boolean)) await status();
    const at = last.findIndex((one) => one.supported && Object.prototype.hasOwnProperty.call(one.models, id));
    return at >= 0 ? at : null;
  }

  /** Asks a model's own engine, and answers with the whole. */
  const ask = (what) => async (id) => {
    const at = await ownerOf(id);
    if (at !== null) last[at] = await engines[at][what](id);
    return merge();
  };

  async function start(id) {
    const at = await ownerOf(id);
    if (at === null) return merge();
    active = at;
    last[at] = await engines[at].start(id);
    watchIdle();
    return merge();
  }

  async function stop() {
    active = null;
    if (idleTimer) clearTimer(idleTimer);
    idleTimer = null;
    for (const id of [...streams.keys()]) forget(id);
    await Promise.all(engines.map(async (engine, at) => { last[at] = await engine.stop(); }));
    return merge();
  }

  /** Engines left up by an earlier start are let go once nobody has listened through them for a while. */
  function watchIdle() {
    if (idleTimer) return;
    const waiting = last.some((status, at) => at !== active && isUp(status?.run));
    if (!waiting) return;
    idleTimer = setTimer(() => {
      idleTimer = null;
      last.forEach((status, at) => {
        if (at === active || !isUp(status?.run) || openOn(at) || now() - usedAt[at] < idleMs) return;
        // Stopped as far as this module goes, from now: it is not waited for again.
        last[at] = { ...status, run: { ...STOPPED } };
        void Promise.resolve(engines[at].stop()).then((after) => { last[at] = after; tell(); });
      });
      watchIdle();
    }, idleMs);
    idleTimer?.unref?.();
  }

  /** A recognition, on the engine of the model it names — or, naming none, on the one started last. */
  function openStream({ language, sampleRate, model } = {}) {
    const named = typeof model === 'string' && model ? last.findIndex((one) => one?.supported && Object.prototype.hasOwnProperty.call(one.models, model)) : -1;
    const at = named >= 0 ? named : active;
    if (at === null || at < 0) return null;
    const inner = engines[at].openStream({ language, sampleRate, model });
    if (inner === null || inner === undefined) return null;
    const id = nextStream++;
    streams.set(id, { at, inner });
    outerOf[at].set(inner, id);
    usedAt[at] = now();
    return id;
  }
  const to = (id, what, ...args) => {
    const stream = streams.get(id);
    return stream ? engines[stream.at][what](stream.inner, ...args) : false;
  };
  const writeStream = (id, pcm) => to(id, 'writeStream', pcm);
  const endStream = (id) => to(id, 'endStream');
  function abortStream(id) {
    const done = to(id, 'abortStream');
    forget(id);
    return done;
  }

  return { status, download: ask('download'), cancel: ask('cancel'), remove: ask('remove'), start, stop, openStream, writeStream, endStream, abortStream };
}

module.exports = { joinEngines, IDLE_MS };
