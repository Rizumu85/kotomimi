import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entry } from '../lib/projection/types';
import { useVRChatStore, vrchatHolds } from '../stores/vrchatStore';
import { finishedLine, linkOf, startVRChat, type VRChatDeps } from './vrchat';

vi.mock('../services/persistSetting', () => ({ persistSetting: async () => {} }));

const last = <T>(list: readonly T[]): T | undefined => list[list.length - 1];

const row = (text: string, final = true) => ({ key: `${text}:0`, segmentId: text, side: 'source' as const, start: 0, end: text.length, text, final });
const exchange = (id: string, source: string, translation: string, { leg = 'speaker', final = true } = {}): Entry => ({
  kind: 'exchange', id, leg: leg as 'speaker' | 'participant', languages: { source: 'zh', target: 'ja' }, pairing: 'stated',
  source: [row(source, final)], translation: translation ? [{ ...row(translation, final), side: 'translation' }] : [], t: 0,
});

function setup(over: Partial<VRChatDeps> = {}, initial: Entry[] = []) {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const invoked: Array<[string, unknown]> = [];
  const ipc = {
    invoke: async (channel: string, data?: unknown) => { invoked.push([channel, data]); return channel === 'vrchat:watch' ? { found: true, connected: true, muted: false } : undefined; },
    receive: (channel: string, fn: (...args: unknown[]) => void) => { handlers.set(channel, fn); },
  };
  let phase = 'idle';
  const runListeners = new Set<() => void>();
  const paces: Array<[string, string]> = [];
  const runner = {
    setLegPace: (leg: string, pace: string) => { paces.push([leg, pace]); },
    state: { getState: () => ({ phase }), subscribe: (l: () => void) => { runListeners.add(l); return () => runListeners.delete(l); } },
  };
  let entries: Entry[] = initial;
  let legs: Array<{ segments: Array<{ id: string; origin?: string }> }> = [];
  const viewListeners = new Set<() => void>();
  const view = { get: () => ({ entries, legs }), subscribe: (l: () => void) => { viewListeners.add(l); return () => viewListeners.delete(l); } };
  const timers: Array<() => void> = [];
  const controller = startVRChat({
    ipc, runner: runner as VRChatDeps['runner'], view, legs: () => ['speaker', 'participant'], canAsk: () => true, coached: () => false,
    store: useVRChatStore, setTimeout: (fn) => { timers.push(fn); }, ...over,
  });
  return {
    controller, invoked, paces, handlers, timers,
    run(next: string) { phase = next; for (const l of runListeners) l(); },
    show(next: Entry[], nextLegs: typeof legs = []) { entries = next; legs = nextLegs; for (const l of viewListeners) l(); },
    chatboxLines: () => invoked.filter(([channel]) => channel === 'vrchat:chatbox').map(([, data]) => (data as { text: string }).text),
  };
}

beforeEach(() => {
  useVRChatStore.setState({ muteGate: true, chatbox: 'off', onVideo: 'ask', link: { found: false, connected: false, muted: null }, video: { kind: 'none' }, viewers: 0 });
});

describe('linkOf', () => {
  it('holds what the main process says to its shape', () => {
    expect(linkOf({ found: true, connected: true, muted: true })).toEqual({ found: true, connected: true, muted: true });
    expect(linkOf(null)).toEqual({ found: false, connected: false, muted: null });
    expect(linkOf({ muted: 'yes' })).toEqual({ found: false, connected: false, muted: null });
  });
});

describe('vrchatHolds', () => {
  it('holds the user only while the gate is on, VRChat answers and it says muted', () => {
    expect(vrchatHolds({ muteGate: true, link: { found: true, connected: true, muted: true } })).toBe(true);
    expect(vrchatHolds({ muteGate: false, link: { found: true, connected: true, muted: true } })).toBe(false);
    expect(vrchatHolds({ muteGate: true, link: { found: true, connected: false, muted: true } })).toBe(false);
    expect(vrchatHolds({ muteGate: true, link: { found: true, connected: true, muted: null } })).toBe(false);
  });
});

describe('finishedLine', () => {
  it('is the translation of a final sentence of the user\'s, or the original with it', () => {
    expect(finishedLine(exchange('a', '今天天气真好', '今日はいい天気ですね'), 'translation')).toBe('今日はいい天気ですね');
    expect(finishedLine(exchange('a', '今天天气真好', '今日はいい天気ですね'), 'both')).toBe('今天天气真好\n今日はいい天気ですね');
  });

  it('is nothing while off, unfinished, untranslated, or the other side\'s', () => {
    expect(finishedLine(exchange('a', '你好', 'こんにちは'), 'off')).toBeNull();
    expect(finishedLine(exchange('a', '你好', 'こんにちは', { final: false }), 'translation')).toBeNull();
    expect(finishedLine(exchange('a', '你好', ''), 'translation')).toBeNull();
    expect(finishedLine(exchange('a', 'こんにちは', '你好', { leg: 'participant' }), 'translation')).toBeNull();
  });
});

describe('a video', () => {
  it('asks while a run hears the other side, and the answer sets the pace', () => {
    const t = setup();
    t.run('running');
    t.handlers.get('vrchat:video')!({ url: 'x' });
    expect(useVRChatStore.getState().video).toEqual({ kind: 'asking' });
    t.controller.answer('quick', false);
    expect(last(t.paces)).toEqual(['participant', 'quick']);
    expect(useVRChatStore.getState().video).toEqual({ kind: 'on', pace: 'quick', auto: false });
    t.controller.endVideo();
    expect(last(t.paces)).toEqual(['participant', 'normal']);
    expect(useVRChatStore.getState().video).toEqual({ kind: 'none' });
  });

  it('is not asked about where the user cannot answer: shorter stretches are chosen for them', () => {
    const t = setup({ canAsk: () => false });
    t.run('running');
    t.handlers.get('vrchat:video')!({ url: 'x' });
    expect(useVRChatStore.getState().video).toEqual({ kind: 'on', pace: 'quick', auto: true });
  });

  it('follows the setting, remembers an answer, and ends with another world or the run', () => {
    const t = setup();
    t.run('running');
    useVRChatStore.setState({ onVideo: 'pause' });
    t.handlers.get('vrchat:video')!({ url: 'x' });
    expect(last(t.paces)).toEqual(['participant', 'paused']);
    t.handlers.get('vrchat:world')!({});
    expect(useVRChatStore.getState().video.kind).toBe('none');
    useVRChatStore.setState({ onVideo: 'ask' });
    t.handlers.get('vrchat:video')!({ url: 'y' });
    t.controller.answer('quick', true);
    expect(useVRChatStore.getState().onVideo).toBe('quick');
    t.run('idle');
    expect(useVRChatStore.getState().video.kind).toBe('none');
    expect(last(t.paces)).toEqual(['participant', 'normal']);
  });

  it('is nothing outside a run, or with the setting at "as usual"', () => {
    const t = setup();
    t.handlers.get('vrchat:video')!({ url: 'x' });
    expect(useVRChatStore.getState().video.kind).toBe('none');
    t.run('running');
    useVRChatStore.setState({ onVideo: 'normal' });
    t.handlers.get('vrchat:video')!({ url: 'x' });
    expect(useVRChatStore.getState().video.kind).toBe('none');
    expect(t.paces).toEqual([]);
  });
});

describe('the chatbox', () => {
  it('sends each finished sentence of the user\'s once, a gap apart, and nothing that was on screen before', () => {
    useVRChatStore.setState({ chatbox: 'translation' });
    const t = setup({}, [exchange('old', '旧的', '古い')]);
    expect(t.chatboxLines()).toEqual([]);
    t.show([exchange('old', '旧的', '古い'), exchange('a', '你好', 'こんにちは'), exchange('b', '谢谢', 'ありがとう')]);
    expect(t.chatboxLines()).toEqual(['こんにちは']);
    t.timers.shift()!();
    expect(t.chatboxLines()).toEqual(['こんにちは', 'ありがとう']);
    t.show([exchange('a', '你好', 'こんにちは'), exchange('b', '谢谢', 'ありがとう')]);
    t.timers.shift()?.();
    expect(t.chatboxLines()).toEqual(['こんにちは', 'ありがとう']);
  });

  it('sends what the user said while they are coached, never the feedback; typed text is translated as ever', () => {
    useVRChatStore.setState({ chatbox: 'both' });
    const t = setup({ coached: () => true });
    const typed = exchange('t', '谢谢', 'ありがとう');
    t.show([exchange('a', '今日は行きます', '✓ 正确')], [{ segments: [{ id: '谢谢', origin: 'sokuji_typed_1' }, { id: '今日は行きます', origin: 'u1' }] }]);
    expect(t.chatboxLines()).toEqual(['今日は行きます']);
    t.show([exchange('a', '今日は行きます', '✓ 正确'), typed], [{ segments: [{ id: '谢谢', origin: 'sokuji_typed_1' }, { id: '今日は行きます', origin: 'u1' }] }]);
    t.timers.shift()!();
    expect(t.chatboxLines()).toEqual(['今日は行きます', '谢谢\nありがとう']);
  });

  it('sends a coached sentence once it is final, without waiting for its feedback', () => {
    useVRChatStore.setState({ chatbox: 'translation' });
    const t = setup({ coached: () => true });
    t.show([exchange('a', '今日は行きます', '')]);
    expect(t.chatboxLines()).toEqual(['今日は行きます']);
  });
});

describe('the mute', () => {
  it('is asked while a run hears the user with the gate on, or while the card is open', async () => {
    const t = setup();
    t.run('running');
    expect(last(t.invoked.filter(([c]) => c === 'vrchat:watch'))).toEqual(['vrchat:watch', { on: true }]);
    useVRChatStore.getState().setLink({ found: true, connected: true, muted: true });
    useVRChatStore.getState().setMuteGate(false);
    expect(last(t.invoked.filter(([c]) => c === 'vrchat:watch'))).toEqual(['vrchat:watch', { on: false }]);
    // No longer asked: the last answer is forgotten.
    expect(useVRChatStore.getState().link.muted).toBeNull();
    useVRChatStore.getState().view(true);
    expect(last(t.invoked.filter(([c]) => c === 'vrchat:watch'))).toEqual(['vrchat:watch', { on: true }]);
  });
});

describe('the controller, at the edges the review found', () => {
  it('does not send a waiting line once the chatbox is turned off', () => {
    useVRChatStore.setState({ chatbox: 'translation' });
    const t = setup();
    t.show([exchange('a', '你好', 'こんにちは'), exchange('b', '谢谢', 'ありがとう')]);
    expect(t.chatboxLines()).toEqual(['こんにちは']);
    useVRChatStore.setState({ chatbox: 'off' });
    t.timers.shift()!();
    expect(t.chatboxLines()).toEqual(['こんにちは']);
  });

  it('sends a sentence still under way when it began, once it is finished', () => {
    useVRChatStore.setState({ chatbox: 'translation' });
    const t = setup({}, [exchange('a', '你好', 'こんにち', { final: false })]);
    t.show([exchange('a', '你好', 'こんにちは')]);
    expect(t.chatboxLines()).toEqual(['こんにちは']);
  });

  it('says at once whether the mute is wanted, ending what a page before it asked for', () => {
    const t = setup();
    expect(t.invoked.filter(([c]) => c === 'vrchat:watch')).toEqual([['vrchat:watch', { on: false }]]);
  });

  it('puts the pace back when it is stopped, and does nothing after', () => {
    const t = setup();
    t.run('running');
    useVRChatStore.setState({ onVideo: 'pause' });
    t.handlers.get('vrchat:video')!({ url: 'x' });
    expect(last(t.paces)).toEqual(['participant', 'paused']);
    t.controller.stop();
    expect(last(t.paces)).toEqual(['participant', 'normal']);
    t.handlers.get('vrchat:video')!({ url: 'y' });
    expect(useVRChatStore.getState().video.kind).toBe('none');
  });
});
