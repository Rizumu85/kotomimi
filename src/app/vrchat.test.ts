import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entry } from '../lib/projection/types';
import type { ClipKey } from '../lib/audio/playback';
import { useVRChatStore, vrchatHolds } from '../stores/vrchatStore';
import { useProviderStore } from '../stores/providerStore';
import { useRoutingStore } from '../stores/routingStore';
import { VOICE_DEFAULTS } from '../providers/openai/localaiVoice';
import { appReading, chatboxPages, chatboxReadingMs, chatboxWaiting, finishedLine, linkOf, READING_WAIT_MS, startVRChat, type Reading, type VRChatDeps } from './vrchat';

vi.mock('../services/persistSetting', () => ({ persistSetting: async () => {} }));

const last = <T>(list: readonly T[]): T | undefined => list[list.length - 1];

const row = (text: string, final = true) => ({ key: `${text}:0`, segmentId: text, side: 'source' as const, start: 0, end: text.length, text, final });
const exchange = (id: string, source: string, translation: string, { leg = 'speaker', final = true } = {}): Entry => ({
  kind: 'exchange', id, leg: leg as 'speaker' | 'participant', languages: { source: 'zh', target: 'ja' }, pairing: 'stated',
  source: [{ ...row(source, final), language: 'zh' }], translation: translation ? [{ ...row(translation, final), side: 'translation', language: 'ja' }] : [], t: 0,
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
  let legs: Array<{ segments: Array<{ id: string; origin?: string; ref?: number }> }> = [];
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

const twice = (source: string, first: string, second: string): Entry => {
  const one = exchange('a', source, first);
  if (one.kind !== 'exchange') throw new Error('Expected exchange');
  return { ...one, translation: [...one.translation, { ...row(second), side: 'translation', language: 'en' }] };
};
const two = { languages: ['ja', 'en'], back: false };

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
      return e.kind === 'exchange' ? { ...e, source: e.source.map((r) => ({ ...r, language: 'ja' })), translation: e.translation.map((r) => ({ ...r, language: 'zh' })) } : e;
    };
    const back = { languages: ['ja'], back: true };
    expect(finishedLine(inJapanese('我们去下一个世界吧'), 'translation', false, false, back)).toBe('我们去下一个世界吧');
    expect(finishedLine(inJapanese('我们去下一个世界吧'), 'both', false, false, back)).toBe('我们去下一个世界吧\n次のワールドに行こう');
    expect(finishedLine(inJapanese('我们去下一个世界吧'), 'both', false, true, back)).toBe('次のワールドに行こう\n我们去下一个世界吧');
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


  it('waits for both translations where two of their languages are lit, and puts each on a line of its own', () => {
    expect(finishedLine(exchange('a', '我们走吧', '行こう'), 'translation', false, false, two)).toBeNull();
    expect(finishedLine(exchange('a', '我们走吧', '行こう'), 'translation', false, false, two, true)).toBe('行こう');
    expect(finishedLine(twice('我们走吧', '行こう', "Let's go"), 'translation', false, false, two)).toBe("行こう\nLet's go");
    expect(finishedLine(twice('我们走吧', '行こう', "Let's go"), 'both', false, false, two)).toBe("我们走吧\n行こう\nLet's go");
  });

  it.each(['zh-CN', 'ja', 'en'])('puts a sentence said in %s at its language’s place and waits for both answers', (language) => {
    const texts = [
      { language: 'zh-CN', text: '我们走吧' },
      { language: 'ja', text: '行こう' },
      { language: 'en', text: "Let's go" },
    ];
    const said = texts.find((text) => text.language === language)!.text;
    const entry: Entry = {
      kind: 'exchange', id: 'cross', leg: 'speaker', languages: { source: 'zh-CN', target: 'ja' }, pairing: 'stated', t: 0,
      source: [{ ...row(said), language }],
      // Deliberately unlike the display order; split rows still make one answer.
      translation: texts.filter((text) => text.language !== language).reverse().flatMap(({ text, language }) => [
        { ...row(text), text: text.slice(0, 1), side: 'translation' as const, language, ...(language === 'zh-CN' ? { accompaniesTranslation: true as const } : {}) },
        { ...row(text), key: `${text}:1`, text: text.slice(1), side: 'translation' as const, language, ...(language === 'zh-CN' ? { accompaniesTranslation: true as const } : {}) },
      ]),
    };
    const theirs = { ...two, back: true };
    for (const translationFirst of [false, true]) {
      const ordered = translationFirst ? [texts[1], texts[2], texts[0]] : texts;
      expect(finishedLine(entry, 'both', false, translationFirst, theirs)).toBe(ordered.map((text) => text.text).join('\n'));
      expect(finishedLine(entry, 'translation', false, translationFirst, theirs)).toBe(ordered.filter((text) => text.language !== language).map((text) => text.text).join('\n'));
    }
    const missing = { ...entry, translation: entry.translation.slice(0, 2) };
    const unfinished = { ...entry, translation: entry.translation.map((r, i) => ({ ...r, final: i < 2 })) };
    expect(finishedLine(missing, 'both', false, false, theirs)).toBeNull();
    expect(finishedLine(missing, 'translation', false, false, theirs, true)).toBe(texts.filter((text) => text.language !== language).pop()!.text);
    expect(finishedLine(unfinished, 'both', false, false, theirs, true)).toBeNull();
    const h = setup({ theirs: () => theirs });
    useVRChatStore.getState().setChatbox('both');
    h.show([missing]);
    expect(h.chatboxLines()).toEqual([]);
    expect(useVRChatStore.getState().recent).toBeNull();
    h.show([unfinished]);
    expect(h.chatboxLines()).toEqual([]);
    expect(useVRChatStore.getState().recent).toBeNull();
    h.show([entry]);
    expect(h.chatboxLines()).toEqual(["我们走吧\n行こう\nLet's go"]);
    expect(useVRChatStore.getState().recent?.translation).toBe(texts.filter((text) => text.language !== language).map((text) => text.text).join('\n'));
    useVRChatStore.getState().setChatboxTranslationFirst(true);
    h.show([entry]);
    expect(useVRChatStore.getState().recent?.translation).toBe([texts[1], texts[2], texts[0]].filter((text) => text.language !== language).map((text) => text.text).join('\n'));
    h.controller.stop();
  });

  it.each([false, true])('uses the leg languages for unlabelled source and forward answer with translationFirst=%s', (translationFirst) => {
    const entry = twice('我们走吧', '行こう', "Let's go");
    if (entry.kind !== 'exchange') throw new Error('Expected exchange');
    entry.source = entry.source.map((r) => ({ ...r, language: undefined }));
    entry.translation[0] = { ...entry.translation[0], language: undefined };
    expect(finishedLine(entry, 'both', false, translationFirst, two)).toBe(translationFirst ? "行こう\nLet's go\n我们走吧" : "我们走吧\n行こう\nLet's go");
    expect(finishedLine(entry, 'translation', false, translationFirst, two)).toBe("行こう\nLet's go");
  });

  it.each([false, true])('puts a language outside the run last with translationFirst=%s', (translationFirst) => {
    const entry = twice('我们走吧', '行こう', '가자');
    if (entry.kind !== 'exchange') throw new Error('Expected exchange');
    entry.translation[1] = { ...entry.translation[1], language: 'ko' };
    expect(finishedLine(entry, 'both', false, translationFirst, two)).toBe(translationFirst ? '行こう\n我们走吧\n가자' : '我们走吧\n行こう\n가자');
    expect(finishedLine(entry, 'translation', false, translationFirst, two)).toBe('行こう\n가자');
  });

  it.each([false, true])('sends all three languages in pages with translationFirst=%s when they do not fit together', (translationFirst) => {
    const said = '我们'.repeat(30);
    const japanese = '行こう'.repeat(15);
    const english = "Let's go ".repeat(5).trim();
    const entry = twice(said, japanese, english);
    const expected = translationFirst ? [japanese, english, said] : [said, japanese, english];
    expect(finishedLine(entry, 'both', false, translationFirst, two)).toBe(expected.join('\n'));
    useVRChatStore.setState({ chatbox: 'both', chatboxTranslationFirst: translationFirst });
    const h = setup({ theirs: () => two });
    h.show([entry]);
    expect(h.chatboxLines()).toEqual(expected.slice(0, 1));
    h.timers.shift()!();
    h.timers.shift()!();
    expect(h.chatboxLines()).toEqual(expected);
    h.controller.stop();
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

  it('holds each page of a long line, and a line that fits, for its own reading time, by one rule (fork)', () => {
    useVRChatStore.setState({ chatbox: 'translation' });
    const waits: number[] = [];
    const pending: Array<() => void> = [];
    const t = setup({ setTimeout: (fn, ms) => { waits.push(ms); pending.push(fn); } });
    t.show([exchange('a', '长', `${'長'.repeat(100)}。${'続'.repeat(60)}`)]);
    expect(waits[waits.length - 1]).toBe(12_000);
    pending.shift()!();
    // The last page: 60 characters, about 11 s to read.
    expect(waits[waits.length - 1]).toBe(chatboxReadingMs('続'.repeat(60)));
    pending.shift()!();
    // A line that fits is read as long as a page of the same words.
    t.show([exchange('a', '长', `${'長'.repeat(100)}。${'続'.repeat(60)}`), exchange('b', '短', '短'.repeat(60))]);
    expect(waits[waits.length - 1]).toBe(chatboxReadingMs('短'.repeat(60)));
    t.controller.stop();
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
    expect(chatboxReadingMs('中'.repeat(144))).toBe(12000);
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
  it('does not send what was said while it was off, once it is turned on again', () => {
    useVRChatStore.setState({ chatbox: 'translation' });
    const t = setup();
    useVRChatStore.setState({ chatbox: 'off' });
    // Said with the chatbox off: one translated already, one whose translation is still to come.
    t.show([exchange('a', '这句不发', 'これは送らない'), exchange('b', '这句也不发', '')]);
    useVRChatStore.setState({ chatbox: 'translation' });
    // Whatever comes on screen next must not carry them up: not a new sentence, not the late translation.
    t.show([exchange('a', '这句不发', 'これは送らない'), exchange('b', '这句也不发', 'これも送らない'), exchange('c', '你好', 'こんにちは')]);
    expect(t.chatboxLines()).toEqual(['こんにちは']);
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

  it('never sends what was heard in none of the user’s languages (fork)', () => {
    useVRChatStore.setState({ chatbox: 'both' });
    for (const coached of [false, true]) {
      const t = setup({ coached: () => coached });
      const entry = exchange('m', 'Kir Kirhum.', '');
      if (entry.kind !== 'exchange') throw new Error('expected exchange');
      t.show([{ ...entry, source: entry.source.map((r) => ({ ...r, language: 'en', misheard: true as const })) }]);
      expect(t.chatboxLines()).toEqual([]);
      t.controller.stop();
    }
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

  it('sends a coached sentence as said though it is translated back for the user, and does not show that as what goes up', () => {
    useVRChatStore.setState({ chatbox: 'both' });
    const t = setup({ coached: () => true, theirs: () => ({ languages: ['fr'], back: false }) });
    const entry = exchange('practice', 'Je suis ici', 'I am here');
    if (entry.kind !== 'exchange') throw new Error('expected exchange');
    t.show([{
      ...entry,
      source: entry.source.map((r) => ({ ...r, language: 'fr' })),
      translation: entry.translation.map((r) => ({ ...r, purpose: 'translation' as const })),
      feedback: [{ ...row('Private grammar explanation'), side: 'translation', purpose: 'feedback' }],
    }]);
    expect(t.chatboxLines()).toEqual(['Je suis ici']);
    expect(useVRChatStore.getState().recent).toBeNull();
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

describe('the chatbox, where the translations are read aloud to the other side (fork)', () => {
  /** The playback's queue of the user's leg, as a test moves it. */
  function voice(languages = ['ja', 'en']) {
    let clips: Array<{ ref: number | undefined; inMs: number }> = [];
    const listeners = new Set<() => void>();
    const states = new Map<number, ReturnType<Reading['state']>>();
    const notify = () => { for (const listener of listeners) listener(); };
    const reading: Reading = {
      state: (ref) => states.get(ref), speaks: (language) => languages.includes(language), scheduled: () => clips,
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    };
    return {
      reading, set(next: typeof clips) { clips = next; notify(); }, move(next: typeof clips) { clips = next; },
      mark(ref: number, state: ReturnType<Reading['state']>) { states.set(ref, state); notify(); },
    };
  }
  /** The segments of the user's leg: each translation by the number its reading goes by. */
  const legsOf = (refs: Record<string, number>) => [{ segments: Object.entries(refs).map(([id, ref]) => ({ id, ref })) }];
  function reads(languages?: string[], theirs?: VRChatDeps['theirs']) {
    useVRChatStore.setState({ chatbox: 'translation' });
    const v = voice(languages);
    const waits: Array<{ fn: () => void; ms: number }> = [];
    const t = setup({ theirs, reading: () => v.reading, setTimeout: (fn, ms) => { waits.push({ fn, ms }); } });
    const fire = (ms: number) => { const at = waits.findIndex((wait) => wait.ms === ms); if (at < 0) throw new Error(`no timer of ${ms} ms`); waits.splice(at, 1)[0].fn(); };
    return { t, v, waits, fire };
  }

  it('waits through a long synthesis until its first clip starts', () => {
    const { t, v, fire } = reads();
    t.show([exchange('a', 'One', 'First')], legsOf({ First: 1 }));
    v.mark(1, 'waiting');
    fire(READING_WAIT_MS);
    v.mark(1, 'making');
    fire(READING_WAIT_MS);
    fire(READING_WAIT_MS);
    expect(t.chatboxLines()).toEqual([]);
    v.set([{ ref: 1, inMs: 0 }]);
    expect(t.chatboxLines()).toEqual(['First']);
    t.controller.stop();
  });

  it.each(['dropped', 'failed'] as const)('sends a %s reading immediately while an older one is being made', (end) => {
    const { t, v } = reads();
    t.show([exchange('a', 'One', 'First'), exchange('b', 'Two', 'Second')], legsOf({ First: 1, Second: 2 }));
    v.mark(1, 'making');
    v.mark(2, end);
    expect(t.chatboxLines()).toEqual(['Second']);
    t.controller.stop();
  });

  it('sends the original alone as soon as it is final, without waiting for the reading of its translation', () => {
    const { t, v } = reads();
    useVRChatStore.setState({ chatbox: 'source' });
    v.mark(1, 'making');
    t.show([exchange('a', 'One', 'First')], legsOf({ First: 1 }));
    expect(t.chatboxLines()).toEqual(['One']);
    t.controller.stop();
  });

  it('gives a known synthesis at most fifteen seconds even while other sound plays', () => {
    const { t, v, fire } = reads();
    v.mark(1, 'making');
    t.show([exchange('a', 'One', 'First')], legsOf({ First: 1 }));
    v.set([{ ref: 9, inMs: 0 }]);
    for (let ms = READING_WAIT_MS; ms < 15_000; ms += READING_WAIT_MS) fire(READING_WAIT_MS);
    expect(t.chatboxLines()).toEqual([]);
    fire(READING_WAIT_MS);
    expect(t.chatboxLines()).toEqual(['First']);
    t.controller.stop();
  });

  it.each([false, true])('shows each language as it starts with translation first set to %s', (first) => {
    const { t, v, fire } = reads(undefined, () => two);
    useVRChatStore.setState({ chatbox: 'both', chatboxTranslationFirst: first });
    const ja = '訳'.repeat(85);
    const en = 'English '.repeat(10).trim();
    t.show([twice('Original', ja, en)], legsOf({ [ja]: 4, [en]: 5 }));
    v.set([{ ref: 4, inMs: 0 }]);
    const page = (translation: string) => first ? `${translation}\nOriginal` : `Original\n${translation}`;
    expect(t.chatboxLines()).toEqual([page(ja)]);
    fire(1500);
    expect(t.chatboxLines()).toHaveLength(1);
    v.set([{ ref: 5, inMs: 0 }]);
    expect(t.chatboxLines()).toEqual([page(ja), page(en)]);
    t.controller.stop();
  });

  it('ends every Japanese and English page with the original excerpt when translations come first', () => {
    const { t, v, fire } = reads(undefined, () => two);
    useVRChatStore.setState({ chatbox: 'both', chatboxTranslationFirst: true });
    const source = '字'.repeat(145);
    const excerpt = `${'字'.repeat(71)}…`;
    const ja = '訳'.repeat(100);
    t.show([twice(source, ja, 'English')], legsOf({ [ja]: 4, English: 5 }));
    v.set([{ ref: 4, inMs: 0 }]);
    fire(1500);
    fire(chatboxReadingMs(t.chatboxLines()[0]) - 1500);
    fire(1500);
    v.set([{ ref: 5, inMs: 0 }]);
    expect(t.chatboxLines()).toEqual([`${'訳'.repeat(70)}…\n${excerpt}`, `${'訳'.repeat(30)}\n${excerpt}`,
      `English\n${excerpt}`]);
    t.controller.stop();
  });

  it('sends a short multilingual line whole at its first reading, even after the other was dropped', () => {
    const { t, v } = reads(undefined, () => two);
    useVRChatStore.setState({ chatbox: 'both', chatboxTranslationFirst: true });
    t.show([twice('Original', '訳', 'English')], legsOf({ '訳': 4, English: 5 }));
    v.mark(4, 'dropped');
    expect(t.chatboxLines()).toEqual([]);
    v.set([{ ref: 5, inMs: 0 }]);
    expect(t.chatboxLines()).toEqual(['訳\nEnglish\nOriginal']);
    t.controller.stop();
  });

  it.each(['ja', 'en'])('pairs the silent translation with the one spoken in %s', (language) => {
    const { t, v, fire } = reads([language], () => two);
    useVRChatStore.setState({ chatbox: 'both' });
    const ja = '訳'.repeat(70);
    const en = 'English '.repeat(10).trim();
    t.show([twice('Original', ja, en)], legsOf({ [ja]: 4, [en]: 5 }));
    v.set([{ ref: language === 'ja' ? 4 : 5, inMs: 0 }]);
    const [page] = t.chatboxLines();
    expect(page.startsWith(`Original\n${ja}`)).toBe(true);
    fire(1500);
    fire(chatboxReadingMs(page) - 1500);
    const pages = t.chatboxLines();
    expect(pages).toHaveLength(2);
    expect(pages.every((text) => text.startsWith('Original\n') && [...text].length <= 144)).toBe(true);
    expect(pages[1].endsWith('English')).toBe(true);
    t.controller.stop();
  });

  it('switches a long translation at the next language onset even while its page timer is running', () => {
    const { t, v, fire } = reads(undefined, () => two);
    useVRChatStore.setState({ chatbox: 'both' });
    const ja = '訳'.repeat(200);
    t.show([twice('Original', ja, 'English')], legsOf({ [ja]: 4, English: 5 }));
    v.set([{ ref: 4, inMs: 0 }]);
    fire(1500);
    const [page] = t.chatboxLines();
    v.set([{ ref: 5, inMs: 0 }]);
    expect(t.chatboxLines()).toEqual([page, 'Original\nEnglish']);
    fire(chatboxReadingMs(page) - 1500);
    expect(t.chatboxLines()).toHaveLength(2);
    t.controller.stop();
  });

  it('shares the time before a scheduled language between the pages of the current one', () => {
    const { t, v, fire } = reads(undefined, () => two);
    useVRChatStore.setState({ chatbox: 'both' });
    const ja = '訳'.repeat(200);
    t.show([twice('Original', ja, 'English')], legsOf({ [ja]: 4, English: 5 }));
    v.set([{ ref: 4, inMs: 0 }, { ref: 5, inMs: 4000 }]);
    fire(1500);
    fire(500);
    const pages = t.chatboxLines();
    expect(pages).toHaveLength(2);
    expect(pages.map((page) => page.slice('Original\n'.length).replace(/…$/, '')).join('')).toBe(ja);
    fire(1500);
    v.set([{ ref: 5, inMs: 0 }]);
    expect(last(t.chatboxLines())).toBe('Original\nEnglish');
    t.controller.stop();
  });

  it('sends a sentence up when its reading begins, not when its translation is written', () => {
    const { t, v } = reads();
    t.show([exchange('a', '你好', 'こんにちは')], legsOf({ こんにちは: 4 }));
    expect(t.chatboxLines()).toEqual([]);
    // Made and queued behind what is still being read: not yet.
    v.set([{ ref: 2, inMs: -900 }, { ref: 4, inMs: 1200 }]);
    expect(t.chatboxLines()).toEqual([]);
    // The one before it has ended, and it sounds.
    v.set([{ ref: 4, inMs: -5 }]);
    expect(t.chatboxLines()).toEqual(['こんにちは']);
    // Its later pieces send nothing again.
    v.set([{ ref: 4, inMs: -400 }, { ref: 4, inMs: 300 }]);
    expect(t.chatboxLines()).toEqual(['こんにちは']);
    t.controller.stop();
  });

  it('sends a sentence at once whose reading began, or was over, before its line was finished on screen', () => {
    const { t, v } = reads();
    t.run('running');
    // A short answer: read and over before the view has shown its translation as final.
    v.set([{ ref: 4, inMs: -5 }]);
    v.set([]);
    t.show([exchange('a', '好', 'はい')], legsOf({ はい: 4 }));
    expect(t.chatboxLines()).toEqual(['はい']);
    t.controller.stop();
  });

  it('looks again at the moment a queued reading starts, which the queue does not tell', () => {
    const { t, v, fire } = reads();
    t.show([exchange('a', '你好', 'こんにちは')], legsOf({ こんにちは: 4 }));
    // Queued while nothing plays: it starts a moment later, with no word from the queue.
    v.set([{ ref: 4, inMs: 50 }]);
    expect(t.chatboxLines()).toEqual([]);
    v.move([{ ref: 4, inMs: -5 }]);
    fire(55);
    expect(t.chatboxLines()).toEqual(['こんにちは']);
    t.controller.stop();
  });

  it('keeps the sentences in step with the voice, each held only as long as VRChat asks', () => {
    const { t, v, waits, fire } = reads();
    const three = [exchange('a', '一', 'First'), exchange('b', '二', 'Second'), exchange('c', '三', 'Third')];
    t.show(three, legsOf({ First: 1, Second: 2, Third: 3 }));
    // All three are translated and made; the voice is on the first.
    const before = waits.length;
    v.set([{ ref: 1, inMs: -10 }, { ref: 2, inMs: 2000 }, { ref: 3, inMs: 4500 }]);
    expect(t.chatboxLines()).toEqual(['First']);
    // Held for the gap between two lines, not for the time the line takes to read: the voice sets the pace. And
    // looked at again when the next one starts.
    expect(waits.slice(before).map((wait) => wait.ms).sort((a, b) => a - b)).toEqual([1500, 2005]);
    expect(chatboxReadingMs('First')).toBeGreaterThan(1500);
    fire(1500);
    expect(t.chatboxLines()).toEqual(['First']);
    v.set([{ ref: 2, inMs: -10 }, { ref: 3, inMs: 2500 }]);
    expect(t.chatboxLines()).toEqual(['First', 'Second']);
    fire(1500);
    v.set([{ ref: 3, inMs: -10 }]);
    expect(t.chatboxLines()).toEqual(['First', 'Second', 'Third']);
    t.controller.stop();
  });

  it('sends a sentence the voice passed over with the next one that is read', () => {
    const { t, v } = reads();
    t.show([exchange('a', '一', 'First'), exchange('b', '二', 'Second')], legsOf({ First: 1, Second: 2 }));
    // The first was dropped by a voice that had fallen behind: the second is what it reads.
    v.set([{ ref: 2, inMs: -10 }]);
    expect(t.chatboxLines()).toEqual(['First\nSecond']);
    t.controller.stop();
  });

  it('sends a sentence whose reading never comes once nothing is being read, and waits on while something is', () => {
    const { t, v, fire } = reads();
    t.show([exchange('a', '你好', 'こんにちは')], legsOf({ こんにちは: 4 }));
    // Another sentence is still being read: its turn may yet come.
    v.move([{ ref: 2, inMs: -900 }]);
    fire(READING_WAIT_MS);
    expect(t.chatboxLines()).toEqual([]);
    // Nothing is read, and nothing waits to be: the voice could not make it.
    v.move([]);
    fire(READING_WAIT_MS);
    expect(t.chatboxLines()).toEqual(['こんにちは']);
    t.controller.stop();
  });

  it('keeps nothing back that is not read: a sentence sent as said, one with no segment known, and all of it once nobody is read to', () => {
    useVRChatStore.setState({ chatbox: 'translation' });
    const v = voice();
    let on = true;
    const t = setup({ reading: () => (on ? v.reading : null), theirs: () => ({ languages: ['ja'], back: false }) });
    // Said in their language: it goes up as said, and nothing reads it.
    const said = exchange('a', 'こんにちは', '');
    t.show([said.kind === 'exchange' ? { ...said, source: said.source.map((r) => ({ ...r, language: 'ja' })) } : said]);
    expect(t.chatboxLines()).toEqual(['こんにちは']);
    t.timers.shift()!();
    // Its segment is not known to the view: nothing could tell when its reading begins.
    t.show([exchange('b', '谢谢', 'ありがとう')]);
    expect(t.chatboxLines()).toEqual(['こんにちは', 'ありがとう']);
    t.timers.shift()!();
    // Kept back for its reading, and the other side is set not to hear it any more: it goes up at the next look.
    t.show([exchange('b', '谢谢', 'ありがとう'), exchange('c', '再见', 'さようなら')], legsOf({ さようなら: 9 }));
    expect(t.chatboxLines()).toEqual(['こんにちは', 'ありがとう']);
    on = false;
    t.show([exchange('b', '谢谢', 'ありがとう'), exchange('c', '再见', 'さようなら')], legsOf({ さようなら: 9 }));
    expect(t.chatboxLines()).toEqual(['こんにちは', 'ありがとう', 'さようなら']);
    t.controller.stop();
  });

  it('forgets what it kept back when the run ends, and shows the typing bubble while it keeps one', () => {
    const { t, v } = reads();
    t.run('running');
    t.show([exchange('a', '你好', 'こんにちは')], legsOf({ こんにちは: 4 }));
    expect(last(t.invoked.filter(([channel]) => channel === 'vrchat:typing'))).toEqual(['vrchat:typing', { on: true }]);
    t.run('idle');
    v.set([{ ref: 4, inMs: -5 }]);
    expect(t.chatboxLines()).toEqual([]);
    t.controller.stop();
  });
});

describe('the reading the app hands the chatbox (fork)', () => {
  const theirs = () => ({ languages: ['ja'], back: false });
  const select = (speak: object, selected = 'localai') => {
    const before = useProviderStore.getState();
    useProviderStore.setState({ selected, entries: { ...before.entries, localai: { ...before.entries.localai, settings: { speak } } as never } });
  };

  it('follows the speaker queue while the voice reads to the other side', () => {
    const clips: Array<{ key: ClipKey; inMs: number }> = [
      { key: 'speaker:7:0', inMs: -20 }, { key: 'speaker:7:1', inMs: 480 }, { key: 'speaker:none:0', inMs: 900 },
    ];
    const queue = vi.fn(() => ({
      scheduled: () => clips, subscribe: () => () => {}, position: () => null, clears: 0, pending: clips.length,
    }));
    const state = (ref: number) => ref === 7 ? 'queued' as const : undefined;
    const reading = appReading(theirs, queue, state);
    const before = { provider: useProviderStore.getState(), meeting: useRoutingStore.getState().meeting };
    try {
      useRoutingStore.setState({ meeting: true });
      const edge = { ...VOICE_DEFAULTS, on: true, at: 'api' as const };
      // Off, said on demand only, another provider's run, a voice that does not speak their language, the other side
      // not hearing it: nothing is kept back for a reading.
      select({ ...edge, on: false });
      expect(reading()).toBeNull();
      select({ ...edge, auto: false });
      expect(reading()).toBeNull();
      select(edge, 'openai');
      expect(reading()).toBeNull();
      select({ ...VOICE_DEFAULTS, on: true, at: 'device', nativeModel: 'irodori-tts-v4.1-small-mf-q8' });
      expect(appReading(() => ({ languages: ['en-US'], back: false }), queue, state)()).toBeNull();
      select(edge);
      useRoutingStore.setState({ meeting: false });
      expect(reading()).toBeNull();
      expect(queue).not.toHaveBeenCalled();
      useRoutingStore.setState({ meeting: true });
      expect(reading()!.scheduled()).toEqual([
        { ref: 7, inMs: -20 }, { ref: 7, inMs: 480 }, { ref: undefined, inMs: 900 },
      ]);
      expect(reading()!.state(7)).toBe('queued');
      expect(reading()!.speaks('ja-JP')).toBe(true);
      expect(reading()!.speaks('zh')).toBe(false);
    } finally {
      useProviderStore.setState({ selected: before.provider.selected, entries: before.provider.entries });
      useRoutingStore.setState({ meeting: before.meeting });
    }
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
