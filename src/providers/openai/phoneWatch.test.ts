import { describe, expect, it } from 'vitest';
import { createVirtualClock } from '../../lib/contract/clock';
import { PHONE_WATCH_EVERY_MS, PHONE_WATCH_WAIT_MS, watchPhones } from './phoneWatch';

/** A phone that answers at once while `awake`, and while not, never: a frozen app takes the connection and says nothing. */
function phone() {
  const state = { awake: true, asked: [] as string[] };
  const doFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    state.asked.push(String(input));
    if (state.awake) return Promise.resolve(new Response('{"data":[]}'));
    return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
  }) as typeof fetch;
  return { state, doFetch };
}

/** Lets the watch's promises settle between the clock's steps. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
async function pass(clock: ReturnType<typeof createVirtualClock>, ms: number) {
  for (let t = 0; t < ms; t += 500) {
    clock.advance(500);
    await settle();
  }
}

describe('watchPhones', () => {
  it('says once that a phone stopped answering, after two unanswered asks, and again only after it came back', async () => {
    const clock = createVirtualClock();
    const { state, doFetch } = phone();
    const quiet: string[] = [];
    const watch = watchPhones({ fetch: doFetch, clock, onQuiet: (base) => quiet.push(base) });
    watch.add('http://192.168.1.23:8792/v1/');
    await pass(clock, PHONE_WATCH_EVERY_MS * 3);
    expect(state.asked[0]).toBe('http://192.168.1.23:8792/v1/models');
    expect(quiet).toEqual([]);

    state.awake = false;
    await pass(clock, PHONE_WATCH_EVERY_MS + PHONE_WATCH_WAIT_MS);
    expect(quiet).toEqual([]);
    await pass(clock, PHONE_WATCH_EVERY_MS + PHONE_WATCH_WAIT_MS);
    expect(quiet).toEqual(['http://192.168.1.23:8792/v1']);
    await pass(clock, (PHONE_WATCH_EVERY_MS + PHONE_WATCH_WAIT_MS) * 3);
    expect(quiet).toHaveLength(1);

    state.awake = true;
    await pass(clock, PHONE_WATCH_EVERY_MS * 2);
    state.awake = false;
    await pass(clock, (PHONE_WATCH_EVERY_MS + PHONE_WATCH_WAIT_MS) * 2);
    expect(quiet).toHaveLength(2);
    watch.stop();
  });

  it('asks each phone once however often it is added, and nothing after it stops', async () => {
    const clock = createVirtualClock();
    const { state, doFetch } = phone();
    const watch = watchPhones({ fetch: doFetch, clock, onQuiet: () => {} });
    watch.add('http://10.0.0.5:8792/v1');
    watch.add('http://10.0.0.5:8792/v1/');
    await pass(clock, PHONE_WATCH_EVERY_MS);
    expect(state.asked).toHaveLength(1);
    watch.stop();
    watch.add('http://10.0.0.6:8792/v1');
    await pass(clock, PHONE_WATCH_EVERY_MS * 3);
    expect(state.asked).toHaveLength(1);
  });
});
