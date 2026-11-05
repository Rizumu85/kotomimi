import { describe, expect, it } from 'vitest';
import { normalizeRecognitionText } from './glossary';
import { foldBySound } from './sound';
import type { GlossaryEntry } from './types';

const row = (source: string, aliases: string[] = []): GlossaryEntry => ({ id: source, source, aliases });
// The user's own table (2026-11-05).
const TABLE: GlossaryEntry[] = [
  row('VRC'), row('糖豆'), row('吉戾'), row('筱筱', ['小小']), row('悠米露'), row('Nanachiki', ['奶奶ki']), row('Jackal'), row('比翼鸟', ['比鸟']),
  row('Rizum'), row('リズム', ['李子']),
];
const fold = (text: string) => normalizeRecognitionText(text, { entries: TABLE });

describe('the dictionary, by sound', () => {
  it('finds a two-syllable name spelled another way, tone for tone, and leaves a word that only shares the syllables', () => {
    expect(fold('唐豆今天来了吗')).toBe('糖豆今天来了吗');
    // 汤 is tāng, 糖 táng.
    expect(fold('汤豆今天来了吗')).toBe('汤豆今天来了吗');
    expect(fold('晓晓在吗')).toBe('筱筱在吗');
    // 笑笑 is xiào xiào, 筱筱 xiǎo xiǎo: an everyday word keeps its own.
    expect(fold('笑笑就好')).toBe('笑笑就好');
  });

  it('finds a longer name in other tones, or with one sound near its own', () => {
    expect(fold('优米路你好')).toBe('悠米露你好');
    expect(fold('有米露你好')).toBe('悠米露你好');
    // n for l, as many say it.
    expect(fold('优米怒你好')).toBe('悠米露你好');
    // Two syllables off is another word: 游戏奴 (yóu xì nú) differs in xi as well as nu.
    expect(fold('游戏奴你好')).toBe('游戏奴你好');
    expect(fold('我看见比一鸟了')).toBe('我看见比翼鸟了');
  });

  it('lets a mishearing listed once stand for every spelling that sounds like it', () => {
    // 李子 (lǐ zǐ) is listed under リズム: 李紫 sounds the same.
    expect(fold('李紫你在吗')).toBe('リズム你在吗');
    // 李总 does not.
    expect(fold('李总你在吗')).toBe('李总你在吗');
  });

  it('finds a kana name with voicing, a long vowel or small kana set aside', () => {
    expect(fold('リスムさん、こんにちは')).toBe('リズムさん、こんにちは');
    expect(fold('りずむさん、こんにちは')).toBe('リズムさん、こんにちは');
    expect(fold('リズームさん')).toBe('リズムさん');
  });

  it('leaves what has nothing of the words, and what has been through it, as it is', () => {
    for (const text of ['我今天很开心', '今日はいい天気ですね', 'Rizum is here', '糖豆和悠米露来了']) expect(fold(text)).toBe(text);
    const once = fold('唐豆和优米路来了');
    expect(once).toBe('糖豆和悠米露来了');
    expect(fold(once)).toBe(once);
  });

  it('does nothing with no table', () => {
    expect(foldBySound('唐豆来了', [])).toBe('唐豆来了');
  });
});
