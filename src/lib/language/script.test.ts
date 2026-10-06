// Fork: the language a sentence is in, as far as its writing says.
import { describe, expect, it } from 'vitest';
import { languageByScript } from './script';

describe('the language a sentence\u2019s writing shows', () => {
  it('is Japanese wherever there is kana, whatever is written around it', () => {
    expect(languageByScript('今日は天気がいいですね')).toBe('ja');
    expect(languageByScript('VRChat で遊ぶ')).toBe('ja');
    expect(languageByScript('ワールド')).toBe('ja');
  });

  it('is Chinese for Han characters with no kana', () => {
    expect(languageByScript('你好，今天天气真不错。')).toBe('zh');
    expect(languageByScript('我们一起拍张照片吧 OK')).toBe('zh');
  });

  it('is the language a script of its own belongs to', () => {
    expect(languageByScript('안녕하세요. 오늘 날씨가 정말 좋네요.')).toBe('ko');
    expect(languageByScript('Привет! Сегодня очень хорошая погода.')).toBe('ru');
    expect(languageByScript('สวัสดีครับ')).toBe('th');
    expect(languageByScript('مرحبا بالعالم')).toBe('ar');
    expect(languageByScript('नमस्ते दुनिया')).toBe('hi');
  });

  it('is the one most of the sentence is written in, where two are mixed', () => {
    expect(languageByScript('Привет, 你好, как дела сегодня')).toBe('ru');
  });

  it('is, for Latin letters, the one whose little words the sentence uses — where they leave no doubt', () => {
    expect(languageByScript('Hello there. The weather is really nice today. I am from the United States and this is my first time in this world.')).toBe('en');
    expect(languageByScript('Hola, buenas tardes. Hoy hace muy buen tiempo. Soy de España y es la primera vez que vengo a este mundo.')).toBe('es');
    expect(languageByScript('Bonjour, je suis très content de vous voir, est-ce que vous avez le temps ?')).toBe('fr');
    expect(languageByScript('Hallo, ich bin heute sehr müde und das ist nicht gut.')).toBe('de');
  });

  it('is not said for a few Latin words, for digits or for nothing: that could be any of dozens', () => {
    expect(languageByScript('Hello there.')).toBeUndefined();
    expect(languageByScript('OK')).toBeUndefined();
    expect(languageByScript('Selamat pagi semuanya apa kabar')).toBeUndefined();
    expect(languageByScript('123 !?')).toBeUndefined();
    expect(languageByScript('')).toBeUndefined();
  });
});

describe('a sentence in the speaker\u2019s own language, not the one they practise', () => {
  it('is known by its writing', async () => {
    const { saidInOwn } = await import('./script');
    // A Chinese speaker practising Japanese.
    expect(saidInOwn('我得更新一下这个软件。', 'zh-CN', 'ja')).toBe(true);
    expect(saidInOwn('昨日映画を見ました。', 'zh-CN', 'ja')).toBe(false);
    // A few characters alone may be either: taken as practice.
    expect(saidInOwn('大丈夫', 'zh-CN', 'ja')).toBe(false);
    expect(saidInOwn('了解。', 'zh-CN', 'ja')).toBe(false);
    // A Japanese speaker practising Chinese: kana is their own; characters alone are the practice.
    expect(saidInOwn('ちょっと待ってね', 'ja', 'zh-CN')).toBe(true);
    expect(saidInOwn('我昨天看了电影。', 'ja', 'zh-CN')).toBe(false);
    // Latin letters: only where the words leave no doubt.
    expect(saidInOwn('I think this is really what you have to do', 'en', 'ja')).toBe(true);
    expect(saidInOwn('OK', 'en', 'ja')).toBe(false);
    // The same language both ways is never "their own instead".
    expect(saidInOwn('你好，今天天气真不错。', 'zh-CN', 'zh-TW')).toBe(false);
  });
});

describe('one stretch of speech, heard twice', () => {
  it('is known by its writing, though two recognizers do not write it alike to the letter', async () => {
    const { sameSpeech } = await import('./script');
    // The other side, heard from the computer's sound and again — worse — through the microphone.
    expect(sameSpeech('そうそうそれが好きなんですよ', 'そうそうそう、それが好きなんですよ。')).toBe(true);
    expect(sameSpeech('今日は天気がいですね', 'こんにちは。今日は天気がいいですね。一緒に写真を撮りませんか？')).toBe(true);
    // What the user said themselves is another sentence.
    expect(sameSpeech('昨日映画を見ました。', 'そうそうそう、それが好きなんですよ。')).toBe(false);
    // A word or two: found whole, or not at all.
    expect(sameSpeech('うん。', 'うん、そうだね。')).toBe(true);
    expect(sameSpeech('はい', 'うん、そうだね。')).toBe(false);
    expect(sameSpeech('', 'うん')).toBe(false);
    expect(sameSpeech('うん', '')).toBe(false);
  });
});
