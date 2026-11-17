import { describe, expect, it } from 'vitest';
import { runawayAt, tokensFor } from './runaway';

const cut = (answer: string, sentence: string) => { const at = runawayAt(answer, sentence); return at < 0 ? null : answer.slice(0, at); };

describe('a translation that has lost its way (fork)', () => {
  // The sentence it happened on (2026-11-16): 19 letters, answered with ゴロ five hundred times.
  const GURGLE = '咕噜咕噜咕噜噜咕噜咕噜噜噜咕噜咕噜咕噜';

  it('is cut once its repeating end has outgrown the sentence, to about the sentence’s own length', () => {
    // Within its room (three letters for each of the sentence’s, and twenty): not yet.
    expect(cut('ゴロ'.repeat(38), GURGLE)).toBeNull();
    expect(cut('ゴロ'.repeat(39), GURGLE)).toBe('ゴロ'.repeat(9));
    expect(cut('ゴロ'.repeat(511) + 'ゴ', GURGLE)).toBe('ゴロ'.repeat(9));
  });

  it('keeps what came before the repeating, and three times the thing repeated at least', () => {
    // The repeating begins where its letters first come round again: at the す of ます here.
    expect(cut(`大丈夫だと思います${'です'.repeat(60)}`, 'I think it is fine')).toBe('大丈夫だと思いますですですですですで');
    expect(cut('ありがとう、'.repeat(30), '谢谢')).toBe('ありがとう、'.repeat(3));
  });

  it('counts letters, not their halves', () => {
    expect(cut('😀'.repeat(100), 'ha')).toBe('😀'.repeat(3));
  });

  it('leaves alone a sound really made at length, laughter, and an answer that is only long', () => {
    expect(cut('あ'.repeat(70), '啊'.repeat(60))).toBeNull();
    expect(cut('ははははははははははは', '哈哈哈哈哈哈哈哈哈哈')).toBeNull();
    const long = 'それは昨日の会議で決まったことで、来週までに全員が資料を読んでおく必要があります。場所は三階の会議室で、時間は午後二時からです。';
    expect(cut(long, '这是昨天开会定的')).toBeNull();
    // A repeating end too short to be a loop.
    expect(cut(`${long}はいはいはい`, '好')).toBeNull();
  });

  it('gives a translation six tokens for each letter of its sentence, and forty-eight', () => {
    expect(tokensFor(GURGLE)).toBe(162);
    expect(tokensFor('')).toBe(48);
  });
});
