import { describe, expect, it } from 'vitest';
import { correctionOf, type CorrectionPart } from './correction';

const marked = (parts: readonly CorrectionPart[]) => parts.map((p) => (p.kind === 'gone' ? `[-${p.text}]` : p.kind === 'added' ? `[+${p.text}]` : p.text)).join('');

describe('correctionOf', () => {
  it('strikes what goes and writes in what comes, word by word, with the reason after', () => {
    const c = correctionOf('昨日、映画を見ます。', '昨日、映画を見ました。\n动词时态应与“昨日”一致，使用过去式。', 'ja');
    expect(c?.fine).toBe(false);
    expect(marked(c!.parts)).toBe('昨日、映画を見[-ます][+ました]。');
    expect(c?.why).toBe('动词时态应与“昨日”一致，使用过去式。');
  });

  it('marks a word put in, and one taken out', () => {
    expect(marked(correctionOf('I goes to school yesterday.', 'I went to school yesterday.\nPast tense.', 'en')!.parts)).toBe('I [-goes][+went] to school yesterday.');
    expect(marked(correctionOf('明日は友達公園に行きます。', '明日は友達と公園に行きます。', 'ja')!.parts)).toBe('明日は友達[+と]公園に行きます。');
  });

  it('keeps the end of the sentence where the correction left its mark off', () => {
    expect(marked(correctionOf('この本はとても面白いでした。', 'この本はとても面白かったです\n形容词的过去式。', 'ja')!.parts)).toBe('この本はとても[-面白いでした][+面白かったです]。');
  });

  it('joins two changes a single kept letter stands between', () => {
    const c = correctionOf('私はりんごが好きだです。', '私はりんごが好きです。', 'ja');
    expect(c?.parts.filter((p) => p.kind !== 'same').length).toBeLessThanOrEqual(2);
  });

  it('is the sentence as it was, right, where the feedback is a tick or changes nothing', () => {
    expect(correctionOf('今日は天気がいいですね。', '✓', 'ja')).toEqual({ parts: [{ text: '今日は天気がいいですね。', kind: 'same' }], why: '', fine: true });
    expect(correctionOf('今日は天気がいいですね。', '今日は天気がいいですね。\n很自然。', 'ja')?.fine).toBe(true);
  });

  it('gives no correction where the answer is another sentence altogether, or nothing', () => {
    expect(correctionOf('昨日、映画を見ます。', 'あなたは何を言いたいですか？', 'ja')).toBeNull();
    expect(correctionOf('昨日、映画を見ます。', '', 'ja')).toBeNull();
    expect(correctionOf('', '✓', 'ja')).toBeNull();
  });
});
