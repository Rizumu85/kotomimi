import { describe, expect, it, vi } from 'vitest';
import { createVirtualClock } from '../../lib/contract/clock';
import { chatUrl, completeText, httpBaseOf, retryAfterMs, TEXT_TIMEOUT_MS, visibleText } from './textModel';

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

describe('a text model that is busy for now (a phone that lends its models)', () => {
  const busy = (status: number, retryAfter?: string) => new Response(JSON.stringify({ error: { message: status === 429 ? 'busy' : 'no memory now' } }), { status, headers: { 'Content-Type': 'application/json', ...(retryAfter ? { 'Retry-After': retryAfter } : {}) } });
  /** Lets the awaited fetch and the body's cancel settle before the clock is moved. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('is asked again after the wait it names, the same request each time, when retries are allowed', async () => {
    const clock = createVirtualClock(0);
    const answers = [busy(429, '2'), busy(503, '5'), sse('你好')];
    const bodies: string[] = [];
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => { bodies.push(init?.body as string); return answers.shift()!; });
    const pending = completeText({ ...REQUEST, busyRetries: 3 }, { fetch, clock, signal: new AbortController().signal });
    await settle();
    expect(fetch).toHaveBeenCalledTimes(1);
    clock.advance(1999);
    await settle();
    expect(fetch).toHaveBeenCalledTimes(1);
    clock.advance(1);
    await settle();
    expect(fetch).toHaveBeenCalledTimes(2);
    clock.advance(5000);
    expect((await pending).text).toBe('你好');
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(new Set(bodies).size).toBe(1);
  });

  it('gives up after the retries allowed, with the last refusal in its own words', async () => {
    const clock = createVirtualClock(0);
    const fetch = vi.fn(async () => busy(429, '1'));
    const failed = expect(completeText({ ...REQUEST, busyRetries: 2 }, { fetch, clock, signal: new AbortController().signal })).rejects.toThrow('HTTP 429: busy');
    for (let i = 0; i < 4; i += 1) {
      await settle();
      clock.advance(1000);
    }
    await failed;
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('is not asked again where no retry is allowed: any other server, as before', async () => {
    const fetch = vi.fn(async () => busy(503, '1'));
    await expect(completeText(REQUEST, deps(fetch))).rejects.toThrow('HTTP 503: no memory now');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('waits within its one bound, its own when it is given one', async () => {
    const clock = createVirtualClock(0);
    const fetch = vi.fn(async () => busy(429, '10'));
    const failed = expect(completeText({ ...REQUEST, busyRetries: 100, timeoutMs: 15_000 }, { fetch, clock, signal: new AbortController().signal })).rejects.toThrow(/did not finish within 15 s/);
    await settle();
    clock.advance(10_000);
    await settle();
    clock.advance(5_000);
    await failed;
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('stops waiting when the session does', async () => {
    const controller = new AbortController();
    const clock = createVirtualClock(0);
    const fetch = vi.fn(async () => busy(429, '2'));
    const pending = completeText({ ...REQUEST, busyRetries: 3 }, { fetch, clock, signal: controller.signal });
    await settle();
    controller.abort(new Error('the session ended'));
    await expect(pending).rejects.toThrow('the session ended');
    clock.advance(10_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('reads the wait as seconds, held between half a second and ten, and two where it names none', () => {
    expect(retryAfterMs('2')).toBe(2000);
    expect(retryAfterMs('5')).toBe(5000);
    expect(retryAfterMs('0')).toBe(500);
    expect(retryAfterMs('600')).toBe(10_000);
    expect(retryAfterMs(null)).toBe(2000);
    expect(retryAfterMs('Wed, 21 Oct 2026 07:28:00 GMT')).toBe(2000);
  });
});
