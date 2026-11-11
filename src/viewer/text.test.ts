// src/viewer/text.test.ts
import { describe, it, expect } from 'vitest';
import type { ViewerEntry } from '../lib/share/types';
import { choiceOptions, defaultChoice, piecesOf, piecesText, sidesFor, validChoice } from './text';

const PAIR = { source: 'ja', target: 'zh-CN' };
const speaker: ViewerEntry = {
  id: 's', leg: 'speaker', t: 1, languages: { source: 'ja', target: 'zh-CN' },
  source: [{ key: 'r:speaker:1:0', text: 'こんにちは', final: true }],
  translation: [{ key: 'r:speaker:2:0', text: '你好', final: true }],
};
const participant: ViewerEntry = {
  id: 'p', leg: 'participant', t: 2, languages: { source: 'zh-CN', target: 'ja' },
  source: [{ key: 'r:participant:1:0', text: '谢谢', final: true }],
  translation: [{ key: 'r:participant:2:0', text: 'ありがとう', final: false }],
};

describe('choices', () => {
  it('offers source, both, target', () => {
    expect(choiceOptions(PAIR)).toEqual([
      { code: 'ja', both: false }, { code: 'zh-CN', both: true }, { code: 'zh-CN', both: false },
    ]);
  });

  it('defaults to the browser language when it is one side, both otherwise', () => {
    expect(defaultChoice(PAIR, ['zh-TW', 'en'])).toEqual({ code: 'zh-CN', both: false });
    expect(defaultChoice(PAIR, ['ja-JP'])).toEqual({ code: 'ja', both: false });
    expect(defaultChoice(PAIR, ['fr'])).toEqual({ code: 'zh-CN', both: true });
  });

  it('falls back to both, target first, when the pair changed under the choice', () => {
    expect(validChoice({ code: 'ja', both: false }, PAIR)).toEqual({ code: 'ja', both: false });
    expect(validChoice({ code: 'ko', both: false }, PAIR)).toEqual({ code: 'zh-CN', both: true });
  });
});

describe('sidesFor', () => {
  it('follows each row when a bilingual speaker uses their other language', () => {
    const entry = {
      ...speaker, languages: { source: 'zh-CN', target: 'ja' },
      source: [{ ...speaker.source[0], language: 'ja' }],
      translation: [{ ...speaker.translation[0], language: 'zh-CN' }],
    };
    expect(sidesFor(entry, 'zh-CN')).toEqual({ primary: entry.translation, secondary: entry.source });
    expect(sidesFor(entry, 'ja')).toEqual({ primary: entry.source, secondary: entry.translation });
  });

  it('selects only the chosen translation when two languages are lit', () => {
    const entry = {
      ...speaker,
      translation: [
        { ...speaker.translation[0], language: 'zh-CN' },
        { key: 'r:speaker:3:0', text: 'Hello', final: true, language: 'en' },
      ],
    };
    expect(sidesFor(entry, 'zh-CN')).toEqual({ primary: [entry.translation[0]], secondary: [...entry.source, entry.translation[1]] });
    expect(sidesFor(entry, 'en').primary).toEqual([entry.translation[1]]);
  });

  it('matches a detected base code, but keeps explicitly different variants apart', () => {
    const entry = { ...speaker, source: [{ ...speaker.source[0], language: 'zh' }], translation: [] };
    expect(sidesFor(entry, 'zh-CN').primary).toEqual(entry.source);
    const mixedTags = { ...entry, translation: [{ ...speaker.translation[0], language: 'zh-CN' }] };
    expect(sidesFor(mixedTags, 'zh-CN').primary).toEqual([...mixedTags.source, ...mixedTags.translation]);
    const variants = {
      ...entry, source: [{ ...entry.source[0], language: 'zh-TW' }],
      translation: [{ ...speaker.translation[0], language: 'zh-CN' }],
    };
    expect(sidesFor(variants, 'zh-CN').primary).toEqual(variants.translation);
  });

  it('picks by language, not by role', () => {
    expect(sidesFor(speaker, 'zh-CN').primary[0].text).toBe('你好');
    expect(sidesFor(participant, 'zh-CN').primary[0].text).toBe('谢谢');
    expect(sidesFor(participant, 'zh-CN').secondary[0].text).toBe('ありがとう');
    expect(sidesFor(speaker, 'ja').primary[0].text).toBe('こんにちは');
  });

  it('reads an auto-detected source as the other side of the target', () => {
    const auto = { ...speaker, languages: { source: 'auto', target: 'zh-CN' } };
    expect(sidesFor(auto, 'auto').primary[0].text).toBe('こんにちは');
  });
});

describe('pieces', () => {
  it('tiles rows of one segment, spaces Latin segments, keeps CJK tight, and can hide unfinished text', () => {
    const rows = [
      { key: 'r:s:1:0', text: 'Hello ', final: true },
      { key: 'r:s:1:1', text: 'there.', final: true },
      { key: 'r:s:2:0', text: 'Next', final: false },
    ];
    expect(piecesText(piecesOf(rows, false))).toBe('Hello there. Next');
    expect(piecesOf(rows, false).map((p) => p.final)).toEqual([true, false]);
    expect(piecesText(piecesOf(rows, true))).toBe('Hello there.');
    expect(piecesText(piecesOf([{ key: 'a:1:0', text: '你好', final: true }, { key: 'a:2:0', text: '世界', final: true }], false))).toBe('你好世界');
  });
});
