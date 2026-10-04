// Fork: a LocalAI installed on this computer, run by the app.
//
// Some models are not the app's to run — Apple's speech recognition, the MLX
// models, GGUF translation models — and a LocalAI on the same computer runs
// them. It used to need a helper of its own to keep it up. The app does that
// now: it finds the installation, starts it, says whether it is up and what
// it serves, and stops it when the app quits. Installing models stays
// LocalAI's own business (its web page); to the rest of the app, and to any
// other device, it is the same server it always was (`FORK.md`).
//
// A LocalAI's Realtime pipeline strings a recognizer and a text model
// together, and a session on it runs whichever the pipeline names. Which
// those are is read here, and changed, through LocalAI's own API
// (`/api/models/config-json/<name>`) — what its web page does, and what a
// helper app's menu used to. The models are whatever this LocalAI lists:
// nothing here knows one by name.
//
// A model nobody has asked for in a while is let go from memory (LocalAI's own
// idle watchdog, switched on when the app starts it): a computer that lends
// its models to other devices loads what they choose, and should not keep
// every model it was ever asked for.
//
// What it will not do: touch a LocalAI something else started. One that
// already answers on the port is reported as running, and left alone.
//
// No Electron import, and everything it touches is handed in, so its tests
// run with no LocalAI and no process.
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn: nodeSpawn, execFile } = require('child_process');

const DEFAULT_ADDRESS = '0.0.0.0:8080';
/** A LocalAI that loads its backends takes a while to answer: this long is waited for it. */
const READY_TIMEOUT_MS = 120_000;
const READY_POLL_MS = 500;
/** After it is asked to stop: this long, then it is killed. */
const STOP_TIMEOUT_MS = 8_000;
/** A model no request has named for this long is unloaded; the next request that names it loads it again. */
const IDLE_TIMEOUT = '10m';
/** Lines of its output kept, for the settings to show when it would not start. */
const TAIL_LINES = 30;

/** Where a LocalAI is looked for: its own launcher's place, then Homebrew's. */
function candidates(home, platform) {
  const exe = platform === 'win32' ? 'local-ai.exe' : 'local-ai';
  return [
    path.join(home, '.localai', 'bin', exe),
    ...(platform === 'win32' ? [] : ['/opt/homebrew/bin/local-ai', '/usr/local/bin/local-ai']),
  ];
}

/** The port of a listen address (`0.0.0.0:8080`, `:8080`), or 8080 for what is none. */
function portOf(address) {
  const port = Number(String(address ?? '').split(':').pop());
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 8080;
}

/**
 * The command line LocalAI is started with: its folders under `base`, where
 * they exist, and the address. A flag is given only when this LocalAI's own
 * help names it — the flags have changed between versions, and an unknown
 * one stops it from starting at all.
 */
function buildArgs({ base, address, help, exists }) {
  const knows = (flag) => help.includes(flag);
  const dir = (flag, name) => (knows(flag) && exists(path.join(base, name)) ? [flag, path.join(base, name)] : []);
  return [
    'run',
    ...dir('--models-path', 'models'),
    ...dir('--backends-path', 'backends'),
    ...(knows('--address') ? ['--address', address] : []),
    // A LocalAI on the local network with no key of its own: newer versions refuse the bind unless told it is meant.
    ...(knows('--allow-insecure-public-bind') && !/^(127\.|localhost)/.test(address) ? ['--allow-insecure-public-bind'] : []),
    // Models left idle are unloaded: without this LocalAI keeps each one in memory until it stops.
    ...(knows('--enable-watchdog-idle') && knows('--watchdog-idle-timeout') ? ['--enable-watchdog-idle', `--watchdog-idle-timeout=${IDLE_TIMEOUT}`] : []),
    ...dir('--data-path', 'data'),
    ...dir('--localai-config-dir', 'configuration'),
    ...dir('--generated-content-path', 'generated'),
    ...dir('--upload-path', 'uploads'),
  ];
}

/** What it runs with: the launcher's own variables, a PATH an app started from the Finder lacks, and Metal on Apple silicon. */
function buildEnv({ env, launcherEnv, platform, arch, base, exists }) {
  const extra = platform === 'win32' ? [] : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const have = String(env.PATH ?? '').split(path.delimiter).filter(Boolean);
  return {
    ...env,
    ...launcherEnv,
    PATH: [...have, ...extra.filter((p) => !have.includes(p))].join(path.delimiter),
    ...(platform === 'darwin' && arch === 'arm64' ? { LOCALAI_FORCE_META_BACKEND_CAPABILITY: 'metal' } : {}),
    ...(exists(path.join(base, 'docker-config')) ? { DOCKER_CONFIG: path.join(base, 'docker-config') } : {}),
  };
}

/** One GET of this computer. Resolves with the status and the body, or null. */
function localGet(port, pathname, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      request.destroy();
      resolve(value);
    };
    const request = http.get({ host: '127.0.0.1', port, path: pathname, agent: false }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => { if (chunks.length < 512) chunks.push(chunk); });
      response.on('end', () => finish({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', () => finish(null));
    });
    const timer = setTimeout(() => finish(null), timeoutMs);
    request.on('error', () => finish(null));
  });
}

/** One request of this computer with a JSON body. Resolves with the status and the body, or null. */
function localSend(port, method, pathname, body, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      request.destroy();
      resolve(value);
    };
    const text = JSON.stringify(body ?? {});
    const request = http.request({ host: '127.0.0.1', port, path: pathname, method, agent: false, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => { if (chunks.length < 512) chunks.push(chunk); });
      response.on('end', () => finish({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', () => finish(null));
    });
    const timer = setTimeout(() => finish(null), timeoutMs);
    request.on('error', () => finish(null));
    request.end(text);
  });
}

const helpOf = (bin, cwd) => new Promise((resolve) => {
  execFile(bin, ['run', '--help'], { cwd, timeout: 8000, windowsHide: true }, (error, stdout, stderr) => resolve(`${stdout ?? ''}${stderr ?? ''}`));
});

/**
 * The LocalAI of this computer.
 *   status()   what is known now
 *   refresh()  asks again whether it is up, and what it serves
 *   start()    starts it, and resolves once it answers — or with why it did not
 *   stop()     stops the one this app started
 * The status: `{ installed, state, port, models, tail }`, the state one of
 * `absent` (none installed), `stopped`, `starting`, `running` (this app's),
 * `external` (up, started by something else), `failed` (see `tail`).
 */
function createLocalServer(deps = {}) {
  const {
    home = os.homedir(),
    platform = process.platform,
    arch = process.arch,
    env = process.env,
    exists = fs.existsSync,
    readFile = (file) => fs.readFileSync(file, 'utf8'),
    spawn = nodeSpawn,
    get = localGet,
    send = localSend,
    help = helpOf,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log = null,
    onChange = () => {},
    readyTimeoutMs = READY_TIMEOUT_MS,
    /** In place of the launcher's own: for trying it beside one that is already up. */
    address: wanted = null,
  } = deps;

  const base = path.join(home, '.localai');
  const bin = candidates(home, platform).find((file) => exists(file)) ?? null;
  let launcher = {};
  try {
    launcher = JSON.parse(readFile(path.join(base, 'launcher.json'))) ?? {};
  } catch {
    launcher = {};
  }
  const address = wanted ?? (typeof launcher.address === 'string' && launcher.address.trim() ? launcher.address.trim() : DEFAULT_ADDRESS);
  const port = portOf(address);

  let child = null;
  let tail = [];
  let current = { installed: Boolean(bin), state: bin ? 'stopped' : 'absent', port, models: [], tail: '' };
  const set = (patch) => {
    current = { ...current, ...patch };
    onChange(current);
    return current;
  };

  const up = async () => (await get(port, '/readyz'))?.status === 200;
  const models = async () => {
    const answer = await get(port, '/v1/models', 4000);
    try {
      const list = JSON.parse(answer?.body ?? '');
      return Array.isArray(list?.data) ? list.data.map((m) => m?.id).filter((id) => typeof id === 'string').slice(0, 200) : [];
    } catch {
      return [];
    }
  };
  const note = (chunk) => {
    const text = String(chunk);
    log?.(text);
    tail = [...tail, ...text.split(/\r?\n/).filter((line) => line.trim())].slice(-TAIL_LINES);
  };

  async function refresh() {
    if (current.state === 'starting') return current;
    if (await up()) return set({ state: child ? 'running' : 'external', models: await models(), tail: '' });
    // Its process still lives but does not answer: it is not done starting, or it hangs. Either way it is this app's to stop.
    if (child) return current;
    return set({ state: !bin ? 'absent' : current.state === 'failed' ? 'failed' : 'stopped', models: [] });
  }

  async function start() {
    if (!bin || current.state === 'starting' || child) return current;
    if (await up()) return set({ state: 'external', models: await models(), tail: '' });
    tail = [];
    set({ state: 'starting', models: [], tail: '' });
    const cwd = exists(base) ? base : home;
    const args = buildArgs({ base, address, help: await help(bin, cwd), exists });
    const launcherEnv = launcher.environment_vars && typeof launcher.environment_vars === 'object' ? launcher.environment_vars : {};
    let mine;
    try {
      mine = spawn(bin, args, { cwd, env: buildEnv({ env, launcherEnv, platform, arch, base, exists }), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      return set({ state: 'failed', tail: String(error?.message ?? error) });
    }
    child = mine;
    let exited = false;
    const ended = (code) => {
      if (exited) return;
      exited = true;
      if (child !== mine) return;
      child = null;
      // It went away by itself — while starting, or later: either way it is no longer up.
      if (current.state === 'starting' || current.state === 'running') set({ state: code === 0 ? 'stopped' : 'failed', models: [], tail: tail.join('\n') });
    };
    mine.stdout?.on('data', note);
    mine.stderr?.on('data', note);
    // A process that could not be started says so here, and on its pipes: unheard, either would bring the app down.
    mine.stdout?.on('error', () => {});
    mine.stderr?.on('error', () => {});
    mine.on('error', (error) => { note(error.message); ended(1); });
    mine.on('exit', ended);
    const deadline = Date.now() + readyTimeoutMs;
    while (!exited && child === mine && Date.now() < deadline) {
      if (await up()) return set({ state: 'running', models: await models(), tail: '' });
      await sleep(READY_POLL_MS);
    }
    if (child !== mine) return current;
    if (!exited) {
      mine.kill();
      child = null;
      return set({ state: 'failed', models: [], tail: [...tail, 'LocalAI did not answer in time.'].join('\n') });
    }
    return current;
  }

  async function stop() {
    const mine = child;
    if (!mine) return current;
    child = null;
    const gone = new Promise((resolve) => mine.once('exit', resolve));
    mine.kill('SIGTERM');
    const timer = setTimeout(() => mine.kill('SIGKILL'), STOP_TIMEOUT_MS);
    await gone;
    clearTimeout(timer);
    return set({ state: 'stopped', models: [], tail: '' });
  }

  const json = (answer) => {
    try {
      return answer && answer.status === 200 ? JSON.parse(answer.body) : null;
    } catch {
      return null;
    }
  };
  const configPath = (name) => `/api/models/config-json/${encodeURIComponent(name)}`;

  /**
   * The pipelines this LocalAI lists — the models with no capability of their
   * own — each with the recognizer and the text model it names, and the
   * models either could be: `{ pipelines: [{ name, transcription, llm }],
   * recognizers, translators }`. Empty while it is not up.
   */
  async function pipelines() {
    const none = { pipelines: [], recognizers: [], translators: [] };
    const [list, kinds] = await Promise.all([get(port, '/v1/models', 4000), get(port, '/v1/models/capabilities', 4000)]);
    const ids = (json(list)?.data ?? []).map((m) => m?.id).filter((id) => typeof id === 'string');
    const caps = json(kinds)?.data;
    // No capability list (an older LocalAI): nothing says which model is a pipeline, and nothing is offered.
    if (!Array.isArray(caps)) return none;
    const of = new Map(caps.filter((m) => typeof m?.id === 'string').map((m) => [m.id, Array.isArray(m.capabilities) ? m.capabilities : []]));
    const has = (id, ...wanted) => wanted.some((c) => (of.get(id) ?? []).includes(c));
    const out = { pipelines: [], recognizers: ids.filter((id) => has(id, 'transcript')), translators: ids.filter((id) => has(id, 'chat', 'completion')) };
    for (const name of ids.filter((id) => (of.get(id) ?? []).length === 0)) {
      const pipeline = json(await get(port, configPath(name), 4000))?.pipeline;
      if (!pipeline || typeof pipeline !== 'object' || (!pipeline.transcription && !pipeline.llm)) continue;
      out.pipelines.push({ name, transcription: String(pipeline.transcription ?? ''), llm: String(pipeline.llm ?? '') });
    }
    return out;
  }

  /**
   * Names another recognizer or text model in a pipeline — only one this
   * LocalAI lists for that work — and lets the one it replaces go from memory.
   * Answers `{ ok, error?, ...pipelines() }`.
   */
  async function setPipeline(name, change = {}) {
    const before = await pipelines();
    const pipeline = before.pipelines.find((p) => p.name === name);
    if (!pipeline) return { ok: false, error: 'LocalAI lists no such pipeline.', ...before };
    const patch = {};
    if (typeof change.transcription === 'string' && before.recognizers.includes(change.transcription)) patch.transcription = change.transcription;
    if (typeof change.llm === 'string' && before.translators.includes(change.llm)) patch.llm = change.llm;
    if (Object.keys(patch).length === 0) return { ok: false, error: 'LocalAI lists no such model for that stage.', ...before };
    // The pipeline goes up whole: nothing says a partial update merges what is nested, and the rest of it must stay.
    const whole = json(await get(port, configPath(name), 4000))?.pipeline ?? {};
    const answer = await send(port, 'PATCH', configPath(name), { pipeline: { ...whole, ...patch } });
    if (!answer || answer.status < 200 || answer.status >= 300) {
      return { ok: false, error: answer ? `LocalAI answered HTTP ${answer.status}: ${String(answer.body).replace(/\s+/g, ' ').slice(0, 200)}` : 'LocalAI did not answer.', ...before };
    }
    // What it replaced is no longer asked for: unloaded, so two recognizers do not sit in memory. It loads again if named again.
    for (const [stage, was] of [['transcription', pipeline.transcription], ['llm', pipeline.llm]]) {
      if (patch[stage] && was && was !== patch[stage]) await send(port, 'POST', '/backend/shutdown', { model: was }, 15000);
    }
    return { ok: true, ...(await pipelines()) };
  }

  return { status: () => current, refresh, start, stop, pipelines, setPipeline, bin, port };
}

module.exports = { createLocalServer, buildArgs, buildEnv, candidates, portOf, localGet, localSend, IDLE_TIMEOUT };
