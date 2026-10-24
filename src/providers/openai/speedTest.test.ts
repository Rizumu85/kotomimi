import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SAMPLE_RATE, type AdapterEvents, type AdapterSession } from '../../lib/contract/adapter';
import { realClock } from '../../lib/contract/clock';
import { measure, SpeedTestError, timeLeg } from './speedTest';

/** A session that writes its sentence a second after it has heard the speech, and answers it `answerMs` later. */
function fakeSession(events: AdapterEvents, speechEndMs: number, answerMs: number, stops: { count: number }): AdapterSession {
  let heardMs = 0;
  let wrote = false;
  return {
    info: { transport: 'websocket' },
    appendAudio(pcm: Int16Array) {
      // Its sentence opens with the first speech heard, as a recognizer's does.
      if (heardMs === 0) events.segmentOpened({ ref: 1, side: 'source', origin: 'piece_1' });
      heardMs += (pcm.length * 1000) / SAMPLE_RATE;
      if (wrote || heardMs < speechEndMs + 1000) return;
      wrote = true;
      events.segmentText({ ref: 1, text: '元は金持ちの息子でした' });
      events.segmentClosed({ ref: 1 });
      setTimeout(() => {
        events.segmentOpened({ ref: 2, side: 'translation', origin: 'piece_1' });
        events.segmentText({ ref: 2, text: 'He was once a rich man\'s son' });
        events.segmentClosed({ ref: 2 });
      }, answerMs);
    },
    appendText() {},
    beginTurn() {},
    endTurn() {},
    cancelTurn() {},
    async stop() { stops.count += 1; },
  } as unknown as AdapterSession;
}

describe('timeLeg', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  afterEach(() => { vi.useRealTimers(); });

  it('times the text from the end of the speech, and the answer from its sentence', async () => {
    const stops = { count: 0 };
    const clip = { pcm: new Int16Array(SAMPLE_RATE * 2), speechEndMs: 1800 };
    const timing = timeLeg('participant', 'translate', async (events) => fakeSession(events, 1800, 700, stops), clip, { clock: realClock, signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await timing;
    expect(result.sentences).toBe(1);
    // Written once a second of the speech's end had been heard, to the nearest piece.
    expect(result.hearMs).toBeGreaterThanOrEqual(1000);
    expect(result.hearMs).toBeLessThanOrEqual(1100);
    expect(result.answerMs).toEqual([700]);
    expect(result.totalMs).toBe(result.hearMs! + 700);
    expect(stops.count).toBe(1);
  });

  it('gives up when nothing is written, and stops the session', async () => {
    const stops = { count: 0 };
    const silent = { appendAudio() {}, appendText() {}, beginTurn() {}, endTurn() {}, cancelTurn() {}, async stop() { stops.count += 1; }, info: { transport: 'websocket' } } as unknown as AdapterSession;
    const timing = timeLeg('speaker', 'coach', async () => silent, { pcm: new Int16Array(SAMPLE_RATE), speechEndMs: 900 }, { clock: realClock, signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(40_000);
    const result = await timing;
    expect(result).toMatchObject({ hearMs: null, totalMs: null, sentences: 0, answerMs: [] });
    expect(stops.count).toBe(1);
  });

  it('says why a session failed', async () => {
    const stops = { count: 0 };
    const timing = timeLeg('speaker', 'translate', async (events) => {
      setTimeout(() => events.failed({ message: 'the device went away' }), 300);
      return fakeSession(events, 5000, 0, stops);
    }, { pcm: new Int16Array(SAMPLE_RATE), speechEndMs: 900 }, { clock: realClock, signal: new AbortController().signal });
    const caught = timing.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2000);
    const error = await caught;
    expect(error).toBeInstanceOf(SpeedTestError);
    expect((error as Error).message).toBe('the device went away');
    expect(stops.count).toBe(1);
  });
});

describe('measure', () => {
  it('pairs an answer with its own sentence by origin, else with the sentence before it', () => {
    const result = measure('participant', 'translate', [
      { side: 'source', origin: 'a', text: 'one', openedAt: 0, closedAt: 3000 },
      { side: 'source', origin: 'b', text: 'two', openedAt: 3000, closedAt: 6000 },
      { side: 'translation', origin: 'a', text: 'eins', openedAt: 3100, closedAt: 3900 },
      { side: 'translation', text: 'zwei', openedAt: 6100, closedAt: 7500 },
    ], 5000, 5000);
    expect(result).toMatchObject({ hearMs: 1000, answerMs: [900, 1500], sentences: 2, totalMs: 2500 });
  });

  it('leaves out an empty sentence, and leaves the whole way open while one is unanswered', () => {
    const result = measure('participant', 'translate', [
      { side: 'source', text: '', openedAt: 0, closedAt: 100 },
      { side: 'source', text: 'one', openedAt: 0, closedAt: 3000 },
      { side: 'source', text: 'two', openedAt: 3000, closedAt: 4000 },
      { side: 'translation', text: 'eins', openedAt: 3100, closedAt: 3600 },
    ], 3500, 3500);
    expect(result).toMatchObject({ sentences: 2, hearMs: 500, totalMs: null });
  });
});

describe('measure, of what the silence after the speech brings', () => {
  it('leaves out a sentence begun after the speech ended, and its answer', () => {
    const result = measure('participant', 'translate', [
      { side: 'source', origin: 'u1', text: '元は金持ちの息子でした。', openedAt: 1000, closedAt: 8600 },
      { side: 'translation', origin: 'u1', text: '他原本是富家子弟。', openedAt: 8700, closedAt: 8800 },
      { side: 'source', origin: 'u2', text: 'はい。', openedAt: 9000, closedAt: 9700 },
      { side: 'translation', origin: 'u2', text: '是的。', openedAt: 9750, closedAt: 9800 },
    ], 8000, 7000);
    expect(result).toMatchObject({ sentences: 1, hearMs: 600, answerMs: [200], totalMs: 800 });
  });
});

describe('measure, of a recognizer that writes a sentence only once it is whole', () => {
  it('times the sentence it begins after the speech ended, and still leaves out a later one', () => {
    const result = measure('participant', 'translate', [
      { side: 'source', origin: 'u1', text: 'The Tibetan Buddhism is based on the teachings of Buddha.', openedAt: 9400, closedAt: 9400 },
      { side: 'translation', origin: 'u1', text: '藏传佛教以佛陀的教导为基础。', openedAt: 9450, closedAt: 9900 },
      { side: 'source', origin: 'u2', text: 'Thank you.', openedAt: 11000, closedAt: 11000 },
    ], 8000, 8000);
    expect(result).toMatchObject({ sentences: 1, hearMs: 1400, answerMs: [500], totalMs: 1900 });
  });

  it('keeps the rest of a stretch that opens as its first sentence closes, after the speech ended', () => {
    const result = measure('participant', 'translate', [
      { side: 'source', origin: 'p1', text: '元は金持ちの息子でした。', openedAt: 500, closedAt: 8300 },
      { side: 'source', origin: 'p2', text: '今は財産を使い尽くして。', openedAt: 8300, closedAt: 8900 },
      { side: 'translation', origin: 'p1', text: '他原本是富家子弟。', openedAt: 8350, closedAt: 8500 },
      { side: 'translation', origin: 'p2', text: '如今家财散尽。', openedAt: 8950, closedAt: 9100 },
    ], 8000, 7500);
    expect(result).toMatchObject({ sentences: 2, hearMs: 900, answerMs: [200, 200], totalMs: 1100 });
  });
});
