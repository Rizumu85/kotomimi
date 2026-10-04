// @vitest-environment node
// electron/local-server.pipelines.test.js
//
// Fork: the pipelines of a LocalAI, and which models they name. The LocalAI
// here is a table of answers: what it lists, its pipeline's config, and a
// record of everything sent to it.
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createLocalServer } = require('./local-server.js');

const HOME = path.join(path.sep, 'home', 'riz');
const PIPELINE = { llm: 'hy-mt2', transcription: 'apple-speech', vad: 'silero', turn_detection: { type: 'semantic_vad' } };
const LISTS = {
  '/v1/models': { data: [{ id: 'gpt-realtime' }, { id: 'apple-speech' }, { id: 'whisper' }, { id: 'hy-mt2' }, { id: 'gemma' }, { id: 'silero' }] },
  '/v1/models/capabilities': { data: [
    { id: 'gpt-realtime', capabilities: null }, { id: 'apple-speech', capabilities: ['transcript'] }, { id: 'whisper', capabilities: ['transcript'] },
    { id: 'hy-mt2', capabilities: ['chat', 'completion'] }, { id: 'gemma', capabilities: ['chat'] }, { id: 'silero', capabilities: ['vad'] },
  ] },
};

/** A LocalAI that is up. `patch`: how it answers a change. */
function localai({ patch = { status: 200, body: '{}' }, lists = LISTS } = {}) {
  const sent = [];
  const config = { name: 'gpt-realtime', pipeline: { ...PIPELINE } };
  const server = createLocalServer({
    home: HOME,
    platform: 'darwin',
    arch: 'arm64',
    env: {},
    exists: () => false,
    readFile: () => { throw new Error('ENOENT'); },
    get: async (port, pathname) => {
      if (pathname === '/api/models/config-json/gpt-realtime') return { status: 200, body: JSON.stringify(config) };
      return lists[pathname] ? { status: 200, body: JSON.stringify(lists[pathname]) } : { status: 404, body: '' };
    },
    send: async (port, method, pathname, body) => {
      sent.push({ method, pathname, body });
      if (method === 'PATCH' && patch.status === 200) config.pipeline = body.pipeline;
      return method === 'PATCH' ? patch : { status: 200, body: '{}' };
    },
  });
  return { server, sent };
}

describe('the pipelines of a LocalAI', () => {
  it('are listed with the recognizer and the text model each names, and what either could be', async () => {
    const { server } = localai();
    expect(await server.pipelines()).toEqual({
      pipelines: [{ name: 'gpt-realtime', transcription: 'apple-speech', llm: 'hy-mt2' }],
      recognizers: ['apple-speech', 'whisper'],
      translators: ['hy-mt2', 'gemma'],
    });
  });

  it('take another recognizer: the pipeline goes up whole with that one part changed, and the old one is let go from memory', async () => {
    const { server, sent } = localai();
    const answer = await server.setPipeline('gpt-realtime', { transcription: 'whisper' });
    expect(answer.ok).toBe(true);
    expect(answer.pipelines).toEqual([{ name: 'gpt-realtime', transcription: 'whisper', llm: 'hy-mt2' }]);
    expect(sent).toEqual([
      { method: 'PATCH', pathname: '/api/models/config-json/gpt-realtime', body: { pipeline: { ...PIPELINE, transcription: 'whisper' } } },
      { method: 'POST', pathname: '/backend/shutdown', body: { model: 'apple-speech' } },
    ]);
  });

  it('leave loaded what a change replaces while a session still runs on it, and unload it otherwise', async () => {
    for (const [options, shutdowns] of [[{ keep: ['apple-speech'] }, 0], [{ keep: ['whisper'] }, 1], [undefined, 1]]) {
      const { server, sent } = localai();
      expect((await server.setPipeline('gpt-realtime', { transcription: 'whisper' }, options)).ok).toBe(true);
      expect(sent.filter((call) => call.pathname === '/backend/shutdown')).toHaveLength(shutdowns);
    }
  });

  it('take another translation model the same way', async () => {
    const { server, sent } = localai();
    expect((await server.setPipeline('gpt-realtime', { llm: 'gemma' })).pipelines[0].llm).toBe('gemma');
    expect(sent[0].body.pipeline).toEqual({ ...PIPELINE, llm: 'gemma' });
    expect(sent[1]).toEqual({ method: 'POST', pathname: '/backend/shutdown', body: { model: 'hy-mt2' } });
  });

  it('are left alone for a model this LocalAI does not list for that work, or a pipeline it does not have', async () => {
    const { server, sent } = localai();
    // A text model is no recognizer, and a VAD is neither.
    expect((await server.setPipeline('gpt-realtime', { transcription: 'gemma' })).ok).toBe(false);
    expect((await server.setPipeline('gpt-realtime', { llm: 'silero' })).ok).toBe(false);
    expect((await server.setPipeline('nope', { llm: 'gemma' })).ok).toBe(false);
    expect(sent).toEqual([]);
  });

  it('report LocalAI\'s own words when it refuses the change, and unload nothing', async () => {
    const { server, sent } = localai({ patch: { status: 500, body: '{"error":"read-only  file system"}' } });
    const answer = await server.setPipeline('gpt-realtime', { transcription: 'whisper' });
    expect(answer.ok).toBe(false);
    expect(answer.error).toContain('HTTP 500');
    expect(answer.error).toContain('read-only file system');
    expect(answer.pipelines[0].transcription).toBe('apple-speech');
    expect(sent).toHaveLength(1);
  });

  it('are not offered where the LocalAI does not say what its models are for, or is not up', async () => {
    const { server } = localai({ lists: { '/v1/models': LISTS['/v1/models'] } });
    expect(await server.pipelines()).toEqual({ pipelines: [], recognizers: [], translators: [] });
    const down = createLocalServer({ home: HOME, platform: 'darwin', env: {}, exists: () => false, readFile: () => { throw new Error('ENOENT'); }, get: async () => null, send: async () => null });
    expect(await down.pipelines()).toEqual({ pipelines: [], recognizers: [], translators: [] });
  });

  it('say LocalAI could not be reached when a change finds it down, and that the pipeline is missing when it is up without one', async () => {
    const down = createLocalServer({ home: HOME, platform: 'darwin', env: {}, exists: () => false, readFile: () => { throw new Error('ENOENT'); }, get: async () => null, send: async () => null });
    expect(await down.setPipeline('gpt-realtime', { transcription: 'whisper' })).toMatchObject({ ok: false, error: 'LocalAI could not be reached.' });
    // Up, answering, and listing no pipeline: an older LocalAI that says nothing of what its models are for.
    const bare = createLocalServer({ home: HOME, platform: 'darwin', env: {}, exists: () => false, readFile: () => { throw new Error('ENOENT'); }, get: async (port, pathname) => (pathname === '/readyz' ? { status: 200, body: 'OK' } : { status: 404, body: '' }), send: async () => null });
    expect(await bare.setPipeline('gpt-realtime', { transcription: 'whisper' })).toMatchObject({ ok: false, error: 'LocalAI lists no such pipeline.' });
    const { server, sent } = localai();
    expect(await server.setPipeline('nope', { transcription: 'whisper' })).toMatchObject({ ok: false, error: 'LocalAI lists no such pipeline.' });
    expect(sent).toEqual([]);
  });
});
