import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entry } from '../lib/projection/types';
import { useVRChatStore, vrchatHolds } from '../stores/vrchatStore';
import { chatboxPages, chatboxReadingMs, chatboxWaiting, finishedLine, linkOf, startVRChat, type VRChatDeps } from './vrchat';

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
  useVRChatStore.setState({ muteGate: true, chatbox: 'off', chatboxTranslationFirst: false, recent: null, onVideo: 'ask', link: { found: false, connected: false, muted: null }, video: { kind: 'none' }, viewers: 0 });
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
  it('shows the reverse translation when enabled, or the original with it where both show', () => {
    const inJapanese = (translation: string): Entry => {
      const e = exchange('a', '次のワールドに行こう', translation);
      return e.kind === 'exchange' ? { ...e, source: e.source.map((r) => ({ ...r, language: 'ja' })) } : e;
    };
    const back = { languages: ['ja'], back: true };
    expect(finishedLine(inJapanese('我们去下一个世界吧'), 'translation', false, false, back)).toBe('我们去下一个世界吧');
    expect(finishedLine(inJapanese('我们去下一个世界吧'), 'both', false, false, back)).toBe('次のワールドに行こう\n我们去下一个世界吧');
    // Not answered back: shown as said, with no translation to wait for.
    expect(finishedLine(inJapanese(''), 'both', false, false, { languages: ['ja'], back: false })).toBe('次のワールドに行こう');
    // Their own language: the translation, as ever.
    const inChinese = exchange('b', '今天天气真好', '今日はいい天気ですね');
    expect(finishedLine(inChinese.kind === 'exchange' ? { ...inChinese, source: inChinese.source.map((r) => ({ ...r, language: 'zh' })) } : inChinese, 'translation', false, false, back)).toBe('今日はいい天気ですね');
  });

  it('is the translation of a final sentence of the user\'s, or the original with it', () => {
    expect(finishedLine(exchange('a', '今天天气真好', '今日はいい天気ですね'), 'translation')).toBe('今日はいい天気ですね');
    expect(finishedLine(exchange('a', '今天天气真好', '今日はいい天気ですね'), 'both')).toBe('今天天气真好\n今日はいい天気ですね');
  });

  it('is what was said alone, once final, with no translation waited for, where the original alone shows', () => {
    expect(finishedLine(exchange('a', '今天天气真好', '今日はいい天気ですね'), 'source')).toBe('今天天气真好');
    expect(finishedLine(exchange('a', '今天天气真好', ''), 'source')).toBe('今天天气真好');
    expect(finishedLine(exchange('a', '今天天气', '', { final: false }), 'source')).toBeNull();
    expect(finishedLine(exchange('a', 'こんにちは', '你好', { leg: 'participant' }), 'source')).toBeNull();
  });

  it('puts the translation on top where asked, and keeps both lines whole', () => {
    expect(finishedLine(exchange('a', '今天天气真好', '今日はいい天気ですね'), 'both', false, true)).toBe('今日はいい天気ですね\n今天天气真好');
    const long = '长'.repeat(200);
    expect(finishedLine(exchange('a', long, '短い訳'), 'both')).toBe(`${long}\n短い訳`);
  });

  it('is nothing while off, unfinished, untranslated, or the other side\'s', () => {
    expect(finishedLine(exchange('a', '你好', 'こんにちは'), 'off')).toBeNull();
    expect(finishedLine(exchange('a', '你好', 'こんにちは', { final: false }), 'translation')).toBeNull();
    expect(finishedLine(exchange('a', '你好', ''), 'translation')).toBeNull();
    expect(finishedLine(exchange('a', 'こんにちは', '你好', { leg: 'participant' }), 'translation')).toBeNull();
  });

  // Their main language and one lit beside it: a sentence of the user's has a translation into each.
  const twice = (source: string, first: string, second: string): Entry => {
    const one = exchange('a', source, first);
    return one.kind === 'exchange' ? { ...one, translation: [...one.translation, { ...row(second), side: 'translation' as const, language: 'en' }] } : one;
  };
  const two = { languages: ['ja', 'en'], back: false };

  it('waits for both translations where two of their languages are lit, and puts each on a line of its own', () => {
    expect(finishedLine(exchange('a', '我们走吧', '行こう'), 'translation', false, false, two)).toBeNull();
    expect(finishedLine(exchange('a', '我们走吧', '行こう'), 'translation', false, false, two, true)).toBe('行こう');
    expect(finishedLine(twice('我们走吧', '行こう', "Let's go"), 'translation', false, false, two)).toBe("行こう\nLet's go");
    expect(finishedLine(twice('我们走吧', '行こう', "Let's go"), 'both', false, false, two)).toBe("我们走吧\n行こう\nLet's go");
  });

  it('leaves the original out where it and the two translations do not fit the chatbox together', () => {
    const said = '我们'.repeat(30);
    const line = finishedLine(twice(said, '行こう'.repeat(15), "Let's go ".repeat(5).trim()), 'both', false, false, two);
    expect(line).toBe(`${'行こう'.repeat(15)}\n${"Let's go ".repeat(5).trim()}`);
  });
});

describe('a long line in the chatbox (fork)', () => {
  it('is one page where it fits, two lines together where they fit', () => {
    expect(chatboxPages('短い')).toEqual(['短い']);
    expect(chatboxPages('一\n二')).toEqual(['一\n二']);
  });

  it('goes up in pages that end a sentence where one can, and says a page goes on where it cannot', () => {
    const sentence = `${'長'.repeat(90)}。`;
    const pages = chatboxPages(`${sentence}${'続'.repeat(100)}`);
    expect(pages).toEqual([sentence, '続'.repeat(100)]);
    const words = chatboxPages(Array.from({ length: 40 }, () => 'word').join(' '));
    expect(words.length).toBe(2);
    expect(words[0].endsWith('…')).toBe(true);
    expect(words.every((page) => [...page].length <= 144)).toBe(true);
    expect(words.join(' ').replace('…', '').split(/\s+/).length).toBe(40);
    const solid = chatboxPages('字'.repeat(300));
    expect(solid.every((page) => [...page].length <= 144)).toBe(true);
    expect(solid.join('').replace(/…/g, '')).toBe('字'.repeat(300));
  });

  it('gives two lines that do not fit together pages of their own, in their order', () => {
    const original = `${'长'.repeat(100)}。`;
    const translation = `${'訳'.repeat(80)}。`;
    expect(chatboxPages(`${original}\n${translation}`)).toEqual([original, translation]);
  });

  it('sends every page of a long line, one after another', () => {
    useVRChatStore.setState({ chatbox: 'translation' });
    const t = setup();
    const long = `${'長'.repeat(100)}。${'続'.repeat(60)}`;
    t.show([exchange('a', '长', long)]);
    expect(t.chatboxLines()).toEqual([`${'長'.repeat(100)}。`]);
    t.timers.shift()!();
    expect(t.chatboxLines()).toEqual([`${'長'.repeat(100)}。`, '続'.repeat(60)]);
    t.controller.stop();
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

  it('chooses faster for them when the question stays unanswered — the user in VR — and leaves an answer that came alone (fork)', () => {
    const t = setup();
    t.run('running');
    t.handlers.get('vrchat:video')!({ url: 'x' });
    expect(useVRChatStore.getState().video).toEqual({ kind: 'asking' });
    for (const fire of t.timers.splice(0)) fire();
    expect(useVRChatStore.getState().video).toEqual({ kind: 'on', pace: 'quick', auto: true });
    expect(last(t.paces)).toEqual(['participant', 'quick']);
    // Answered in time: the wait ends with nothing to do.
    t.controller.endVideo();
    t.handlers.get('vrchat:video')!({ url: 'y' });
    t.controller.answer('pause', false);
    for (const fire of t.timers.splice(0)) fire();
    expect(useVRChatStore.getState().video).toMatchObject({ pace: 'paused', auto: false });
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

  it('is nothing outside a run', () => {
    const t = setup();
    t.handlers.get('vrchat:video')!({ url: 'x' });
    expect(useVRChatStore.getState().video.kind).toBe('none');
    expect(t.paces).toEqual([]);
  });
});

describe('the chatbox', () => {
  it('holds visible words for reading while new translations continue to arrive', () => {
    useVRChatStore.setState({ chatbox: 'translation' });
    const waits: Array<{ fn: () => void; ms: number }> = [];
    const t = setup({ setTimeout: (fn, ms) => { waits.push({ fn, ms }); } });
    const long = '这是一个需要留出足够时间让朋友读完的比较长的句子。';
    t.show([exchange('a', 'first', long)]);
    t.show([exchange('a', 'first', long), exchange('b', 'second', 'Next')]);
    expect(t.chatboxLines()).toEqual([long]);
    expect(waits[0].ms).toBe(chatboxReadingMs(long));
    expect(waits[0].ms).toBeGreaterThan(4000);
    expect(t.paces).toEqual([]);
    waits[0].fn();
    expect(t.chatboxLines()).toEqual([long, 'Next']);
    t.controller.stop();
  });

  it('times only visible characters and gives CJK text more time than the same Latin character count', () => {
    expect(chatboxReadingMs('Hi')).toBe(3000);
    expect(chatboxReadingMs('中'.repeat(60))).toBeGreaterThan(chatboxReadingMs('a'.repeat(60)));
    expect(chatboxReadingMs('a'.repeat(1000))).toBe(chatboxReadingMs('a'.repeat(144)));
    expect(chatboxReadingMs('中'.repeat(144))).toBe(6000);
  });

  it('sends the lines that piled up together, and lets the oldest go when they do not fit', () => {
    useVRChatStore.setState({ chatbox: 'translation' });
    const t = setup();
    t.show([exchange('a', '一', 'First')]);
    t.show([exchange('a', '一', 'First'), exchange('b', '二', 'Second'), exchange('c', '三', 'Third')]);
    expect(t.chatboxLines()).toEqual(['First']);
    t.timers.shift()!();
    expect(t.chatboxLines()).toEqual(['First', 'Second\nThird']);
    t.controller.stop();
    expect(chatboxWaiting(['a'.repeat(100), 'b'.repeat(100), 'c'.repeat(30)])).toBe(`${'b'.repeat(100)}\n${'c'.repeat(30)}`);
  });

  it('discards queued messages immediately when disabled, even if re-enabled before the timer fires', () => {
    useVRChatStore.setState({ chatbox: 'translation' });
    const t = setup();
    t.show([exchange('a', 'one', 'First')]);
    t.show([exchange('a', 'one', 'First'), exchange('b', 'two', 'Second')]);
    useVRChatStore.setState({ chatbox: 'off' });
    useVRChatStore.setState({ chatbox: 'translation' });
    t.timers[0]();
    expect(t.chatboxLines()).toEqual(['First']);
    t.controller.stop();
  });
  it('sends each finished sentence of the user\'s once, a gap apart, and nothing that was on screen before', () => {
    useVRChatStore.setState({ chatbox: 'translation' });
    const t = setup({}, [exchange('old', '旧的', '古い')]);
    expect(t.chatboxLines()).toEqual([]);
    t.show([exchange('old', '旧的', '古い'), exchange('a', '你好', 'こんにちは')]);
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

  it('translates a coached speaker switching to their own language without publishing feedback', () => {
    useVRChatStore.setState({ chatbox: 'translation' });
    const t = setup({ coached: () => true, theirs: () => ({ languages: ['fr'], back: false }) });
    const sentence = (id: string, source: string, answer: string, language: string): Entry => {
      const e = exchange(id, source, answer);
      return e.kind === 'exchange' ? { ...e, source: e.source.map((r) => ({ ...r, language })) } : e;
    };
    const own = sentence('own', 'Good morning', 'Bonjour', 'en');
    t.show([own]);
    expect(t.chatboxLines()).toEqual(['Bonjour']);
    t.show([own, sentence('practice', 'Je suis ici', 'Your grammar is correct.', 'fr')]);
    t.timers.shift()?.();
    expect(t.chatboxLines()).toEqual(['Bonjour', 'Je suis ici']);
  });

  it.each(['before', 'after'] as const)('publishes only the translation when combined feedback arrives %s it', (order) => {
    useVRChatStore.setState({ chatbox: 'translation' });
    const t = setup({ coached: () => true, theirs: () => ({ languages: ['fr'], back: true }) });
    const sentence = (translated: boolean, feedback: boolean): Entry => {
      const entry = exchange('both', 'Je suis ici', translated ? 'I am here' : '');
      if (entry.kind !== 'exchange') throw new Error('expected exchange');
      return {
        ...entry,
        source: entry.source.map((r) => ({ ...r, language: 'fr' })),
        translation: entry.translation.map((r) => ({ ...r, purpose: 'translation' })),
        feedback: feedback ? [{ ...row('Private grammar explanation'), side: 'translation', purpose: 'feedback' }] : [],
      };
    };
    t.show([sentence(false, false)]);
    expect(t.chatboxLines()).toEqual([]);
    t.show([sentence(order === 'after', order === 'before')]);
    expect(t.chatboxLines()).toEqual(order === 'after' ? ['I am here'] : []);
    t.show([sentence(true, true)]);
    t.timers.shift()?.();
    expect(t.chatboxLines()).toEqual(['I am here']);
    expect(useVRChatStore.getState().recent).toEqual({ said: 'Je suis ici', translation: 'I am here' });
  });
});

describe('the typing bubble (fork)', () => {
  const typing = (t: ReturnType<typeof setup>) => t.invoked.filter(([channel]) => channel === 'vrchat:typing').map(([, data]) => (data as { on: boolean }).on);

  it('is on from the moment a sentence of the user is heard to the moment it goes up', () => {
    useVRChatStore.setState({ chatbox: 'translation' });
    const t = setup();
    t.run('running');
    t.show([exchange('a', '你好', '', { final: false })]);
    expect(typing(t)).toEqual([true]);
    t.show([exchange('a', '你好吗', '', { final: false })]);
    expect(typing(t)).toEqual([true]);
    t.show([exchange('a', '你好吗', 'お元気ですか')]);
    expect(t.chatboxLines()).toEqual(['お元気ですか']);
    expect(typing(t)).toEqual([true, false]);
  });

  it('is never on with the chatbox off, outside a run, for the other side, or for typed text', () => {
    const heard = (chatbox: 'off' | 'translation', phase: string, entries: Entry[], legs: Array<{ segments: Array<{ id: string; origin?: string }> }> = []) => {
      useVRChatStore.setState({ chatbox });
      const t = setup();
      t.run(phase);
      t.show(entries, legs);
      const on = typing(t).filter(Boolean);
      t.controller.stop();
      return on;
    };
    expect(heard('off', 'running', [exchange('a', '你好', '', { final: false })])).toEqual([]);
    expect(heard('translation', 'idle', [exchange('b', '谢谢', '', { final: false })])).toEqual([]);
    expect(heard('translation', 'running', [exchange('c', 'こんにちは', '', { leg: 'participant', final: false })])).toEqual([]);
    expect(heard('translation', 'running', [exchange('d', '打字', '', { final: false })], [{ segments: [{ id: '打字', origin: 'sokuji_typed_1' }] }])).toEqual([]);
  });

  it('lets go of a sentence that never goes up, however long the other side talks on', () => {
    useVRChatStore.setState({ chatbox: 'translation' });
    const t = setup();
    t.run('running');
    t.show([exchange('a', '你好', '')]);
    expect(typing(t)).toEqual([true]);
    // The other side talks on: the user's sentence is unchanged, so its hold is not renewed.
    t.show([exchange('a', '你好', ''), exchange('p', 'はい', '', { leg: 'participant', final: false })]);
    for (const fire of t.timers.splice(0)) fire();
    expect(typing(t)).toEqual([true, false]);
  });

  it('is put out when the run ends, the chatbox is turned off, or it stops', () => {
    useVRChatStore.setState({ chatbox: 'translation' });
    const t = setup();
    t.run('running');
    t.show([exchange('a', '你好', '', { final: false })]);
    t.run('idle');
    expect(last(typing(t))).toBe(false);
    t.run('running');
    t.show([exchange('b', '谢谢', '', { final: false })]);
    useVRChatStore.setState({ chatbox: 'off' });
    expect(last(typing(t))).toBe(false);
    useVRChatStore.setState({ chatbox: 'translation' });
    t.show([exchange('c', '再见', '', { final: false })]);
    expect(last(typing(t))).toBe(true);
    t.controller.stop();
    expect(last(typing(t))).toBe(false);
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
    t.show([exchange('a', '你好', 'こんにちは')]);
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

describe('a video taken out (stereoSplit)', () => {
  const alone = { mid: -40, side: -120, shared: -40 };
  const silence = { mid: -120, side: -120, shared: -120 };
  function fakeSplit() {
    const hearing = new Set<(h: typeof alone) => void>();
    const shared = new Set<(pcm: Int16Array) => void>();
    let mode = 'mix';
    return {
      onHearing: (l: (h: typeof alone) => void) => { hearing.add(l); return () => { hearing.delete(l); }; },
      onShared: (l: (pcm: Int16Array) => void) => { shared.add(l); return () => { shared.delete(l); }; },
      setMode: (m: string) => { mode = m; },
      spatialSeen: () => true,
      hear(h: typeof alone, times = 1) { for (let i = 0; i < times; i++) for (const l of [...hearing]) l(h); },
      mode: () => mode,
      listening: () => hearing.size > 0,
    };
  }
  /** A runner that opens a side lane, and says when it is closed. */
  function withLanes() {
    const opened: Array<{ prefix: string; closed: boolean; end?: () => void }> = [];
    return {
      opened,
      openSide: async (_leg: string, lane: { prefix: string; feed(deliver: (pcm: Int16Array) => void): () => void; onEnded?(): void }) => {
        const kept = { prefix: lane.prefix, closed: false, end: lane.onEnded };
        opened.push(kept);
        const stop = lane.feed(() => {});
        return { origin: `${lane.prefix}${opened.length}:`, close: async () => { kept.closed = true; stop(); } };
      },
      sideOffered: () => true,
    };
  }

  it('listens once faster, takes the video out once it is heard alone, and ends once its sound has stopped', () => {
    const split = fakeSplit();
    useVRChatStore.setState({ onVideo: 'quick' });
    const t = setup({ split: split as never });
    t.run('running');
    t.handlers.get('vrchat:video')!({ url: 'x' });
    expect(split.listening()).toBe(true);
    expect(last(t.paces)).toEqual(['participant', 'quick']);
    split.hear(alone, 6);
    expect(split.mode()).toBe('people');
    expect(last(t.paces)).toEqual(['participant', 'normal']);
    expect(useVRChatStore.getState().video).toEqual({ kind: 'on', pace: 'quick', auto: false, apart: 'removed' });
    // The next of a playlist changes nothing.
    t.handlers.get('vrchat:video')!({ url: 'y' });
    expect(useVRChatStore.getState().video).toMatchObject({ apart: 'removed' });
    split.hear(silence, 20);
    expect(useVRChatStore.getState().video).toEqual({ kind: 'none' });
    expect(split.mode()).toBe('mix');
    expect(split.listening()).toBe(false);
  });

  it('does not listen with the other side paused', () => {
    const split = fakeSplit();
    useVRChatStore.setState({ onVideo: 'pause' });
    const t = setup({ split: split as never });
    t.run('running');
    t.handlers.get('vrchat:video')!({ url: 'x' });
    expect(split.listening()).toBe(false);
  });

  it('hears the video apart where chosen and offered, and follows the setting', async () => {
    const split = fakeSplit();
    const lanes = withLanes();
    useVRChatStore.setState({ onVideo: 'both' });
    const runner = { setLegPace: () => {}, state: { getState: () => ({ phase: 'running' }), subscribe: () => () => {} }, ...lanes };
    const t = setup({ split: split as never, laneOffered: () => true, runner: runner as never });
    t.handlers.get('vrchat:video')!({ url: 'x' });
    split.hear(alone, 6);
    await Promise.resolve();
    expect(lanes.opened).toMatchObject([{ prefix: 'kotomimi_video:', closed: false }]);
    expect(useVRChatStore.getState().video).toMatchObject({ apart: 'separated', laneOrigin: 'kotomimi_video:1:' });
    useVRChatStore.getState().setOnVideo('quick');
    await Promise.resolve(); await Promise.resolve();
    expect(lanes.opened[0].closed).toBe(true);
    expect(useVRChatStore.getState().video).toMatchObject({ apart: 'removed' });
    useVRChatStore.getState().setOnVideo('both');
    await Promise.resolve();
    expect(lanes.opened).toHaveLength(2);
    await Promise.resolve();
    expect(useVRChatStore.getState().video).toMatchObject({ apart: 'separated', laneOrigin: 'kotomimi_video:2:' });
    // Its session fails: the video's sound stays out, and the state says its words are no longer heard.
    lanes.opened[1].end?.();
    expect(useVRChatStore.getState().video).toMatchObject({ apart: 'removed' });
    expect(useVRChatStore.getState().video).not.toHaveProperty('laneOrigin');
    t.controller.endVideo();
    await Promise.resolve(); await Promise.resolve();
    expect(split.mode()).toBe('mix');
    expect(useVRChatStore.getState().video).toEqual({ kind: 'none' });
  });

  it('hears the video apart for one answer, with the setting left as it was', async () => {
    const split = fakeSplit();
    const lanes = withLanes();
    const runner = { setLegPace: () => {}, state: { getState: () => ({ phase: 'running' }), subscribe: () => () => {} }, ...lanes };
    const t = setup({ split: split as never, laneOffered: () => true, runner: runner as never });
    t.handlers.get('vrchat:video')!({ url: 'x' });
    t.controller.answer('both', false);
    split.hear(alone, 6);
    await Promise.resolve();
    expect(lanes.opened).toHaveLength(1);
    expect(useVRChatStore.getState().onVideo).toBe('ask');
    // The next video asks again, and "only the people" opens nothing.
    t.controller.endVideo();
    t.handlers.get('vrchat:video')!({ url: 'y' });
    t.controller.answer('quick', false);
    split.hear(alone, 6);
    expect(lanes.opened).toHaveLength(1);
  });

  it('only takes the video out where the provider cannot hear it apart', () => {
    const split = fakeSplit();
    const lanes = withLanes();
    useVRChatStore.setState({ onVideo: 'both' });
    const runner = { setLegPace: () => {}, state: { getState: () => ({ phase: 'running' }), subscribe: () => () => {} }, ...lanes };
    setup({ split: split as never, laneOffered: () => false, runner: runner as never }).handlers.get('vrchat:video')!({ url: 'x' });
    split.hear(alone, 6);
    expect(lanes.opened).toHaveLength(0);
    expect(useVRChatStore.getState().video).toMatchObject({ apart: 'removed' });
  });
});

describe('the chatbox\'s sample (fork)', () => {
  it('notes the user\'s last translated sentence for the settings, whether the chatbox is on or not, and never the other side\'s', () => {
    const t = setup();
    t.show([exchange('a', '你好', 'こんにちは'), exchange('b', 'おはよう', '早上好', { leg: 'participant' })]);
    expect(useVRChatStore.getState().recent).toEqual({ said: '你好', translation: 'こんにちは' });
  });
});
