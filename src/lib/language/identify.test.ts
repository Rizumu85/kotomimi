import { describe, expect, it } from 'vitest';
import { identifyLanguage, scriptLanguage, textLanguage } from './identify';

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
