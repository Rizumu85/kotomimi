import { describe, expect, it } from 'vitest';
import { cutAt, letters, restFrom } from './sentenceCut';

describe('where a stretch still being heard may be cut', () => {
  it('is past a finished sentence the speaker has gone on from', () => {
    const text = 'でこの季節のものなんだっけ？そうだね、やっぱり';
    expect(text.slice(0, cutAt(text))).toBe('でこの季節のものなんだっけ？');
  });

  it('is nowhere while the sentence is still the last thing said: its closing mark may yet be rewritten', () => {
    expect(cutAt('でこの季節のものなんだっけ？')).toBe(-1);
    // One letter after it is not yet the speaker going on.
    expect(cutAt('でこの季節のものなんだっけ？そ')).toBe(-1);
    expect(cutAt('まだ途中で、何も終わっていない')).toBe(-1);
    expect(cutAt('')).toBe(-1);
  });

  it('takes every finished sentence there is at once, up to the last', () => {
    const text = 'そうだね。やっぱりお正月のイメージあるよね。あとはどこ';
    expect(text.slice(0, cutAt(text))).toBe('そうだね。やっぱりお正月のイメージあるよね。');
  });

  it('leaves a very short sentence to go with the next', () => {
    // Alone, "はい。" is a caption gone before it is read.
    expect(cutAt('はい。そうですね')).toBe(-1);
    const text = 'はい。そうですね、行きましょう。それで';
    expect(text.slice(0, cutAt(text))).toBe('はい。そうですね、行きましょう。');
  });

  it('reads a period as upstream’s sentence rule does, and wants more letters of a script written with spaces', () => {
    const text = 'I went to see Dr. Smith about it yesterday. Then we';
    expect(text.slice(0, cutAt(text))).toBe('I went to see Dr. Smith about it yesterday.');
    expect(cutAt('It costs 3.5 dollars and')).toBe(-1);
    // Fourteen letters at least: "Yes. I see." is not cut after "Yes.".
    expect(cutAt('Yes. I see what')).toBe(-1);
  });

  it('keeps the marks that close a sentence with it', () => {
    const text = '「もう行くの？」と聞きました。それから';
    expect(text.slice(0, cutAt(text))).toBe('「もう行くの？」と聞きました。');
  });
});

describe('where the rest of a stretch begins once its beginning was closed', () => {
  it('is right after what was closed, where the text still begins with it', () => {
    expect(restFrom('今日は寒いね。明日は', '今日は寒いね。')).toBe(7);
    expect(restFrom('anything', '')).toBe(0);
  });

  it('is found by the letters where the recognizer rewrote the marks or the spacing', () => {
    // A comma came, the full stop became another mark: the same six letters, then the marks that close them.
    const text = '今日は、寒いね！ 明日は晴れる';
    expect(text.slice(restFrom(text, '今日は寒いね。'))).toBe('明日は晴れる');
    const latin = 'Well, I see it now.  Then we go';
    expect(latin.slice(restFrom(latin, 'Well I see it now.'))).toBe('Then we go');
  });

  it('is the end where the text now holds no more than was closed', () => {
    expect(restFrom('今日は寒い', '今日は寒いね。')).toBe(5);
  });

  it('counts letters and digits only', () => {
    expect(letters('今日は、3時！ ok?')).toBe(7);
  });
});
