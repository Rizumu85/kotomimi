// Fork: an API's own model list, as the model field's menu asks for it.
import { describe, expect, it, vi } from 'vitest';
import { listApiModels, menuOf, searchModels } from './apiModelList';
import { API_SERVICES } from './apiServices';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('the models a service lists', () => {
  it('are asked of the address the field belongs to, the key in the header and never in the address', async () => {
    const fetched = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => json({ data: [{ id: 'b-model' }, { id: 'a-model' }, { id: 'b-model' }, { id: 7 }, {}] }));
    const answer = await listApiModels(' https://api.example.com/v1/ ', ' sk-secret ', { fetch: fetched });
    expect(answer).toEqual({ ok: true, ids: ['b-model', 'a-model'] });
    const [url, init] = fetched.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/models');
    expect(init).toMatchObject({ method: 'GET', headers: { Authorization: 'Bearer sk-secret' } });
    expect(String(url)).not.toContain('sk-secret');
  });

  it('are asked with no header at all of a service that wants no key', async () => {
    const fetched = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => json({ data: [{ id: 'local' }] }));
    await listApiModels('http://localhost:11434/v1', undefined, { fetch: fetched });
    expect(fetched.mock.calls[0][1]?.headers).toBeUndefined();
  });

  it('say why there is no list: the key was refused, nothing answered, or the service lists none', async () => {
    const answers = (response: () => Promise<Response>) => listApiModels('https://api.example.com/v1', 'k', { fetch: response });
    expect(await answers(async () => json({ error: 'no' }, 401))).toEqual({ ok: false, why: 'key' });
    expect(await answers(async () => json({ error: 'no' }, 403))).toEqual({ ok: false, why: 'key' });
    // Google's way of refusing a key.
    expect(await answers(async () => new Response('API key not valid. Please pass a valid API key.', { status: 400 }))).toEqual({ ok: false, why: 'key' });
    expect(await answers(async () => new Response('bad request', { status: 400 }))).toEqual({ ok: false, why: 'none' });
    expect(await answers(async () => json({}, 404))).toEqual({ ok: false, why: 'none' });
    expect(await answers(async () => json({ data: [] }))).toEqual({ ok: false, why: 'none' });
    expect(await answers(async () => new Response('<html>', { status: 200 }))).toEqual({ ok: false, why: 'none' });
    expect(await answers(async () => { throw new TypeError('Failed to fetch'); })).toEqual({ ok: false, why: 'unreachable' });
    expect(await listApiModels('  ', 'k', { fetch: async () => json({ data: [{ id: 'x' }] }) })).toEqual({ ok: false, why: 'unreachable' });
  });

  it('are given up when the menu is closed, or when the service takes too long', async () => {
    const hangs = (_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
    const closed = new AbortController();
    const asked = listApiModels('https://api.example.com/v1', 'k', { fetch: hangs, signal: closed.signal });
    closed.abort();
    expect(await asked).toEqual({ ok: false, why: 'unreachable' });
    expect(await listApiModels('https://api.example.com/v1', 'k', { fetch: hangs, timeoutMs: 5 })).toEqual({ ok: false, why: 'unreachable' });
  });
});

describe('the menu of them', () => {
  const deepseek = API_SERVICES.find((s) => s.id === 'deepseek')!;
  const ids = ['deepseek-reasoner', 'deepseek-flash', 'deepseek-chat'];

  it('puts the model that suits the stage first, and leaves the rest as the service lists them', () => {
    expect(menuOf(ids, null, deepseek, 'text')).toEqual({ ids: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-flash'], suggested: 'deepseek-chat' });
    // An address typed by hand has no service to suggest for it.
    expect(menuOf(ids, null, undefined, 'text')).toEqual({ ids });
  });

  it('is what a search finds while something is searched for, whatever the case, and all of it otherwise', () => {
    expect(menuOf(ids, 'FLASH', deepseek, 'text').ids).toEqual(['deepseek-flash']);
    expect(menuOf(ids, '  ', deepseek, 'text').ids).toHaveLength(3);
    expect(menuOf(ids, 'gpt', deepseek, 'text')).toEqual({ ids: [], suggested: 'deepseek-chat' });
  });
});

describe('a search of the models', () => {
  const ids = ['openai/gpt-6.1-sol', 'openai/gpt-6.1-sol-pro', 'google/gemini-3.8-flash', 'google/gemini-3.8-flash-lite', 'anthropic/claude-sonnet-5.5', 'deepseek/deepseek-flash', 'meta/llama-5-70b-versatile'];
  const GEMINI = ['google/gemini-3.8-flash', 'google/gemini-3.8-flash-lite'];
  const GPT = ['openai/gpt-6.1-sol', 'openai/gpt-6.1-sol-pro'];

  it('finds every name that holds every word, in any order', () => {
    expect(searchModels(ids, 'flash gemini')).toEqual(GEMINI);
    expect(searchModels(ids, 'sonnet')).toEqual(['anthropic/claude-sonnet-5.5']);
    expect(searchModels(ids, 'flash claude')).toEqual([]);
    expect(searchModels(ids, '')).toEqual(ids);
    expect(searchModels(ids, null)).toEqual(ids);
  });

  it('puts first the names a word begins, or begins a part of', () => {
    expect(searchModels(['x/turbo-gpt', 'gpt-mini', 'x/chatgpt'], 'gpt')).toEqual(['gpt-mini', 'x/turbo-gpt', 'x/chatgpt']);
    expect(searchModels(ids, 'deepseek')).toEqual(['deepseek/deepseek-flash']);
    // Found equally well, they stay as the service lists them.
    expect(searchModels(ids, 'gpt')).toEqual(GPT);
  });

  it('forgives a hyphen or a dot left out, and a letter or two', () => {
    expect(searchModels(ids, 'gpt6.1')).toEqual(GPT);
    expect(searchModels(ids, 'gpt61')).toEqual(GPT);
    expect(searchModels(ids, 'gemni')).toEqual(GEMINI);
    expect(searchModels(ids, 'clde')).toEqual(['anthropic/claude-sonnet-5.5']);
    // Not any letters anywhere: two letters are not guessed from, and letters far apart are not a word.
    expect(searchModels(ids, 'gs')).toEqual([]);
    expect(searchModels(ids, 'gsh')).toEqual([]);
  });

  it('reads what an input method has not turned into its own characters yet: the marks between syllables, full-width letters', () => {
    expect(searchModels(ids, "ge'mi'ni")).toEqual(GEMINI);
    expect(searchModels(ids, 'ge mi ni')).toEqual(GEMINI);
    expect(searchModels(ids, 'ＧＰＴ')).toEqual(GPT);
    expect(searchModels(ids, 'CLAUDE')).toEqual(['anthropic/claude-sonnet-5.5']);
  });
});
