import { describe, expect, it } from 'vitest';
import {
  mergeGlossaryEntries,
  normalizeGlossaryEntries,
  normalizeRecognitionText,
  normalizeTranslationText,
  parseGlossaryClipboard,
  withGlossary,
} from './glossary';

describe('glossary', () => {
  it('imports one-column names and tab-separated translation pairs', () => {
    expect(parseGlossaryClipboard('Rizum\nVRChat\tVR Chat\tV R Chat,VRChat\n# comment\n')).toEqual([
      { source: 'Rizum', target: 'Rizum', aliases: [] },
      { source: 'VRChat', target: 'VR Chat', aliases: ['V R Chat', 'VRChat'] },
    ]);
  });

  it('imports VRCX CSV rows with stable UserID values and quoted fields', () => {
    expect(parseGlossaryClipboard('UserID,DisplayName,Memo\nusr_1,"Friend, One","note\nwith comma"\nusr_2,"Friend ""Two""",memo')).toEqual([
      { source: 'Friend, One', target: 'Friend, One', aliases: [], externalId: 'usr_1' },
      { source: 'Friend "Two"', target: 'Friend "Two"', aliases: [], externalId: 'usr_2' },
    ]);
  });

  it('normalizes, deduplicates and merges rows by source', () => {
    const current = normalizeGlossaryEntries([{ id: 'one', source: 'VRChat', target: 'VRChat', aliases: [], enabled: false }]);
    expect(mergeGlossaryEntries(current, [{ source: 'VRChat', target: 'VR Chat', aliases: ['V R Chat'] }, { source: 'Sokuji' }]).entries).toMatchObject([
      { id: 'one', source: 'VRChat', target: 'VR Chat', aliases: ['V R Chat'], enabled: false },
      { source: 'Sokuji', target: 'Sokuji' },
    ]);
  });

  it('updates VRCX entries by UserID without adding duplicates on repeat imports', () => {
    const imported = parseGlossaryClipboard('UserID,DisplayName,Memo\nusr_1,Tangdou,\nusr_2,Tangdou,');
    const first = mergeGlossaryEntries([], imported);
    expect(first.result).toMatchObject({ added: 2, updated: 0 });
    const second = mergeGlossaryEntries(first.entries, imported);
    expect(second.entries).toHaveLength(2);
    expect(second.result).toMatchObject({ added: 0, updated: 0 });

    const renamed = parseGlossaryClipboard('UserID,DisplayName,Memo\nusr_1,Tangdou Updated,');
    const updated = mergeGlossaryEntries(first.entries, renamed).entries;
    expect(updated.find((entry) => entry.externalId === 'usr_1')).toMatchObject({ source: 'Tangdou Updated' });
  });

  it('keeps what the user wrote on a friend when a VRCX list is imported again', () => {
    const current = normalizeGlossaryEntries([
      { id: 'one', externalId: 'usr_1', source: 'Tangdou', target: '糖豆', aliases: ['Tang'], enabled: true },
      { id: 'two', externalId: 'usr_2', source: 'Mia', target: 'Mia', aliases: ['ミア'], enabled: true },
    ]);
    const { entries } = mergeGlossaryEntries(current, parseGlossaryClipboard('UserID,DisplayName,Memo\nusr_1,Tangdou New,\nusr_2,Mia New,'));
    expect(entries).toMatchObject([
      { source: 'Tangdou New', target: '糖豆', aliases: ['Tang'] },
      { source: 'Mia New', target: 'Mia New', aliases: ['ミア'] },
    ]);
  });

  it('normalizes recognition aliases and translation terms longest first', () => {
    const snapshot = { entries: [
      { id: '1', source: 'VRChat', target: 'VR Chat', aliases: ['V R Chat'], enabled: true },
      { id: '2', source: 'Rizum', target: 'Rizum', aliases: [], enabled: true },
    ] } as const;
    expect(normalizeRecognitionText('I use V R Chat with Rizum.', snapshot)).toBe('I use VRChat with Rizum.');
    expect(normalizeTranslationText('欢迎来到 VRChat。', snapshot)).toBe('欢迎来到 VR Chat。');
    expect(withGlossary('Translate.', snapshot)).toContain('VRChat → VR Chat');
  });

  it('takes a Latin term as a whole word, and a term in a script without spaces anywhere', () => {
    const snapshot = { entries: [
      { id: '1', source: 'art', target: '美术', aliases: ['Mia'], enabled: true },
      { id: '2', source: '小明', target: 'Ming', aliases: ['晓明'], enabled: true },
    ] } as const;
    expect(normalizeRecognitionText('Miami and Mia', snapshot)).toBe('Miami and art');
    expect(normalizeRecognitionText('晓明来了', snapshot)).toBe('小明来了');
    expect(normalizeTranslationText('开始 start 和 art', snapshot)).toBe('开始 start 和 美术');
  });

  it('applies a rendering only to a translation in the writing it belongs to: an entry has no direction', () => {
    const snapshot = { entries: [
      { id: '1', source: 'Alice', target: '爱丽丝', aliases: [], enabled: true },
      { id: '2', source: '糖豆', target: 'Tangdou', aliases: [], enabled: true },
    ] } as const;
    expect(normalizeTranslationText('Alice said hello', snapshot)).toBe('Alice said hello');
    expect(normalizeTranslationText('Alice 说你好', snapshot)).toBe('爱丽丝 说你好');
    expect(normalizeTranslationText('糖豆说你好', snapshot)).toBe('糖豆说你好');
  });

  it('tells a provider what the user wrote before a friends list', () => {
    const friends = Array.from({ length: 100 }, (_, i) => ({ id: `f${i}`, source: `Friend${i}`, target: `Friend${i}`, aliases: [], enabled: true }));
    const prompt = withGlossary('Translate.', { entries: [...friends, { id: 'mine', source: 'VRChat', target: 'VR Chat', aliases: [], enabled: true }] });
    expect(prompt).toContain('VRChat → VR Chat');
  });

  it('does not expand a target that already contains its source term', () => {
    const snapshot = { entries: [{ id: '1', source: 'AI', target: 'AI assistant', aliases: [], enabled: true }] } as const;
    expect(normalizeTranslationText('AI assistant is ready.', snapshot)).toBe('AI assistant is ready.');
    expect(normalizeTranslationText('AI is ready.', snapshot)).toBe('AI assistant is ready.');
  });
});

