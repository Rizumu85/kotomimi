import { describe, expect, it } from 'vitest';
import { CLIP_LEAST_MORE_S, CLIP_LEAST_S, CLIP_MOST_S, CLIP_MOST_WITH_WORDS_S, CLIP_RATE, clipProblem, clipWav, levelled, prepared, readAloud, secondsOf, trimmed } from './clip';

/** `seconds` of a steady tone at a level, with quiet before and after. */
function spoken(seconds: number, { level = 8000, before = 0, after = 0 } = {}): Int16Array {
  const pcm = new Int16Array(Math.round((before + seconds + after) * CLIP_RATE));
  const from = Math.round(before * CLIP_RATE);
  for (let i = 0; i < Math.round(seconds * CLIP_RATE); i += 1) pcm[from + i] = Math.round(level * Math.sin(i / 12));
  return pcm;
}

describe('a recording made ready to be a voice', () => {
  it('loses the quiet before the first word and after the last, but for a breath', () => {
    const clip = trimmed(spoken(4, { before: 1.5, after: 2 }));
    expect(secondsOf(clip)).toBeGreaterThan(4);
    expect(secondsOf(clip)).toBeLessThan(4.4);
    // Nothing but quiet: left as it is, to be told apart as silent.
    expect(trimmed(new Int16Array(CLIP_RATE))).toHaveLength(CLIP_RATE);
  });

  it('is brought to one level, a quiet microphone\'s and a loud one\'s alike', () => {
    const peak = (pcm: Int16Array) => pcm.reduce((most, sample) => Math.max(most, Math.abs(sample)), 0);
    expect(peak(levelled(spoken(3, { level: 900 })))).toBeGreaterThan(29000);
    expect(peak(levelled(spoken(3, { level: 30000 })))).toBeLessThan(30000);
    expect(peak(levelled(new Int16Array(100)))).toBe(0);
  });

  it('is cut to what is of use where its words are not known, and kept whole where they are', () => {
    expect(secondsOf(prepared(spoken(40), false))).toBeCloseTo(CLIP_MOST_S, 1);
    expect(secondsOf(prepared(spoken(40), true))).toBeGreaterThan(39);
  });

  it('says why it cannot be a voice: silent, too short, or too long to be read with its words', () => {
    expect(clipProblem(prepared(new Int16Array(CLIP_RATE * 5), true), true)).toBe('silent');
    // A room with nobody speaking, and a click in it: not levelled up into a voice that is too short.
    expect(clipProblem(prepared(spoken(0.2, { level: 300, before: 2, after: 2 }), true), true)).toBe('silent');
    expect(clipProblem(prepared(spoken(CLIP_LEAST_S - 1), true), true)).toBe('too_short');
    // A voice's recording more, in another language, is only spoken on from: shorter will do.
    expect(clipProblem(prepared(spoken(CLIP_LEAST_S - 1), true), true, CLIP_LEAST_MORE_S)).toBeNull();
    expect(clipProblem(prepared(spoken(CLIP_MOST_WITH_WORDS_S + 2), true), true)).toBe('too_long');
    // The same recording with no words is only heard, not read through: its length is no matter.
    expect(clipProblem(prepared(spoken(CLIP_MOST_WITH_WORDS_S + 2), false), false)).toBeNull();
    expect(clipProblem(prepared(spoken(9, { before: 1, after: 1 }), true), true)).toBeNull();
  });

  it('is written as a 16-bit mono WAV at its rate', () => {
    const bytes = clipWav(Int16Array.from([1, -2, 300]));
    const view = new DataView(bytes.buffer);
    expect(String.fromCharCode(...bytes.subarray(0, 4), ...bytes.subarray(8, 12))).toBe('RIFFWAVE');
    expect([view.getUint16(20, true), view.getUint16(22, true), view.getUint32(24, true), view.getUint16(34, true), view.getUint32(40, true)]).toEqual([1, 1, CLIP_RATE, 16, 6]);
    expect([view.getInt16(44, true), view.getInt16(46, true), view.getInt16(48, true)]).toEqual([1, -2, 300]);
  });
});

describe('the sentence read aloud for a recording', () => {
  it('is in the reader\'s language where there is one, and in English for any other', () => {
    expect(readAloud('zh-CN')).toMatchObject({ language: 'zh' });
    expect(readAloud('ja').text).toMatch(/[ぁ-ん]/);
    expect(readAloud('sw')).toMatchObject({ language: 'en' });
    expect(readAloud('constructor')).toMatchObject({ language: 'en' });
  });

  it('is a shorter one for a recording more, in another language, in every language there is a long one in', () => {
    for (const code of ['zh', 'ja', 'en', 'ko', 'es', 'fr', 'de', 'ru', 'pt', 'it']) {
      const long = readAloud(code);
      const short = readAloud(code, 'short');
      expect(long.language).toBe(code);
      expect(short.language).toBe(code);
      expect(short.text.length).toBeLessThan(long.text.length * 0.75);
      // Statements read calmly: nothing asked, nothing exclaimed.
      expect(`${long.text}${short.text}`).not.toMatch(/[?!？！]/);
    }
  });
});
