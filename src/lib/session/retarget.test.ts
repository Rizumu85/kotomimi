/**
 * Fork: a running session goes on in a new language pair (`Runner.retarget`, `Run.retarget`): each leg is given a
 * session for it beside the one it has, swapped in once that has started, and the run is restarted only where that
 * cannot be done.
 */
import { describe, it, expect, vi } from 'vitest';
import type { AdapterEvents, AdapterSession, StartRequest } from '../contract/adapter';
import type { AnyProvider, Readiness } from '../provider/types';
import { createVirtualClock } from '../contract/clock';
import { fakeProvider } from '../../providers/fake/provider';
import { createFakeSource, type FakeSource } from '../../providers/fake/source';
import { FAKE_DEFAULTS } from '../../providers/fake/settings';
import { createRunner } from './runner';
import type { RunShape } from './types';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

interface Started { request: StartRequest<unknown, unknown>; events: AdapterEvents; audio: number; stopped: number; turns: string[] }

/**
 * The fake's definition, with sessions the test drives by hand; `startFails(n)` makes the n-th start (1-based) throw,
 * and `beforeStart(n, fn)` runs `fn` on the n-th session before its start resolves (and waits for it).
 */
function manualProvider(follows = false) {
  const started: Started[] = [];
  const failing = new Set<number>();
  const before = new Map<number, (one: Started) => Promise<void> | void>();
  let calls = 0;
  const provider = {
    ...fakeProvider,
    languages: { ...fakeProvider.languages, ...(follows ? { follows: () => true } : {}) },
    start: async (request: StartRequest<unknown, unknown>, events: AdapterEvents): Promise<AdapterSession> => {
      calls++;
      if (failing.has(calls)) throw new Error('no session for that');
      const one: Started = { request, events, audio: 0, stopped: 0, turns: [] };
      started.push(one);
      await before.get(calls)?.(one);
      return {
        info: { transport: 'manual' },
        appendAudio: () => { one.audio++; },
        appendText: () => {},
        beginTurn: () => { one.turns.push('begin'); },
        endTurn: () => { one.turns.push('end'); },
        cancelTurn: () => { one.turns.push('cancel'); },
        stop: async () => { one.stopped++; },
      };
    },
  } as unknown as AnyProvider;
  return { provider, started, startFails: (n: number) => failing.add(n), beforeStart: (n: number, fn: (one: Started) => Promise<void> | void) => before.set(n, fn) };
}

function setup(o: { legs?: RunShape['legs']; ensureReady?: () => Promise<Readiness>; follows?: boolean } = {}) {
  const clock = createVirtualClock(0);
  const sources: FakeSource[] = [];
  const manual = manualProvider(o.follows);
  const tracked: Array<[string, unknown]> = [];
  const shape: RunShape = {
    provider: manual.provider,
    settings: { ...FAKE_DEFAULTS },
    credentials: { apiKey: '' },
    pair: { source: 'en', target: 'ja' },
    legs: o.legs ?? ['speaker'],
    turnMode: 'auto',
    textOnly: false,
    participantSpeech: false,
    keepReplayAudio: true,
    shared: {
      pauses: { sourceSeconds: 1, translationSeconds: 1 },
      reversed: () => false,
      segmentation: { mode: 'off', sentencesPerRow: 0 },
    },
    auth: { signedIn: false, getToken: async () => null },
  };
  const frames: Array<{ leg: string; type: string; payload: unknown }> = [];
  const runner = createRunner({
    clock,
    platform: 'electron',
    // A shape read fresh each time, as the stores' is: a pair set below is the next read's.
    readShape: () => ({ ...shape }),
    ensureReady: o.ensureReady ?? (async () => ({ state: 'ready', models: [] })),
    persistIfUnchanged: vi.fn(),
    openSource: async () => {
      const source = createFakeSource(clock);
      sources.push(source);
      return source;
    },
    playback: { audio: vi.fn(), held: vi.fn(), clear: vi.fn(), live: vi.fn() },
    analytics: { track: (event, properties) => { tracked.push([event, properties]); } },
    frames: { frame: (leg, frame) => frames.push({ leg, type: frame.type, payload: frame.payload }) },
    newSessionId: () => 'run',
    timeoutMs: 1000,
  });
  const events = (name: string) => tracked.filter(([e]) => e === name).map(([, p]) => p);
  return { clock, runner, sources, shape, frames, events, ...manual };
}

describe('retarget — a running session goes on in a new pair', () => {
  it('swaps a session for the new pair in, on the same sound, and keeps the conversation', async () => {
    const { runner, started, shape, clock, sources, frames } = setup();
    await runner.start();
    const since = runner.state.getState();
    started[0].events.segmentOpened({ ref: 1, side: 'source', origin: 'item_1' });
    started[0].events.segmentText({ ref: 1, text: 'Hello' });

    shape.pair = { source: 'en', target: 'ko' };
    await runner.retarget();

    expect(started).toHaveLength(2);
    expect(started[1].request.context.direction).toEqual({ source: 'en', target: 'ko' });
    expect(started[0].stopped).toBe(1);
    expect(sources).toHaveLength(1);
    expect(runner.state.getState()).toEqual(since);
    const [leg] = runner.conversation.snapshot();
    expect(leg.languages).toEqual({ source: 'en', target: 'ko' });
    // What the one before left open is closed with it.
    expect(leg.segments[0]).toMatchObject({ text: 'Hello', final: true });
    // It goes on reading as what it was said in.
    expect(leg.segments[0].language).toBe('en');
    expect(frames).toContainEqual({ leg: 'speaker', type: 'session.languages', payload: { source: 'en', target: 'ko' } });

    // The sound goes to the new session.
    const before = started[1].audio;
    clock.advance(500);
    expect(started[1].audio).toBeGreaterThan(before);
    const old = started[0].audio;
    clock.advance(500);
    expect(started[0].audio).toBe(old);

    // Its refs and origins do not meet the earlier one's; the earlier one's late words are dropped.
    started[1].events.segmentOpened({ ref: 1, side: 'source', origin: 'item_1' });
    started[1].events.segmentText({ ref: 1, text: '안녕' });
    started[0].events.segmentText({ ref: 1, text: 'Hello again' });
    const segments = runner.conversation.snapshot()[0].segments;
    expect(segments.map((s) => s.text)).toEqual(['Hello', '안녕']);
    expect(segments[1].origin).not.toBe(segments[0].origin);
  });

  it('does nothing while the pair is the same, and nothing while idle', async () => {
    const { runner, started, shape } = setup();
    shape.pair = { source: 'en', target: 'ko' };
    await runner.retarget();
    expect(started).toHaveLength(0);
    await runner.start();
    await runner.retarget();
    expect(started).toHaveLength(1);
  });

  it('gives every leg its session for the new pair', async () => {
    const { runner, started, shape } = setup({ legs: ['speaker', 'participant'] });
    await runner.start();
    shape.pair = { source: 'zh', target: 'ja' };
    await runner.retarget();
    expect(started.slice(2).map((s) => s.request.context.direction)).toEqual([{ source: 'zh', target: 'ja' }, { source: 'ja', target: 'zh' }]);
    expect(started.slice(0, 2).map((s) => s.stopped)).toEqual([1, 1]);
    expect(runner.conversation.snapshot().map((l) => l.languages)).toEqual([{ source: 'zh', target: 'ja' }, { source: 'ja', target: 'zh' }]);
  });

  it('does not end the run when the session it replaces ends meanwhile', async () => {
    let ready: (r: Readiness) => void = () => {};
    let calls = 0;
    const { runner, started, shape } = setup({
      ensureReady: () => (++calls === 1 ? Promise.resolve({ state: 'ready', models: [] }) : new Promise<Readiness>((resolve) => { ready = resolve; })),
    });
    await runner.start();
    shape.pair = { source: 'en', target: 'ko' };
    const done = runner.retarget();
    await flush();
    // The engine changing its model under it, say.
    started[0].events.failed({ message: 'the engine went away' });
    ready({ state: 'ready', models: [] });
    await done;
    expect(runner.state.getState().phase).toBe('running');
    expect(started).toHaveLength(2);
    expect(started[1].request.context.direction.target).toBe('ko');
  });

  it('starts again in the new pair where the new session cannot start', async () => {
    const { runner, started, shape, startFails, events } = setup();
    await runner.start();
    startFails(2);
    shape.pair = { source: 'en', target: 'ko' };
    await runner.retarget();
    expect(runner.state.getState().phase).toBe('running');
    expect(started).toHaveLength(2);
    expect(started[0].stopped).toBe(1);
    expect(started[1].request.context.direction.target).toBe('ko');
    expect(events('session_control_clicked')).toEqual([
      { action: 'start', method: 'button' },
      { action: 'stop', method: 'language' },
      { action: 'start', method: 'language' },
    ]);
  });

  it('makes the changes that come meanwhile after it, the last of them only', async () => {
    let ready: (r: Readiness) => void = () => {};
    let calls = 0;
    const { runner, started, shape } = setup({
      ensureReady: () => (++calls === 2 ? new Promise<Readiness>((resolve) => { ready = resolve; }) : Promise.resolve({ state: 'ready', models: [] })),
    });
    await runner.start();
    shape.pair = { source: 'en', target: 'ko' };
    const first = runner.retarget();
    await flush();
    shape.pair = { source: 'en', target: 'fr' };
    void runner.retarget();
    shape.pair = { source: 'en', target: 'de' };
    const last = runner.retarget();
    ready({ state: 'ready', models: [] });
    await first;
    await last;
    expect(started.map((s) => s.request.context.direction.target)).toEqual(['ja', 'ko', 'de']);
    expect(started.slice(0, 2).map((s) => s.stopped)).toEqual([1, 1]);
  });

  it('keeps a held turn open on the session it swaps in', async () => {
    const { runner, started, shape } = setup();
    shape.turnMode = 'push-to-talk';
    await runner.start();
    runner.press();
    shape.pair = { source: 'en', target: 'ko' };
    await runner.retarget();
    expect(started[1].turns).toEqual(['begin']);
  });
});

describe('retarget — the edges', () => {
  it('waits for a run still starting, and has it go on in the change once it runs', async () => {
    let ready: (r: Readiness) => void = () => {};
    let calls = 0;
    const { runner, started, shape } = setup({
      ensureReady: () => (++calls === 1 ? new Promise<Readiness>((resolve) => { ready = resolve; }) : Promise.resolve({ state: 'ready', models: [] })),
    });
    const starting = runner.start();
    await flush();
    expect(runner.state.getState().phase).toBe('starting');
    shape.pair = { source: 'en', target: 'ko' };
    const done = runner.retarget();
    ready({ state: 'ready', models: [] });
    await starting;
    await done;
    expect(started.map((s) => s.request.context.direction.target)).toEqual(['ja', 'ko']);
  });

  it('ends the run when the session swapped in fails afterwards', async () => {
    const { runner, started, shape } = setup();
    await runner.start();
    shape.pair = { source: 'en', target: 'ko' };
    await runner.retarget();
    started[1].events.failed({ message: 'gone' });
    await flush();
    await flush();
    expect(runner.state.getState().phase).toBe('idle');
  });

  it('keeps what the new session said while it started, under its own refs', async () => {
    const { runner, started, shape, beforeStart } = setup();
    beforeStart(2, (one) => {
      one.events.segmentOpened({ ref: 1, side: 'source', origin: 'early' });
      one.events.segmentText({ ref: 1, text: 'early words' });
    });
    await runner.start();
    started[0].events.segmentOpened({ ref: 1, side: 'source', origin: 'early' });
    started[0].events.segmentText({ ref: 1, text: 'old words' });
    shape.pair = { source: 'en', target: 'ko' };
    await runner.retarget();
    expect(runner.conversation.snapshot()[0].segments.map((s) => s.text)).toEqual(['old words', 'early words']);
  });

  it('lets a run stop while a new session is still starting, and stops that session when it does start', async () => {
    let release: () => void = () => {};
    const { runner, started, shape, beforeStart, clock } = setup();
    beforeStart(2, () => new Promise<void>((resolve) => { release = resolve; }));
    await runner.start();
    shape.pair = { source: 'en', target: 'ko' };
    const done = runner.retarget();
    await flush();
    // A stop waits for what is opening, up to its bound.
    const stopping = runner.stop();
    await flush();
    clock.advance(5000);
    await stopping;
    await done;
    expect(runner.state.getState().phase).toBe('idle');
    release();
    await flush();
    await flush();
    expect(started[1].stopped).toBe(1);
    // The next run's own changes are not held up by the last run's.
    await runner.start();
    shape.pair = { source: 'en', target: 'zh' };
    await runner.retarget();
    expect(started[started.length - 1].request.context.direction.target).toBe('zh');
  });

  it('has a side lane follow the leg into the new pair', async () => {
    const { runner, started, shape } = setup();
    await runner.start();
    let deliver: (pcm: Int16Array) => void = () => {};
    const handle = await runner.openSide('speaker', { prefix: 'video:', feed: (d) => { deliver = d; return () => {}; } });
    expect(handle).not.toBeNull();
    expect(started).toHaveLength(2);
    shape.pair = { source: 'en', target: 'ko' };
    await runner.retarget();
    await flush();
    expect(started).toHaveLength(4);
    const lane = started[3];
    expect(lane.request.context.direction.target).toBe('ko');
    expect(started[1].stopped).toBe(1);
    deliver(new Int16Array(160));
    expect(lane.audio).toBe(1);
    expect(started[1].audio).toBe(0);
    // The old lane's late words are dropped; the new one's carry the lane's origins.
    started[1].events.segmentOpened({ ref: 1, side: 'source', origin: 'x' });
    lane.events.segmentOpened({ ref: 1, side: 'source', origin: 'x' });
    const origins = runner.conversation.snapshot()[0].segments.map((s) => s.origin);
    expect(origins).toEqual([`${handle!.origin}x`]);
  });
});

describe('follow — the user is answered in the language the other side speaks', () => {
  const said = (one: Started, ref: number, text: string, language: string) => {
    one.events.segmentOpened({ ref, side: 'source', origin: `o${ref}` });
    one.events.segmentText({ ref, text, language });
    one.events.segmentClosed({ ref });
  };

  it('swaps only the speaker leg into the other side\'s language once two sentences say it', async () => {
    const { runner, started } = setup({ legs: ['speaker', 'participant'], follows: true });
    await runner.start();
    const [speaker, participant] = started;
    said(participant, 1, '你好，今天天气很好', 'zh');
    await flush();
    expect(started).toHaveLength(2);
    said(participant, 2, '我们一起去那边看看吧', 'zh');
    await flush();
    await flush();
    expect(started).toHaveLength(3);
    expect(started[2].request.context.direction).toEqual({ source: 'en', target: 'zh' });
    expect(speaker.stopped).toBe(1);
    expect(participant.stopped).toBe(0);
    expect(runner.state.getState()).toMatchObject({ phase: 'running', followed: 'zh' });
    expect(runner.conversation.snapshot()[0].languages).toEqual({ source: 'en', target: 'zh' });
  });

  it('waits for what the user is saying to finish before it swaps', async () => {
    const { runner, started } = setup({ legs: ['speaker', 'participant'], follows: true });
    await runner.start();
    const [speaker, participant] = started;
    speaker.events.segmentOpened({ ref: 1, side: 'source', origin: 'mine' });
    speaker.events.segmentText({ ref: 1, text: 'I was saying' });
    said(participant, 1, '你好，今天天气很好', 'zh');
    said(participant, 2, '我们一起去那边看看吧', 'zh');
    await flush();
    await flush();
    expect(speaker.stopped).toBe(0);
    speaker.events.segmentClosed({ ref: 1 });
    await flush();
    expect(speaker.stopped).toBe(1);
    expect(runner.conversation.snapshot()[0].segments[0]).toMatchObject({ text: 'I was saying', final: true });
  });

  it('follows back, and counts afresh from a pair the user picks', async () => {
    const { runner, started, shape } = setup({ legs: ['speaker', 'participant'], follows: true });
    await runner.start();
    const participant = started[1];
    said(participant, 1, '你好，今天天气很好', 'zh');
    said(participant, 2, '我们一起去那边看看吧', 'zh');
    await flush();
    await flush();
    said(participant, 3, 'こんにちは、元気ですか', 'ja');
    said(participant, 4, '今日はいい天気ですね', 'ja');
    await flush();
    await flush();
    expect(started[started.length - 1].request.context.direction.target).toBe('ja');
    expect(runner.state.getState()).not.toHaveProperty('followed');
    shape.pair = { source: 'en', target: 'zh' };
    await runner.retarget();
    expect(runner.state.getState()).not.toHaveProperty('followed');
  });

  it('does not follow where the provider does not', async () => {
    const { runner, started } = setup({ legs: ['speaker', 'participant'] });
    await runner.start();
    said(started[1], 1, '你好，今天天气很好', 'zh');
    said(started[1], 2, '我们一起去那边看看吧', 'zh');
    await flush();
    await flush();
    expect(started).toHaveLength(2);
  });
});
