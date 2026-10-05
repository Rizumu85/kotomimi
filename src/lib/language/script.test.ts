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
