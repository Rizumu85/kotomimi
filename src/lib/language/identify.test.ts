import { describe, expect, it } from 'vitest';
import { identifyLanguage, namedByWriting, namedOutside, readAgainIn, scriptLanguage, textLanguage, writtenOutside } from './identify';

describe('identifyLanguage (fork: the language of a sentence the recognizer did not name)', () => {
  it('names a language its writing states, without the detector', () => {
    expect(scriptLanguage('今日は天気がいいですね', ['ja', 'en'])).toBe('ja');
    expect(scriptLanguage('Hello, how are you today?', ['ja', 'en'])).toBe('en');
    expect(scriptLanguage('Привет, как дела?', ['ru', 'en'])).toBe('ru');
    expect(identifyLanguage('今日は天気がいいですね', ['ja', 'en'])).toEqual({ language: 'ja', source: 'script', confidence: 1 });
  });

  it('tells two Latin-letter languages apart when the sentence is long enough', () => {
    // The writing's little words already answer these two; the detector is the fallback for what they miss.
    expect(identifyLanguage('Bonjour, comment allez-vous aujourd hui ?', ['fr', 'en'])).toMatchObject({ language: 'fr' });
    expect(identifyLanguage('Hello, how are you doing today?', ['fr', 'en'])).toMatchObject({ language: 'en' });
    // No stop word either list holds: the statistics are what is left.
    expect(textLanguage('Vraiment magnifique cette exposition photographique', ['fr', 'en'])).toMatchObject({ language: 'fr', source: 'text' });
    expect(textLanguage('Really amazing exhibition photography downtown', ['fr', 'en'])).toMatchObject({ language: 'en', source: 'text' });
  });

  it('leaves a short or doubtful sentence unnamed rather than guessing', () => {
    expect(textLanguage('Bonjour', ['fr', 'en'])).toBeNull();
    expect(identifyLanguage('ok', ['fr', 'en'])).toBeNull();
  });

  it('never answers outside the candidates it was given', () => {
    expect(identifyLanguage('Bonjour, comment allez-vous aujourd hui ?', ['de', 'it'])).toBeNull();
    expect(scriptLanguage('今日は天気がいいですね', ['en', 'fr'])).toBeNull();
  });

  it('takes a regional candidate by its base code', () => {
    expect(scriptLanguage('今日は天気がいいですね', ['ja-JP', 'en-US'])).toBe('ja');
  });

  it('accepts a language outside a pair when no candidates are given, for the other side', () => {
    expect(identifyLanguage('Сегодня хорошая погода и мы собираемся гулять по городу.')?.language).toBe('ru');
  });

  it('uses text detection when a script cannot distinguish the candidate languages', () => {
    const ukrainian = 'Сьогодні гарна погода, і я хочу прогулятися містом.';
    expect(scriptLanguage(ukrainian)).toBeNull();
    expect(scriptLanguage(ukrainian, ['ru', 'uk'])).toBeNull();
    expect(identifyLanguage(ukrainian)).toMatchObject({ language: 'uk', source: 'text' });
    expect(identifyLanguage(ukrainian, ['ru', 'uk'])).toMatchObject({ language: 'uk', source: 'text' });
    expect(identifyLanguage('امروز هوا بسیار خوب است و من میخواهم در شهر قدم بزنم.')).toMatchObject({ language: 'fa', source: 'text' });
    expect(identifyLanguage('Привет')).toBeNull();
  });
});

describe('a reading outside the languages a speaker speaks', () => {
  it('is known by the language the recognizer named, Chinese and Cantonese being one', () => {
    expect(namedOutside('ja', ['zh', 'ko'])).toBe(true);
    expect(namedOutside('ko-KR', ['zh', 'ko'])).toBe(false);
    expect(namedOutside('yue', ['zh', 'ko'])).toBe(false);
    expect(namedOutside(undefined, ['zh', 'ko'])).toBe(false);
    expect(namedOutside('ja', [])).toBe(false);
  });

  it('is known by a script none of them is written in; Latin letters never say so', () => {
    expect(writtenOutside('बारी, आगे', ['zh', 'ko'])).toBe(true);
    expect(writtenOutside('売りががし。', ['zh', 'ko'])).toBe(true);
    expect(writtenOutside('우리 아가씨.', ['zh', 'ko'])).toBe(false);
    expect(writtenOutside('结婚，结婚。', ['ja', 'ko'])).toBe(false);
    expect(writtenOutside('Привет', ['uk', 'en'])).toBe(false);
    expect(writtenOutside('OK, VRC.', ['zh', 'ko'])).toBe(false);
    // A few letters of another script in a sentence of theirs: a name, a title.
    expect(writtenOutside('我最喜欢的歌是さくら', ['zh', 'ko'])).toBe(false);
    expect(writtenOutside('私は学生です', ['zh', 'ko'])).toBe(true);
    // Latin letters count for a speaker of a language written in them: a place named in Han characters is no other language.
    expect(writtenOutside('I love 東京.', ['en', 'fr'])).toBe(false);
    expect(writtenOutside('OK नमस्ते जी', ['en', 'fr'])).toBe(true);
    expect(writtenOutside('OK 東京', ['ko', 'uk'])).toBe(true);
  });

  it('is put right where a language with a script of its own was named for a sentence in Latin letters alone (fork)', () => {
    expect(namedByWriting('Are you wead?', 'zh', ['zh-CN', 'en-US'])).toBe('en');
    expect(namedByWriting('You bet.', 'ja', ['ja', 'en'])).toBe('en');
    // A letter of its script, and it stays: English words in a Chinese sentence.
    expect(namedByWriting('No cap是没开玩笑的意思。', 'zh', ['zh-CN', 'en-US'])).toBe('zh');
    expect(namedByWriting('OK，好的', 'zh', ['zh', 'en'])).toBe('zh');
    // No language of theirs is written in Latin letters, or the recognizer named one that is: as named.
    expect(namedByWriting('OK, VRC.', 'zh', ['zh', 'ja'])).toBe('zh');
    expect(namedByWriting('Bonjour tout le monde', 'en', ['en', 'fr'])).toBe('en');
    expect(namedByWriting('2024', 'zh', ['zh', 'en'])).toBe('zh');
    // Several written in Latin letters: the one its words name, else as named.
    expect(namedByWriting('What is the name of this world?', 'zh', ['zh', 'en', 'fr'])).toBe('en');
    expect(namedByWriting('OK', 'zh', ['zh', 'en', 'fr'])).toBe('zh');
  });

  it('is read again in the others, two at most, never the speaker’s own', () => {
    expect(readAgainIn(['zh', 'ko'])).toEqual(['ko']);
    expect(readAgainIn(['zh', 'ko', 'en', 'ja'])).toEqual(['ko', 'en']);
  });
});
