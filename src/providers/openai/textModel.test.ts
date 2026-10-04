import { describe, expect, it, vi } from 'vitest';
import { createVirtualClock } from '../../lib/contract/clock';
import { chatUrl, completeText, httpBaseOf, TEXT_TIMEOUT_MS, visibleText } from './textModel';

const REQUEST = { url: 'http://host:8080/v1/chat/completions', model: 'hy-mt2-1.8b', system: 'Translate.', user: '你好' };
const sse = (...pieces: string[]) => new Response(
  `${pieces.map((p) => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`).join('')}data: [DONE]\n\n`,
  { headers: { 'Content-Type': 'text/event-stream' } },
);
const whole = (content: string) => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), { headers: { 'Content-Type': 'application/json' } });
const deps = (fetch: typeof globalThis.fetch, extra: Partial<Parameters<typeof completeText>[1]> = {}) => ({ fetch, clock: createVirtualClock(0), signal: new AbortController().signal, ...extra });

describe('a text model\'s URLs', () => {
  it('reads an OpenAI-style base as its chat-completions URL, and keeps one that already names the path', () => {
    expect(chatUrl('http://localhost:11434/v1')).toBe('http://localhost:11434/v1/chat/completions');
    expect(chatUrl(' https://api.openai.com/v1/ ')).toBe('https://api.openai.com/v1/chat/completions');
    expect(chatUrl('http://host/v1/chat/completions')).toBe('http://host/v1/chat/completions');
  });

  it('finds a Realtime server\'s text models beside its socket', () => {
    expect(httpBaseOf('ws://192.168.1.10:8080/v1/realtime')).toBe('http://192.168.1.10:8080/v1');
    expect(httpBaseOf('wss://mac.local/v1/realtime')).toBe('https://mac.local/v1');
  });
});

describe('what of an answer is shown', () => {
  it('leaves out a reasoning model\'s thinking, closed or still open, and trims the rest', () => {
    expect(visibleText('<think>the user said hello</think>\n\nこんにちは')).toBe('こんにちは');
    expect(visibleText('<think>still going')).toBe('');
    expect(visibleText('  こんにちは \n')).toBe('こんにちは');
  });
});

describe('one answer from a text model', () => {
  it('POSTs the system and user messages to the model, streamed, with the placeholder token when there is no key', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => sse('こん', 'にちは'));
    const answer = await completeText(REQUEST, deps(fetch));
    expect(answer.text).toBe('こんにちは');
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(REQUEST.url);
    expect(init?.method).toBe('POST');
    // Never without an Authorization header: a LocalAI takes a page's POST without one for a forged request.
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer no-key' });
    expect(JSON.parse(init?.body as string)).toEqual({ model: 'hy-mt2-1.8b', stream: true, messages: [{ role: 'system', content: 'Translate.' }, { role: 'user', content: '你好' }] });
  });

  it('sends a key as a Bearer token', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => sse('ok'));
    await completeText({ ...REQUEST, key: 'sk-test' }, deps(fetch));
    expect((fetch.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
  });

  it('says the answer each time it grows, thinking left out', async () => {
    const said: string[] = [];
    await completeText(REQUEST, deps(async () => sse('<think>hm', '</think>', 'こん', 'にちは'), { onText: (t) => said.push(t) }));
    expect(said).toEqual(['こん', 'こんにちは']);
  });

  it('reads a server that does not stream whole', async () => {
    const said: string[] = [];
    const answer = await completeText(REQUEST, deps(async () => whole('こんにちは'), { onText: (t) => said.push(t) }));
    expect(answer.text).toBe('こんにちは');
    expect(said).toEqual(['こんにちは']);
  });

  it('throws the server\'s own words on a refusal', async () => {
    const refused = async () => new Response(JSON.stringify({ error: { message: 'model not found' } }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    await expect(completeText(REQUEST, deps(refused))).rejects.toThrow('HTTP 404: model not found');
  });

  it('gives up after its bound, in its own words, and aborts the request', async () => {
    const clock = createVirtualClock(0);
    let aborted = false;
    const hang = (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { aborted = true; reject(new DOMException('aborted', 'AbortError')); });
    });
    const pending = completeText(REQUEST, { fetch: hang, clock, signal: new AbortController().signal });
    clock.advance(TEXT_TIMEOUT_MS);
    await expect(pending).rejects.toThrow(/did not finish within 60 s/);
    expect(aborted).toBe(true);
  });

  it('stops when the session does', async () => {
    const controller = new AbortController();
    const hang = (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    });
    const pending = completeText(REQUEST, { fetch: hang, clock: createVirtualClock(0), signal: controller.signal });
    controller.abort(new Error('the session ended'));
    await expect(pending).rejects.toThrow('the session ended');
  });
});
