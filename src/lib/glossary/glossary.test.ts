import { describe, expect, it } from 'vitest';
import {
  addGlossaryEntry,
  MAX_GLOSSARY_ENTRIES,
  normalizeGlossaryEntries,
  normalizeRecognitionText,
  normalizeTranslationText,
  termsIn,
  withGlossary,
  withTerms,
} from './glossary';

describe('glossary', () => {
  it('keeps one row per term, and a row added again is that row', () => {
    const current = normalizeGlossaryEntries([{ id: 'one', source: 'VRChat', target: '', aliases: [] }, { source: 'vrchat' }]);
    expect(current).toEqual([{ id: 'one', source: 'VRChat', target: 'VRChat', aliases: [] }]);
    expect(addGlossaryEntry(current, { source: 'vrchat', target: 'VR Chat', aliases: ['V R Chat'] })).toMatchObject([{ id: 'one', source: 'vrchat', target: 'VR Chat', aliases: ['V R Chat'] }]);
    expect(addGlossaryEntry(current, { source: 'Sokuji' })).toMatchObject([{ id: 'one' }, { source: 'Sokuji', target: 'Sokuji' }]);
  });

  it('holds the table to its size', () => {
    const rows = Array.from({ length: MAX_GLOSSARY_ENTRIES + 5 }, (_, i) => ({ source: `Term${i}` }));
    expect(normalizeGlossaryEntries(rows)).toHaveLength(MAX_GLOSSARY_ENTRIES);
  });

  it('finds the terms of a sentence either way, its aliases included, and asks in the model\'s form', () => {
    const snapshot = { entries: [
      { id: '1', source: 'Rizum', target: 'Rizum', aliases: ['リズム'] },
      { id: '2', source: 'インスタンス', target: '房间', aliases: [] },
    ] } as const;
    expect(termsIn('リズムさんがインスタンスを開けた', snapshot, 'zh-CN')).toEqual([['リズム', 'Rizum'], ['インスタンス', '房间']]);
    expect(termsIn('把房间开好了', snapshot, 'ja')).toEqual([['房间', 'インスタンス']]);
    expect(termsIn('こんにちは', snapshot, 'zh-CN')).toEqual([]);
    // The rendering is Chinese: it has no place in English. A name in Latin letters does.
    expect(termsIn('リズムさんがインスタンスを開けた', snapshot, 'en')).toEqual([['リズム', 'Rizum']]);
    expect(withTerms('翻译：{{TEXT}}', [['リズム', 'Rizum']])).toBe('参考下面的翻译：\nリズム 翻译成 Rizum\n\n翻译：{{TEXT}}');
    expect(withTerms('翻译：{{TEXT}}', [])).toBe('翻译：{{TEXT}}');
  });

  it('normalizes recognition aliases and translation terms longest first', () => {
    const snapshot = { entries: [
      { id: '1', source: 'VRChat', target: 'VR Chat', aliases: ['V R Chat'] },
      { id: '2', source: 'Rizum', target: 'Rizum', aliases: [] },
    ] } as const;
    expect(normalizeRecognitionText('I use V R Chat with Rizum.', snapshot)).toBe('I use VRChat with Rizum.');
    expect(normalizeTranslationText('欢迎来到 VRChat。', snapshot)).toBe('欢迎来到 VR Chat。');
    expect(withGlossary('Translate.', snapshot)).toContain('VRChat → VR Chat');
  });

  it('takes a Latin term as a whole word, and a term in a script without spaces anywhere', () => {
    const snapshot = { entries: [
      { id: '1', source: 'art', target: '美术', aliases: ['Mia'] },
      { id: '2', source: '小明', target: 'Ming', aliases: ['晓明'] },
    ] } as const;
    expect(normalizeRecognitionText('Miami and Mia', snapshot)).toBe('Miami and art');
    expect(normalizeRecognitionText('晓明来了', snapshot)).toBe('小明来了');
    expect(normalizeTranslationText('开始 start 和 art', snapshot)).toBe('开始 start 和 美术');
  });

  it('applies a rendering only to a translation in the writing it belongs to: an entry has no direction', () => {
    const snapshot = { entries: [
      { id: '1', source: 'Alice', target: '爱丽丝', aliases: [] },
      { id: '2', source: '糖豆', target: 'Tangdou', aliases: [] },
    ] } as const;
    expect(normalizeTranslationText('Alice said hello', snapshot)).toBe('Alice said hello');
    expect(normalizeTranslationText('Alice 说你好', snapshot)).toBe('爱丽丝 说你好');
    expect(normalizeTranslationText('糖豆说你好', snapshot)).toBe('糖豆说你好');
  });

  it('does not expand a target that already contains its source term', () => {
    const snapshot = { entries: [{ id: '1', source: 'AI', target: 'AI assistant', aliases: [] }] } as const;
    expect(normalizeTranslationText('AI assistant is ready.', snapshot)).toBe('AI assistant is ready.');
    expect(normalizeTranslationText('AI is ready.', snapshot)).toBe('AI assistant is ready.');
  });
});

