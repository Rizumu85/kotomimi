import { describe, it, expect } from 'vitest';
import { createFollower, followWeight } from './follow';

describe('follow — the language the user is answered in follows the other side', () => {
  it('weighs a letter of a script written without spaces as about a word', () => {
    expect(followWeight('はい')).toBe(6);
    expect(followWeight('ok!')).toBe(2);
    expect(followWeight('안녕하세요')).toBe(15);
  });

  it('moves on one sentence in another language: the one the other side was last heard in', () => {
    const f = createFollower('ja', 'zh-CN');
    expect(f.heard('안녕하세요 반가워요', 'ko')).toBe('ko');
    f.moved('ko');
    expect(f.now).toBe('ko');
    expect(f.heard('오늘 날씨가 좋네요', 'ko')).toBeNull();
    expect(f.heard('こんにちは、元気ですか', 'ja')).toBe('ja');
  });

  it('is not moved by a short word, the user’s own language, or an unknown language', () => {
    const f = createFollower('ja', 'zh-CN');
    expect(f.heard('네', 'ko')).toBeNull();
    expect(f.heard('ok', 'en')).toBeNull();
    expect(f.heard('你好你好你好你好', 'zh')).toBeNull();
    expect(f.heard('something long enough here', 'auto')).toBeNull();
  });

  it('does not go again where the user’s speech could not be translated', () => {
    const f = createFollower('ja', 'zh-CN');
    expect(f.heard('오늘 날씨가 좋네요', 'ko')).toBe('ko');
    f.unfit('ko');
    expect(f.heard('오늘 날씨가 좋네요 정말', 'ko')).toBeNull();
  });

  it('counts afresh from a pair the user picked', () => {
    const f = createFollower('ja', 'zh-CN');
    f.reset('en', 'zh-CN');
    expect(f.now).toBe('en');
    expect(f.heard('I was wondering about this world', 'en')).toBeNull();
    expect(f.heard('오늘 날씨가 좋네요', 'ko')).toBe('ko');
  });

  it('follows only into the languages it is given, where a provider gives some', () => {
    const f = createFollower('ja', 'zh-CN', ['ja', 'ko']);
    expect(f.heard('I was wondering whether you have been to this world before today', 'en')).toBeNull();
    expect(f.heard('오늘 날씨가 좋네요', 'ko')).toBe('ko');
  });
});
