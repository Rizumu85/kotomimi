import { describe, expect, it } from 'vitest';
import { cutAt, letters, restFrom } from './sentenceCut';

describe('where a stretch still being heard may be cut', () => {
  it('is past a finished sentence once a good deal more has been said after it', () => {
    // Ten letters on: about two seconds. The sentence is then no longer the recognizer's newest words.
    const text = 'でこの季節のものなんだっけ？そうだね、やっぱりお正';
    expect(text.slice(0, cutAt(text))).toBe('でこの季節のものなんだっけ？');
  });

  it('is nowhere while little has been said after the sentence: its last words may yet be rewritten, and what is left would be a scrap', () => {
    expect(cutAt('でこの季節のものなんだっけ？')).toBe(-1);
    expect(cutAt('でこの季節のものなんだっけ？そ')).toBe(-1);
    // Two letters used to be enough: "柄的に。" was then left to be closed alone, and came back untranslated (2026-10-06).
    expect(cutAt('でこの季節のものなんだっけ？そうだね、やっぱり')).toBe(-1);
    expect(cutAt('まだ途中で、何も終わっていない')).toBe(-1);
    expect(cutAt('')).toBe(-1);
  });

  it('takes every finished sentence there is at once, up to the last that enough follows', () => {
    const text = 'そうだね。やっぱりお正月のイメージあるよね。あとはどこぞのお祭りどこ';
    expect(text.slice(0, cutAt(text))).toBe('そうだね。やっぱりお正月のイメージあるよね。');
    // Enough follows the first, but it is too short to stand alone; too little follows the second.
    expect(cutAt('そうだね。やっぱりお正月のイメージあるよね。あとはどこ')).toBe(-1);
  });

  it('leaves a sentence of under two seconds to go with the next, as one caption', () => {
    // Alone, each is a caption gone before it is read.
    expect(cutAt('はい。そうですね、行きましょう。それで')).toBe(-1);
    const text = 'はい。そうですね、行きましょう。それでどこに集まればいいかな';
    expect(text.slice(0, cutAt(text))).toBe('はい。そうですね、行きましょう。');
    const two = 'これで全種かな。あ、もう一種類あるか。はい、そうみたいですね、たぶん';
    expect(two.slice(0, cutAt(two))).toBe('これで全種かな。あ、もう一種類あるか。');
  });

  it('never cuts a run with no sentence end, however long: half a sentence has no verb yet', () => {
    // Cutting such a run at its last comma was tried, and taken out before anyone used it (2026-10-06).
    const run = '昨日は友達と一緒に新宿まで買い物に行ったんですけど、途中で雨が降ってきて、傘を持っていなかったので、近くの喫茶店に入って、しばらく待つことにして';
    expect(cutAt(run)).toBe(-1);
    expect(cutAt('I went to the shop with a friend yesterday, and on the way it started to rain, and since we had no umbrella, we went into a cafe nearby and')).toBe(-1);
  });

  it('reads a period as upstream\u2019s sentence rule does, and wants more letters of a script written with spaces', () => {
    const text = 'I went to see Dr. Smith about it yesterday. Then we walked all the way back home together';
    expect(text.slice(0, cutAt(text))).toBe('I went to see Dr. Smith about it yesterday.');
    // Twenty-eight letters after it, not seven.
    expect(cutAt('I went to see Dr. Smith about it yesterday. Then we')).toBe(-1);
    expect(cutAt('It costs 3.5 dollars and I think that is far too much for what it is')).toBe(-1);
    // And twenty-eight before: "Yes. I see." is not cut after either.
    expect(cutAt('Yes. I see. So what are we going to do about all of this now')).toBe(-1);
  });

  it('keeps the marks that close a sentence with it', () => {
    const text = '「もう行くの？」と聞きました。それから一緒に駅まで歩きました';
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

  it('is found by what the closed text ended with where the recognizer rewrote its letters', () => {
    // Both from eight minutes of talk, 2026-10-06. A word came in front and two became shorter: by a count of letters
    // alone the place came out two letters late.
    const closed = '一応ちょっとあれは飲んどいた方がいいか。飲んどいた方がいいか。';
    const final = '利用一応ちょっとあれ飲んだ方がいいかあ飲んだ方がいいかあのみでの上機なので結構言います';
    expect(final.slice(restFrom(final, closed))).toBe('あのみでの上機なので結構言います');
    // A stutter came in: the closed sentence's end is still there, a little later.
    const drunk = '空っぽにしといた方がいいかも。酔ったら気持ち悪くなるじゃないですか。';
    const heard = '空っぽにしといた方がいいかも。よっよったら気持ち悪くなるじゃないですか。ちょっとそう、大丈夫';
    expect(heard.slice(restFrom(heard, drunk))).toBe('ちょっとそう、大丈夫');
    // The end itself rewritten: by the count of letters, as before.
    expect('今日は寒いよ明日は晴れる'.slice(restFrom('今日は寒いよ明日は晴れる', '今日は寒いね。'))).toBe('明日は晴れる');
  });

  it('is the end where the text now holds no more than was closed', () => {
    expect(restFrom('今日は寒い', '今日は寒いね。')).toBe(5);
  });

  it('counts letters and digits only', () => {
    expect(letters('今日は、3時！ ok?')).toBe(7);
  });
});
