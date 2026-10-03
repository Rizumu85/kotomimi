import { describe, expect, it } from 'vitest';
import { coachPrompt, coachTemplateLanguage, languageNameIn } from './coachPrompt';

describe('a language\'s name in another language', () => {
  it('is the platform\'s own name, and the code itself when there is none', () => {
    expect(languageNameIn('ja', 'zh-CN')).toBe('日语');
    expect(languageNameIn('zh-CN', 'zh-CN')).toContain('中文');
    expect(languageNameIn('ja', 'en')).toBe('Japanese');
    expect(languageNameIn('zh_CN', 'en')).toContain('Chinese');
    expect(languageNameIn('not a code', 'en')).toBe('not a code');
  });
});

describe('the grammar-feedback prompt, chosen by language', () => {
  it('is written in the learner\'s own language when there is a template for it, else in English', () => {
    expect(coachTemplateLanguage('zh-CN')).toBe('zh');
    expect(coachTemplateLanguage('zh-TW')).toBe('zh');
    expect(coachTemplateLanguage('en-US')).toBe('en');
    expect(coachTemplateLanguage('ko')).toBe('en');
  });

  it('tells a Chinese speaker practising Japanese in Chinese: both languages named in Chinese, what to look for in Japanese, the ✓ and the two lines', () => {
    const { system } = coachPrompt('ja', 'zh-CN');
    expect(system).toContain('你是一位日语口语教练');
    expect(system).toContain('中文');
    expect(system).toContain('助词（は、が、を、に、で）');
    expect(system).toContain('只回答一个符号：✓');
    expect(system).not.toMatch(/\{\{[A-Z]+\}\}/);
    // Nothing of the examples in the instructions: they are turns.
    expect(system).not.toContain('昨日、友達と映画を見ます。');
  });

  it('switches what to look for with the language practised', () => {
    expect(coachPrompt('en', 'zh-CN').system).toContain('冠词（a、an、the）');
    expect(coachPrompt('ko', 'zh-CN').system).toContain('은/는');
    expect(coachPrompt('ru', 'zh-CN').system).toContain('名词和形容词的格');
    // A language with no hints: the rules alone, no hole left.
    const thai = coachPrompt('th', 'zh-CN').system;
    expect(thai).toContain('泰语');
    expect(thai).not.toContain('重点检查');
    expect(thai).not.toMatch(/\n\n/);
  });

  it('switches the template with the native language: an English speaker is told in English', () => {
    const { system, shots } = coachPrompt('ja', 'en');
    expect(system).toContain('You are a Japanese speaking coach');
    expect(system).toContain('native language is English');
    expect(shots[0].answer).toBe('昨日、友達と映画を見ました。\n"昨日" is in the past, so the verb needs the past form "見ました".');
  });

  it('reads a native language with no template in English, naming that language as the one to explain in', () => {
    const { system } = coachPrompt('ja', 'ko');
    expect(system).toContain('native language is Korean');
    expect(system).toContain('one short sentence in Korean');
  });

  it('carries worked examples as chat turns in the shape the row shows: two lines for a mistake, a bare ✓ for none', () => {
    const { shots } = coachPrompt('ja', 'zh-CN');
    expect(shots).toEqual([
      { said: '昨日、友達と映画を見ます。', answer: '昨日、友達と映画を見ました。\n“昨日”说的是过去的事，动词要用过去式“見ました”。' },
      { said: '今日は天気がいいですね。', answer: '✓' },
      { said: '私は学校を行きます。', answer: '私は学校に行きます。\n表示去的目的地要用助词“に”，不能用“を”。' },
    ]);
    expect(coachPrompt('en', 'zh-CN').shots.map((s) => s.answer.split('\n')[0])).toEqual(['Yesterday I went to the cinema with my friend.', '✓']);
    // No examples for a pair that has none.
    expect(coachPrompt('ru', 'zh-CN').shots).toEqual([]);
  });

  it('gives way to the user\'s own prompt, which still follows the pair through its placeholders and goes up with no examples', () => {
    const own = coachPrompt('ja', 'zh-CN', '  用{{NATIVE}}指出这句{{SPOKEN}}的敬语问题。 ');
    expect(own).toEqual({ system: '用中文（中国）指出这句日语的敬语问题。'.replace('中文（中国）', languageNameInZh()), shots: [] });
    expect(coachPrompt('ko', 'zh-CN', '检查{{SPOKEN}}').system).toBe('检查韩语');
    // Blank is no prompt of the user's.
    expect(coachPrompt('ja', 'zh-CN', '   ').shots).toHaveLength(3);
  });
});

/** The platform's name for zh-CN in zh-CN, whatever this ICU spells it. */
function languageNameInZh(): string {
  return languageNameIn('zh-CN', 'zh-CN');
}
