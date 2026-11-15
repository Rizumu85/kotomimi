import { describe, expect, it } from 'vitest';
import { heardAs, settleHinted } from './hinted';

describe('a dictionary word in a reading, against the same stretch read without the dictionary (fork)', () => {
  it('is heard where the plain reading sounds like it, in its script or another', () => {
    expect(heardAs('糖豆', '唐豆')).toBe(true);
    expect(heardAs('Rizum', 'リズム')).toBe(true);
    expect(heardAs('Rizum', 'リスム')).toBe(true);
    expect(heardAs('Rizum', '里祖姆')).toBe(true);
    expect(heardAs('Jackal', 'ジャッカル')).toBe(true);
    expect(heardAs('VRC', 'VRC')).toBe(true);
    // An abbreviation is said letter by letter, and written as it was heard.
    expect(heardAs('VRC', 'VR西')).toBe(true);
    expect(heardAs('AI', '诶爱')).toBe(true);
    // A longer name may be off by a sound.
    expect(heardAs('Nanachiki', 'ななちき')).toBe(true);
    expect(heardAs('Nanachiki', 'ナナチ')).toBe(true);
  });

  it('is not heard where the plain reading has other words there', () => {
    expect(heardAs('Nanachiki', '那些短剧')).toBe(false);
    // What Qwen3-ASR 0.6B read without the dictionary where it had written the name (a recording, 2026-11-14).
    expect(heardAs('Nanachiki', '中国')).toBe(false);
    expect(heardAs('Nanachiki', '因为我')).toBe(false);
    expect(heardAs('糖豆', '嗯好吧')).toBe(false);
    expect(heardAs('Jackal', 'それは')).toBe(false);
    expect(heardAs('Rizum', '')).toBe(false);
  });

  it('gives the place back to the plain reading, and leaves a word that was heard as the dictionary writes it', () => {
    expect(settleHinted('Nanachiki非常非常恐怖，每天更新几千部。', [{ start: 0, end: 9, plain: '那些短剧' }])).toBe('那些短剧非常非常恐怖，每天更新几千部。');
    const said = '今天和糖豆一起去VRC玩了。';
    expect(settleHinted(said, [{ start: 3, end: 5, plain: '唐豆' }, { start: 8, end: 11, plain: 'VRC' }])).toBe(said);
    // Two of them, one heard: only the other gives way.
    expect(settleHinted('Rizum和Jackal来了', [{ start: 0, end: 5, plain: '里祖姆' }, { start: 6, end: 12, plain: '他们' }])).toBe('Rizum和他们来了');
    // A reading of the word alone, over something else.
    expect(settleHinted('糖豆。', [{ start: 0, end: 3, plain: '嗯好吧。' }])).toBe('嗯好吧。');
    expect(settleHinted('糖豆！', [{ start: 0, end: 3, plain: '唐豆！' }])).toBe('糖豆！');
  });
});
