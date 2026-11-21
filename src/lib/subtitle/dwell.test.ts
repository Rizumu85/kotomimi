import { describe, expect, it } from 'vitest';
import type { Entry, Row } from '../projection/types';
import { ANSWER_WAIT_MS, answeredOf, answerTurn, fedOf, HOLD_LEAST_MS, HOLD_MOST_MS, holdMs, nextShown, readMs, rowSentences, rowTurn, type RowShown } from './dwell';

describe('how long a caption stays before the next takes its place', () => {
  it('is its length at the pace its language is read at', () => {
    // Eighteen characters: two seconds of Chinese, 1.8 of Korean; Japanese would take 3.6, and is held the most.
    const text = '一二三四五六七八九十一二三四五六七八';
    expect(readMs(text, 'zh-CN')).toBe(2000);
    expect(readMs(text, 'ja')).toBe(HOLD_MOST_MS);
    expect(readMs('一二三四五六七八九十', 'ja')).toBe(2000);
    expect(readMs(text, 'ko-KR')).toBe(1800);
    expect(readMs('It is nice today, I think so too.', 'en')).toBe(Math.round((33 / 17) * 1000));
    // A language nothing is known of reads as one written with spaces.
    expect(readMs(text, undefined)).toBe(HOLD_LEAST_MS);
  });

  it('is never under the least — a word is found and read, not only read — and never over the most', () => {
    expect(readMs('好。', 'zh')).toBe(HOLD_LEAST_MS);
    expect(readMs('あ'.repeat(80), 'ja')).toBe(HOLD_MOST_MS);
  });

  it('is bounded, so that a fast speaker\u2019s captions do not fall behind: 2.5 s at most, and the least where a second one waits', () => {
    // Asked by the user 2026-10-06: "if they talk fast, will the captions drift later and later?"
    const long = 'あ'.repeat(30);
    expect(HOLD_MOST_MS).toBe(2500);
    expect(holdMs(long, 'ja', 1)).toBe(HOLD_MOST_MS);
    expect(holdMs(long, 'ja', 2)).toBe(HOLD_LEAST_MS);
    expect(holdMs('好。', 'zh', 3)).toBe(HOLD_LEAST_MS);
  });

  it('goes on to the next, and passes over the oldest of a long queue', () => {
    expect(nextShown(3, 4)).toBe(4);
    expect(nextShown(3, 5)).toBe(4);
    // Three behind: a caption read seconds after the voice is no better than one missed.
    expect(nextShown(3, 6)).toBe(5);
    expect(nextShown(0, 9)).toBe(8);
  });
});

describe('a leg’s answered sentences', () => {
  const row = (id: string, text: string, side: 'source' | 'translation', language?: string): Row =>
    ({ key: `${id}:0`, segmentId: id, side, start: 0, end: text.length, text, final: true, ...(language ? { language } : {}) });
  const said = (id: string, leg: 'speaker' | 'participant', source: string, answer = '', language?: string): Extract<Entry, { kind: 'exchange' }> => ({
    kind: 'exchange', id, leg, languages: { source: 'ja', target: 'zh-CN' }, pairing: 'stated',
    source: [row(`s-${id}`, source, 'source')], translation: answer ? [row(`t-${id}`, answer, 'translation', language)] : [], t: 0,
  });

  it('are those with a translation written, oldest first, each in the language it was answered in', () => {
    const entries: Entry[] = [
      said('a', 'participant', 'はい。', '好的。'),
      said('b', 'speaker', '你好。', 'こんにちは。'),
      said('c', 'participant', 'そうですね。'),
      { kind: 'notice', id: 'n', leg: 'participant', severity: 'info', message: 'x', at: 0 },
      said('d', 'participant', 'ハロー。', ' Hello. ', 'en'),
    ];
    expect(answeredOf(entries, 'participant')).toEqual([
      { id: 'a', text: '好的。', language: 'zh-CN' },
      { id: 'd', text: 'Hello.', language: 'en' },
    ]);
    expect(answeredOf(entries, 'speaker')).toEqual([{ id: 'b', text: 'こんにちは。', language: 'zh-CN' }]);
  });

  it('includes standalone coaching feedback between translations, while combined feedback keeps the translation turn', () => {
    const feedback = (id: string, combined = false): Extract<Entry, { kind: 'exchange' }> => ({
      ...said(id, 'speaker', 'I goes.'),
      kind: 'exchange', source: [row(`s-${id}`, 'I goes.', 'source', 'en')], translation: [],
      feedback: [{ ...row(`f-${id}`, 'I go.', 'translation', 'en'), purpose: 'feedback', ...(combined ? { accompaniesTranslation: true as const } : {}) }],
    });
    const native = said('native', 'speaker', 'Nous arrivons.', 'We arrive.', 'en');
    const practice = feedback('practice');
    const combined = feedback('combined', true);
    expect(answeredOf([native, practice, combined], 'speaker')).toEqual([
      { id: 'native', text: 'We arrive.', language: 'en' },
      { id: 'practice', text: 'I go.', language: 'en' },
    ]);
    const translated = { ...combined, translation: [row('translation', 'Je vais.', 'translation', 'fr')] };
    expect(answeredOf([translated], 'speaker')).toEqual([{ id: 'combined', text: 'Je vais.', language: 'fr' }]);
  });
});

describe("the user's own row takes their sentences in turn (fork)", () => {
  const row = (segmentId: string, text: string, side: 'source' | 'translation', extra: Partial<Row> = {}): Row =>
    ({ key: `${segmentId}:0`, segmentId, side, start: 0, end: text.length, text, final: true, ...extra });
  const mine = (id: string, source: string, answer = '', extra: Partial<Row> = {}): Entry => ({
    kind: 'exchange', id, leg: 'speaker', languages: { source: 'zh-CN', target: 'ja' }, pairing: 'stated', t: 0,
    source: [row(`s-${id}`, source, 'source', extra)], translation: answer ? [row(`t-${id}`, answer, 'translation')] : [],
  });
  const theirs: Entry = { kind: 'exchange', id: 'p', leg: 'participant', languages: { source: 'ja', target: 'zh-CN' }, pairing: 'stated', t: 0, source: [row('s-p', 'はい。', 'source')], translation: [row('t-p', '好的。', 'translation')] };
  const turn = (entries: Entry[], before: RowShown | undefined, now: number) => rowTurn(rowSentences(entries, 'speaker'), before, now);

  it('shows the newest sentence at once while nobody has gone on, and holds nothing', () => {
    expect(turn([], undefined, 0)).toEqual({ shown: undefined, due: Infinity });
    const first = turn([theirs, mine('a', '我想去咖啡店。')], undefined, 1000);
    expect(first).toEqual({ shown: { id: 'a' }, due: Infinity });
    // Its answer comes: on screen from then.
    expect(turn([theirs, mine('a', '我想去咖啡店。', 'カフェに行きたいです。')], first.shown, 1300)).toEqual({ shown: { id: 'a', since: 1300 }, due: Infinity });
  });

  it('keeps a sentence whose answer has just come while the user goes on, for as long as the answer takes to read', () => {
    const answered = mine('a', '我想去咖啡店。', 'カフェに行きたいです。');
    const next = mine('b', '听说');
    const held = turn([answered, next], { id: 'a', since: 1300 }, 1400);
    const until = 1300 + holdMs('カフェに行きたいです。', 'ja', 1);
    expect(held).toEqual({ shown: { id: 'a', since: 1300 }, due: until });
    expect(turn([answered, next], held.shown, until - 1).shown).toEqual({ id: 'a', since: 1300 });
    expect(turn([answered, next], held.shown, until)).toEqual({ shown: { id: 'b' }, due: Infinity });
    // Read long ago: the next sentence takes its place with its first word.
    expect(turn([answered, next], { id: 'a', since: 1300 }, 60_000).shown).toEqual({ id: 'b' });
  });

  it('waits a moment for an answer on its way, and no longer', () => {
    const first = mine('a', '我想去咖啡店。');
    const waiting = turn([mine('z', '你好。', 'こんにちは。'), first, mine('b', '听说')], { id: 'a' }, 2000);
    expect(waiting).toEqual({ shown: { id: 'a', behind: 2000 }, due: 2000 + ANSWER_WAIT_MS });
    // It comes: read from then.
    const came = turn([mine('z', '你好。', 'こんにちは。'), mine('a', '我想去咖啡店。', 'カフェに行きたいです。'), mine('b', '听说')], waiting.shown, 2300);
    expect(came.shown).toEqual({ id: 'a', behind: 2000, since: 2300 });
    // It does not: the next.
    expect(turn([mine('z', '你好。', 'こんにちは。'), first, mine('b', '听说')], waiting.shown, 2000 + ANSWER_WAIT_MS).shown).toEqual({ id: 'b' });
  });

  it('waits for nothing that will not come: a mishearing, or a side that is answered nothing', () => {
    // Three sentences and no answer to any: a run that only transcribes.
    expect(turn([mine('y', '你好。'), mine('z', '在吗？'), mine('a', '我想去咖啡店。'), mine('b', '听说')], { id: 'a' }, 2000).shown).toEqual({ id: 'b' });
    // The first sentences of a run are waited on: nothing says yet that no answer comes.
    expect(turn([mine('a', '我想去咖啡店。'), mine('b', '听说')], { id: 'a' }, 2000)).toEqual({ shown: { id: 'a', behind: 2000 }, due: 2000 + ANSWER_WAIT_MS });
    const misheard = mine('a', 'Kir Kirhum.', '', { misheard: true });
    expect(turn([mine('z', '你好。', 'こんにちは。'), misheard, mine('b', '听说')], { id: 'a' }, 2000).shown).toEqual({ id: 'b' });
  });

  it('gives each the least with more than one waiting, and passes over the oldest when far behind', () => {
    const said = ['a', 'b', 'c', 'd', 'e'].map((id) => mine(id, `第${id}句话说完了。`, `${id}の文を言い終わりました。長い文です。`));
    expect(turn(said.slice(0, 3), { id: 'a', since: 0 }, 100).due).toBe(HOLD_LEAST_MS);
    // Four behind: to the one before the newest, shown from now.
    expect(turn(said, { id: 'a', since: 0 }, HOLD_LEAST_MS).shown).toEqual({ id: 'd', since: HOLD_LEAST_MS });
  });

  it('starts again at the newest when what it showed is gone', () => {
    expect(turn([mine('x', '好的。', 'はい。')], { id: 'a', since: 0 }, 500).shown).toEqual({ id: 'x', since: 500 });
  });
});

describe('the line grammar feedback is written in takes it in turn (fork)', () => {
  const row = (segmentId: string, text: string, side: 'source' | 'translation'): Row => ({ key: `${segmentId}:0`, segmentId, side, start: 0, end: text.length, text, final: true });
  const said = (id: string, feedback = ''): Entry => ({
    kind: 'exchange', id, leg: 'speaker', languages: { source: 'zh-CN', target: 'ja' }, pairing: 'stated', t: 0,
    source: [row(`s-${id}`, '明日映画を見ります。', 'source')], translation: [row(`t-${id}`, '明天看电影。', 'translation')],
    ...(feedback ? { feedback: [{ ...row(`f-${id}`, feedback, 'translation'), purpose: 'feedback', accompaniesTranslation: true }] } : {}),
  });

  it('lists the sentences that have feedback, read at the pace of the user\u2019s own language', () => {
    expect(fedOf([said('a'), said('b', '明日映画を見ます。'), said('c', '✓')], 'speaker')).toEqual([
      { id: 'b', text: '明日映画を見ます。', language: 'zh-CN' }, { id: 'c', text: '✓', language: 'zh-CN' },
    ]);
    expect(fedOf([said('b', '✓')], 'participant')).toEqual([]);
  });

  it('keeps a correction until it has been read, though the next sentence\u2019s tick has come', () => {
    const list = fedOf([said('a', '明日映画を見ます。\n“見ります”应为“見ます”。'), said('b', '✓')], 'speaker');
    expect(answerTurn([], undefined, 0)).toEqual({ shown: undefined, due: Infinity });
    const first = answerTurn(list.slice(0, 1), undefined, 1000);
    expect(first).toEqual({ shown: { id: 'a', since: 1000 }, due: Infinity });
    const until = 1000 + holdMs(list[0].text, 'zh-CN', 1);
    expect(answerTurn(list, first.shown, 1500)).toEqual({ shown: { id: 'a', since: 1000 }, due: until });
    expect(answerTurn(list, first.shown, until)).toEqual({ shown: { id: 'b', since: until }, due: Infinity });
    // What it showed is gone: the newest.
    expect(answerTurn(list.slice(1), first.shown, 1200).shown).toEqual({ id: 'b', since: 1200 });
  });
});
