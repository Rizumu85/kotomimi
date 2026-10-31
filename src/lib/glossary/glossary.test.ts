import { describe, expect, it } from 'vitest';
import {
  buildGlossaryPrompt,
  mergeGlossaryEntries,
  mergeGlossaryEntriesDetailed,
  normalizeGlossaryEntries,
  normalizeRecognitionText,
  normalizeTranslationText,
  parseGlossaryClipboard,
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
    expect(mergeGlossaryEntries(current, [{ source: 'VRChat', target: 'VR Chat', aliases: ['V R Chat'] }, { source: 'Sokuji' }])).toMatchObject([
      { id: 'one', source: 'VRChat', target: 'VR Chat', aliases: ['V R Chat'], enabled: false },
      { source: 'Sokuji', target: 'Sokuji' },
    ]);
  });

  it('updates VRCX entries by UserID without adding duplicates on repeat imports', () => {
    const imported = parseGlossaryClipboard('UserID,DisplayName,Memo\nusr_1,Tangdou,\nusr_2,Tangdou,');
    const first = mergeGlossaryEntriesDetailed([], imported);
    expect(first.result).toMatchObject({ added: 2, updated: 0 });
    const second = mergeGlossaryEntriesDetailed(first.entries, imported);
    expect(second.entries).toHaveLength(2);
    expect(second.result).toMatchObject({ added: 0, updated: 0 });

    const renamed = parseGlossaryClipboard('UserID,DisplayName,Memo\nusr_1,Tangdou Updated,');
    const updated = mergeGlossaryEntries(first.entries, renamed);
    expect(updated.find((entry) => entry.externalId === 'usr_1')).toMatchObject({ source: 'Tangdou Updated' });
  });

  it('keeps a manually chosen target when a VRCX name is refreshed', () => {
    const current = normalizeGlossaryEntries([{ id: 'one', externalId: 'usr_1', source: 'Tangdou', target: '糖豆', aliases: ['Tang'], enabled: true }]);
    const updated = mergeGlossaryEntries(current, parseGlossaryClipboard('UserID,DisplayName,Memo\nusr_1,Tangdou New,'));
    expect(updated).toMatchObject([{ source: 'Tangdou New', target: '糖豆', aliases: ['Tang'] }]);
  });

  it('normalizes recognition aliases and translation terms longest first', () => {
    const snapshot = { entries: [
      { id: '1', source: 'VRChat', target: 'VR Chat', aliases: ['V R Chat'], enabled: true },
      { id: '2', source: 'Rizum', target: 'Rizum', aliases: [], enabled: true },
    ] } as const;
    expect(normalizeRecognitionText('I use V R Chat with Rizum.', snapshot)).toBe('I use VRChat with Rizum.');
    expect(normalizeTranslationText('欢迎来到 VRChat。', snapshot)).toBe('欢迎来到 VR Chat。');
    expect(buildGlossaryPrompt(snapshot)).toContain('VRChat → VR Chat');
  });

  it('does not expand a target that already contains its source term', () => {
    const snapshot = { entries: [{ id: '1', source: 'AI', target: 'AI assistant', aliases: [], enabled: true }] } as const;
    expect(normalizeTranslationText('AI assistant is ready.', snapshot)).toBe('AI assistant is ready.');
    expect(normalizeTranslationText('AI is ready.', snapshot)).toBe('AI assistant is ready.');
  });
});

