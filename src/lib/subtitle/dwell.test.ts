import { describe, expect, it } from 'vitest';
import type { Entry, Row } from '../projection/types';
import { answeredOf, HOLD_LEAST_MS, HOLD_MOST_MS, holdMs, nextShown, readMs } from './dwell';

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
  const said = (id: string, leg: 'speaker' | 'participant', source: string, answer = '', language?: string): Entry => ({
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
});
