import { describe, expect, it, vi } from 'vitest';
import { lentChoice, phoneTextBase, phoneTextList, warmPhones } from './phoneText';
import type { PhoneTextModel } from '../../lib/lan/discover';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'X-Kotomimi-Node': 'engine' } });
const LIST = {
  object: 'list',
  data: [{ id: 'qwen3-asr-0.6b-q8', object: 'model' }],
  text: [
    { id: 'hy-mt2-1.8b', kind: 'translate', name: 'Hunyuan MT 2 1.8B', loaded: true },
    { id: 'index-translate-2b', kind: 'translate', name: 'Index-Translate 2B', loaded: false },
    { id: 'gemma-4-e2b', kind: 'coach', name: 'Gemma 4 E2B', loaded: false },
  ],
};
const never = new AbortController().signal;

describe('a phone that lends its text models', () => {
  it('is asked at its own address, however the address was written down', () => {
    expect(phoneTextBase('192.168.4.28:8792')).toBe('http://192.168.4.28:8792/v1');
    expect(phoneTextBase(' http://192.168.4.28:8792/v1/ ')).toBe('http://192.168.4.28:8792/v1');
  });

  it('says what it lends in `text`, never in `data`, where its recognizer is', async () => {
    const fetch = vi.fn(async () => json(LIST));
    const lent = await phoneTextList('192.168.4.28:8792', fetch, never);
    expect(fetch).toHaveBeenCalledWith('http://192.168.4.28:8792/v1/models', expect.objectContaining({ method: 'GET' }));
    expect(lent?.map((m) => m.id)).toEqual(['hy-mt2-1.8b', 'index-translate-2b', 'gemma-4-e2b']);
    // A phone of an earlier version lends none; one that answers otherwise is not read.
    expect(await phoneTextList('x:1', async () => json({ data: LIST.data }), never)).toEqual([]);
    expect(await phoneTextList('x:1', async () => json({}, 403), never)).toBeNull();
  });
});

describe('a run that will ask a phone for its text models', () => {
  it('asks it to load the ones it has not loaded, with what goes before the sentence, for one token — and not the ones it has', async () => {
    const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'GET') return json(LIST);
      posts.push({ url: String(input), body: JSON.parse(init?.body as string) });
      return json({ choices: [{ message: { content: 'H' } }] });
    });
    await warmPhones([
      { address: '192.168.4.28:8792', model: 'hy-mt2-1.8b', messages: [] },
      { address: '192.168.4.28:8792', model: 'gemma-4-e2b', messages: [{ role: 'system', content: 'Check the grammar.' }], extra: { temperature: 0, chat_template_kwargs: { enable_thinking: false } } },
    ], fetch, never);
    // Hunyuan is up already: only the feedback model is asked.
    expect(posts).toEqual([{
      url: 'http://192.168.4.28:8792/v1/chat/completions',
      body: { temperature: 0, chat_template_kwargs: { enable_thinking: false }, model: 'gemma-4-e2b', stream: false, max_tokens: 1, messages: [{ role: 'system', content: 'Check the grammar.' }, { role: 'user', content: 'Hello' }] },
    }]);
  });

  it('asks nothing of a model the phone does not lend, and never fails: what fails here fails again on a sentence, where it is said', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => (init?.method === 'GET' ? json(LIST) : Promise.reject(new Error('gone'))));
    await expect(warmPhones([{ address: 'a:1', model: 'qwen3-4b', messages: [] }, { address: 'a:1', model: 'index-translate-2b', messages: [] }], fetch, never)).resolves.toBeUndefined();
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    await expect(warmPhones([{ address: 'a:1', model: 'x', messages: [] }], async () => { throw new TypeError('Failed to fetch'); }, never)).resolves.toBeUndefined();
  });

  it('is stopped with the run', async () => {
    const controller = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => { seen.push(init?.signal ?? undefined); return json(LIST); });
    await warmPhones([{ address: 'a:1', model: 'index-translate-2b', messages: [] }], fetch, controller.signal);
    expect(seen.every((signal) => signal === controller.signal)).toBe(true);
  });
});

describe('the model a stage asks of a phone it is given', () => {
  const lent: PhoneTextModel[] = [
    { id: 'hy-mt2-1.8b', kind: 'translate', name: 'Hunyuan MT 2 1.8B', loaded: true },
    { id: 'index-translate-2b', kind: 'translate', name: 'Index-Translate 2B', loaded: false },
    { id: 'gemma-4-e2b', kind: 'coach', name: 'Gemma 4 E2B', loaded: false },
  ];
  const zhJa = { source: 'zh-CN', target: 'ja' };

  it('is the best of this computer\'s own order, whatever the phone\'s', () => {
    expect(lentChoice(lent, 'translate', zhJa)).toBe('index-translate-2b');
    expect(lentChoice(lent, 'coach', zhJa)).toBe('gemma-4-e2b');
  });

  it('takes one the phone has the memory for before a better one it has not', () => {
    const small: PhoneTextModel[] = [{ ...lent[0], loaded: false, fits: true }, { ...lent[1], fits: false }];
    expect(lentChoice(small, 'translate', zhJa)).toBe('hy-mt2-1.8b');
    // None fits: the best still, for the check to say so.
    expect(lentChoice(small.map((m) => ({ ...m, fits: false })), 'translate', zhJa)).toBe('index-translate-2b');
  });

  it('reads from its list whether each fits: the memory it can have and what its engines up hold of their own', async () => {
    const list = { ...LIST, data: [{ id: 'sensevoice-small-q8', holds_mb: 250 }], text: [{ id: 'hy-mt2-1.8b', kind: 'translate', holds_mb: 1210, loaded: false }, { id: 'index-translate-2b', kind: 'translate', holds_mb: 1541, loaded: false }], memory_mb: { total: 3843, available: 1160 } };
    const lentNow = await phoneTextList('192.168.4.28:8792', async () => json(list), never);
    expect(lentNow?.map((m) => m.fits)).toEqual([true, false]);
    // A phone that does not say its memory: nothing is told.
    expect((await phoneTextList('x:1', async () => json(LIST), never))?.some((m) => 'fits' in m)).toBe(false);
  });

  it('keeps the one chosen while the phone lends it', () => {
    expect(lentChoice(lent, 'translate', zhJa, 'hy-mt2-1.8b')).toBe('hy-mt2-1.8b');
    expect(lentChoice(lent, 'translate', zhJa, 'hy-mt1.5-1.8b')).toBe('index-translate-2b');
  });

  it('takes one that translates the pair before one that does not, and the phone\'s own where it knows none of them', () => {
    // Hunyuan MT does not translate Swahili.
    expect(lentChoice([lent[0], { id: 'later-mt', kind: 'translate', name: 'Later', loaded: false }], 'translate', { source: 'sw', target: 'ja' })).toBe('later-mt');
    expect(lentChoice([lent[0]], 'translate', { source: 'sw', target: 'ja' })).toBe('hy-mt2-1.8b');
    expect(lentChoice([lent[0]], 'coach', zhJa)).toBe('');
  });
});
