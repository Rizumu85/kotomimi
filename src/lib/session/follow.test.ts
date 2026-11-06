import { describe, it, expect } from 'vitest';
import { createFollower, followWeight } from './follow';

describe('follow — the language the user is answered in follows the other side', () => {
  it('weighs a letter of a script written without spaces as about a word', () => {
    expect(followWeight('はい')).toBe(6);
    expect(followWeight('ok!')).toBe(2);
    expect(followWeight('안녕하세요')).toBe(15);
  });

  it('moves after two sentences in a row in another language, and not after one', () => {
    const f = createFollower('ja', 'zh-CN');
    expect(f.heard('안녕하세요 반가워요', 'ko')).toBeNull();
    expect(f.heard('오늘 날씨가 좋네요', 'ko')).toBe('ko');
    f.moved('ko');
    expect(f.now).toBe('ko');
  });

  it('moves after one long sentence', () => {
    const f = createFollower('ja', 'zh-CN');
    expect(f.heard('I was wondering whether you have been to this world before today', 'en')).toBe('en');
  });

  it('is not moved by a short word, the user\'s own language, an unknown language, or one between', () => {
    const f = createFollower('ja', 'zh-CN');
    expect(f.heard('네', 'ko')).toBeNull();
    expect(f.heard('네', 'ko')).toBeNull();
    expect(f.heard('你好你好你好你好', 'zh')).toBeNull();
    expect(f.heard('something long enough here', 'auto')).toBeNull();
    expect(f.heard('안녕하세요 반가워요', 'ko')).toBeNull();
    expect(f.heard('こんにちは、元気ですか', 'ja')).toBeNull();
    expect(f.heard('오늘 날씨가 좋네요', 'ko')).toBeNull();
  });

  it('does not go again where the user\'s speech could not be translated', () => {
    const f = createFollower('ja', 'zh-CN');
    f.heard('안녕하세요 반가워요', 'ko');
    expect(f.heard('오늘 날씨가 좋네요', 'ko')).toBe('ko');
    f.unfit('ko');
    expect(f.heard('오늘 날씨가 좋네요 정말', 'ko')).toBeNull();
  });

  it('counts afresh from a pair the user picked', () => {
    const f = createFollower('ja', 'zh-CN');
    f.heard('안녕하세요 반가워요', 'ko');
    f.reset('en', 'zh-CN');
    expect(f.now).toBe('en');
    expect(f.heard('오늘 날씨가 좋네요', 'ko')).toBeNull();
  });
});
