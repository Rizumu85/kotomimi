/**
 * Fork: a recognition engine on another device, as the page uses it (`remoteEngine.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineNode, isEngineNode, remoteBridge } from './remoteEngine';

const answer = (status: number, headers: Record<string, string> = {}) => new Response('{"object":"list","data":[]}', { status, headers });

describe('telling a Kotomimi phone from any other API', () => {
  const invoke = vi.fn();
  const receive = vi.fn();
  const removeListener = vi.fn();
  beforeEach(() => { (window as unknown as { electron?: unknown }).electron = { invoke, receive, removeListener }; });
  afterEach(() => { delete (window as unknown as { electron?: unknown }).electron; vi.clearAllMocks(); });

  it('is one where the model list says it is the engine', async () => {
    const fetchIt = vi.fn(async (_url: string) => answer(200, { 'X-Kotomimi-Node': 'engine' }));
    expect(await isEngineNode('http://192.168.1.23:8792/v1/', fetchIt as unknown as typeof fetch)).toBe(true);
    expect(fetchIt.mock.calls[0][0]).toBe('http://192.168.1.23:8792/v1/models');
  });

  it('is not where the list says nothing of it, where nothing answers, or where the answer is a refusal', async () => {
    expect(await isEngineNode('http://192.168.1.23:8080/v1', (async () => answer(200)) as unknown as typeof fetch)).toBe(false);
    expect(await isEngineNode('http://192.168.1.23:8792/v1', (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch)).toBe(false);
    expect(await isEngineNode('http://192.168.1.23:8792/v1', (async () => answer(403, { 'X-Kotomimi-Node': 'engine' })) as unknown as typeof fetch)).toBe(false);
  });

  it('is not asked of an address that is not plain http: an API on the internet is read as the API it is', async () => {
    const fetchIt = vi.fn(async () => answer(200, { 'X-Kotomimi-Node': 'engine' }));
    expect(await isEngineNode('https://api.openai.com/v1', fetchIt as unknown as typeof fetch)).toBe(false);
    expect(fetchIt).not.toHaveBeenCalled();
  });

  it('gives up on an address that does not answer in time', async () => {
    const fetchIt = ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => { init.signal?.addEventListener('abort', () => reject(new Error('aborted'))); })) as unknown as typeof fetch;
    expect(await isEngineNode('http://192.168.1.23:8792/v1', fetchIt, undefined, 20)).toBe(false);
  });

  it('says which model the phone lends now', async () => {
    const lending = (async () => new Response(JSON.stringify({ object: 'list', data: [{ id: 'qwen3-asr-1.7b-q8' }] }), { status: 200, headers: { 'X-Kotomimi-Node': 'engine' } })) as unknown as typeof fetch;
    expect(await engineNode('http://192.168.1.23:8792/v1', lending)).toEqual({ model: 'qwen3-asr-1.7b-q8' });
    // A list that cannot be read is still a phone: the model written down is asked for.
    const unread = (async () => new Response('not a list', { status: 200, headers: { 'X-Kotomimi-Node': 'engine' } })) as unknown as typeof fetch;
    expect(await engineNode('http://192.168.1.23:8792/v1', unread)).toEqual({ model: '' });
    expect(await engineNode('http://192.168.1.23:8080/v1', (async () => answer(200)) as unknown as typeof fetch)).toBeNull();
  });

  it('opens its recognitions at the address it was given', async () => {
    invoke.mockResolvedValue(undefined).mockResolvedValueOnce(7);
    const bridge = remoteBridge('http://192.168.1.23:8792/v1');
    expect(await bridge.open({ language: 'ja', sampleRate: 16000, model: 'qwen3-asr-0.6b-q8' })).toBe(7);
    expect(invoke).toHaveBeenCalledWith('remote-engine:stream-open', { language: 'ja', sampleRate: 16000, model: 'qwen3-asr-0.6b-q8', base: 'http://192.168.1.23:8792/v1' });
    bridge.end(7);
    expect(invoke).toHaveBeenLastCalledWith('remote-engine:stream-end', { id: 7 });
  });
});

describe('with no main process', () => {
  it('nothing is a phone, and nothing opens', async () => {
    expect(await isEngineNode('http://192.168.1.23:8792/v1', (async () => answer(200, { 'X-Kotomimi-Node': 'engine' })) as unknown as typeof fetch)).toBe(false);
    expect(await remoteBridge('http://192.168.1.23:8792/v1').open({ language: 'ja', sampleRate: 16000 })).toBeNull();
  });
});
