// @vitest-environment node
// electron/local-server.test.js
//
// Fork: the LocalAI of this computer, run by the app. No LocalAI and no
// process here: the installation is a set of paths that "exist", the process
// a recorder, and the port answers what the test says it does.
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createLocalServer, buildArgs, buildEnv, candidates, portOf } = require('./local-server.js');

const HOME = path.join(path.sep, 'home', 'riz');
const BASE = path.join(HOME, '.localai');
const BIN = path.join(BASE, 'bin', 'local-ai');
const ALL_FLAGS = '--models-path --backends-path --address --allow-insecure-public-bind --data-path --localai-config-dir --generated-content-path --upload-path';
const under = (...names) => new Set([BIN, ...names.map((name) => path.join(BASE, name))]);

/** A computer: which paths exist, whether the port answers, and every process started on it. */
function computer({ files = under('models', 'backends'), launcher = null, answering = false, models = ['gpt-realtime', 'hy-mt2-1.8b'] } = {}) {
  const world = { answering, started: [], changes: [] };
  const spawn = (bin, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = [];
    child.kill = (signal = 'SIGTERM') => {
      child.killed.push(signal);
      world.answering = false;
      queueMicrotask(() => child.emit('exit', null));
      return true;
    };
    world.started.push({ bin, args, options, child });
    return child;
  };
  const server = createLocalServer({
    home: HOME,
    platform: 'darwin',
    arch: 'arm64',
    env: { PATH: '/usr/bin' },
    exists: (file) => files.has(file),
    readFile: () => { if (!launcher) throw new Error('ENOENT'); return JSON.stringify(launcher); },
    spawn,
    get: async (port, pathname) => {
      world.asked = port;
      if (!world.answering) return null;
      return pathname === '/readyz' ? { status: 200, body: '' } : { status: 200, body: JSON.stringify({ object: 'list', data: models.map((id) => ({ id })) }) };
    },
    help: async () => ALL_FLAGS,
    sleep: async () => { await new Promise((r) => setTimeout(r, 1)); world.onWait?.(); },
    onChange: (status) => world.changes.push(status.state),
    readyTimeoutMs: 80,
  });
  return { server, world };
}

describe('where a LocalAI is looked for, and what it is started with', () => {
  it('is its own launcher\'s place first, then Homebrew\'s; on Windows the launcher\'s alone', () => {
    expect(candidates(HOME, 'darwin')).toEqual([BIN, '/opt/homebrew/bin/local-ai', '/usr/local/bin/local-ai']);
    expect(candidates('C:\\Users\\riz', 'win32')).toEqual([path.join('C:\\Users\\riz', '.localai', 'bin', 'local-ai.exe')]);
  });

  it('reads the port of a listen address, and takes 8080 for what is none', () => {
    expect(portOf('0.0.0.0:8080')).toBe(8080);
    expect(portOf(':9000')).toBe(9000);
    expect(portOf('nonsense')).toBe(8080);
    expect(portOf(undefined)).toBe(8080);
  });

  it('gives the folders that exist and the flags this LocalAI knows, and no other', () => {
    const exists = (file) => under('models', 'backends', 'data').has(file);
    expect(buildArgs({ base: BASE, address: '0.0.0.0:8080', help: ALL_FLAGS, exists })).toEqual([
      'run', '--models-path', path.join(BASE, 'models'), '--backends-path', path.join(BASE, 'backends'), '--address', '0.0.0.0:8080', '--allow-insecure-public-bind', '--data-path', path.join(BASE, 'data'),
    ]);
    // One that has an idle watchdog is told to use it: a model nobody asks for is let go from memory.
    expect(buildArgs({ base: BASE, address: '127.0.0.1:8080', help: `${ALL_FLAGS} --enable-watchdog-idle --watchdog-idle-timeout`, exists: () => false })).toEqual(['run', '--address', '127.0.0.1:8080', '--enable-watchdog-idle', '--watchdog-idle-timeout=10m']);
    // An older LocalAI: the flag it does not know would stop it from starting.
    expect(buildArgs({ base: BASE, address: '0.0.0.0:8080', help: '--models-path --address', exists })).toEqual(['run', '--models-path', path.join(BASE, 'models'), '--address', '0.0.0.0:8080']);
    // Bound to this computer alone, nothing is insecure about it.
    expect(buildArgs({ base: BASE, address: '127.0.0.1:8080', help: ALL_FLAGS, exists: () => false })).toEqual(['run', '--address', '127.0.0.1:8080']);
  });

  it('adds what an app started from the Finder lacks: the usual PATH, and Metal on Apple silicon', () => {
    const made = buildEnv({ env: { PATH: '/usr/bin', HOME }, launcherEnv: { DEBUG: 'true' }, platform: 'darwin', arch: 'arm64', base: BASE, exists: () => false });
    expect(made.PATH.split(path.delimiter)).toEqual(['/usr/bin', '/opt/homebrew/bin', '/usr/local/bin', '/bin', '/usr/sbin', '/sbin']);
    expect(made).toMatchObject({ HOME, DEBUG: 'true', LOCALAI_FORCE_META_BACKEND_CAPABILITY: 'metal' });
    expect(buildEnv({ env: { PATH: 'C:\\Windows' }, launcherEnv: {}, platform: 'win32', arch: 'x64', base: BASE, exists: () => false })).toEqual({ PATH: 'C:\\Windows' });
  });
});

describe('the LocalAI of this computer', () => {
  it('is absent where none is installed, and starting it does nothing', async () => {
    const { server, world } = computer({ files: new Set() });
    expect(server.status()).toMatchObject({ installed: false, state: 'absent' });
    expect((await server.start()).state).toBe('absent');
    expect(world.started).toEqual([]);
  });

  it('starts, waits until it answers, and then says what it serves', async () => {
    const { server, world } = computer({ launcher: { address: '0.0.0.0:8085', environment_vars: { DEBUG: 'true' } } });
    expect(server.status()).toMatchObject({ installed: true, state: 'stopped', port: 8085 });
    world.onWait = () => { world.answering = true; };
    const status = await server.start();
    expect(status).toMatchObject({ state: 'running', models: ['gpt-realtime', 'hy-mt2-1.8b'], tail: '' });
    expect(world.changes).toEqual(['starting', 'running']);
    expect(world.asked).toBe(8085);
    expect(world.started).toHaveLength(1);
    expect(world.started[0].bin).toBe(BIN);
    // On the launcher's port, and on this computer alone: the launcher's own host would open it to the network.
    expect(world.started[0].args).toContain('127.0.0.1:8085');
    expect(world.started[0].args).not.toContain('0.0.0.0:8085');
    expect(world.started[0].args).not.toContain('--allow-insecure-public-bind');
    expect(world.started[0].options.cwd).toBe(HOME);
    expect(world.started[0].options.env).toMatchObject({ DEBUG: 'true', LOCALAI_FORCE_META_BACKEND_CAPABILITY: 'metal' });
    // Asked again while it runs: nothing more is started.
    await server.start();
    expect(world.started).toHaveLength(1);
  });

  it('stops the one it started, and no other', async () => {
    const { server, world } = computer();
    world.onWait = () => { world.answering = true; };
    await server.start();
    expect((await server.stop()).state).toBe('stopped');
    expect(world.started[0].child.killed).toEqual(['SIGTERM']);
    expect(world.changes).toEqual(['starting', 'running', 'stopped']);
    // Nothing of its own is left to stop.
    await server.stop();
    expect(world.started[0].child.killed).toEqual(['SIGTERM']);
  });

  it('leaves alone a LocalAI something else started: it is running, and not this app\'s to stop', async () => {
    const { server, world } = computer({ answering: true });
    expect((await server.refresh()).state).toBe('external');
    expect((await server.start()).state).toBe('external');
    expect((await server.stop()).state).toBe('external');
    expect(world.started).toEqual([]);
  });

  it('says why when it would not start: its own last words', async () => {
    const { server, world } = computer();
    world.onWait = () => {
      const { child } = world.started[0];
      child.stderr.emit('data', 'reading config\nfatal: unknown flag --nope\n');
      child.emit('exit', 1);
    };
    const status = await server.start();
    expect(status.state).toBe('failed');
    expect(status.tail).toBe('reading config\nfatal: unknown flag --nope');
    // It can be tried again.
    world.onWait = () => { world.answering = true; };
    expect((await server.start()).state).toBe('running');
  });

  it('fails at once, and keeps the app up, when the process cannot be started at all', async () => {
    const { server, world } = computer();
    world.onWait = () => {
      const { child } = world.started[0];
      // What Node does for a program that will not run: an error on the process, and one on each of its pipes.
      expect(child.stdout.listenerCount('error')).toBe(1);
      expect(child.stderr.listenerCount('error')).toBe(1);
      child.stdout.emit('error', new Error('read ENOTCONN'));
      child.emit('error', new Error('spawn local-ai ENOENT'));
    };
    const status = await server.start();
    expect(status).toMatchObject({ state: 'failed', tail: 'spawn local-ai ENOENT' });
    expect(world.changes).toEqual(['starting', 'failed']);
  });

  it('gives up on one that never answers, and does not leave it running', async () => {
    const { server, world } = computer();
    const status = await server.start();
    expect(status.state).toBe('failed');
    expect(status.tail).toContain('did not answer in time');
    expect(world.started[0].child.killed).toHaveLength(1);
  });

  it('notices when the one it started goes away by itself', async () => {
    const { server, world } = computer();
    world.onWait = () => { world.answering = true; };
    await server.start();
    world.answering = false;
    world.started[0].child.emit('exit', 0);
    expect(server.status().state).toBe('stopped');
    expect((await server.refresh()).state).toBe('stopped');
  });
});

describe('a LocalAI whose help could not be read', () => {
  it('is still told where to listen: left to itself it listens on every network', () => {
    expect(buildArgs({ base: '/x', address: '127.0.0.1:8080', help: '', exists: () => false })).toEqual(['run', '--address', '127.0.0.1:8080']);
    // One whose help was read and names no such flag is not given it: an unknown flag stops it from starting.
    expect(buildArgs({ base: '/x', address: '127.0.0.1:8080', help: '--models-path', exists: () => false })).toEqual(['run']);
  });
});
