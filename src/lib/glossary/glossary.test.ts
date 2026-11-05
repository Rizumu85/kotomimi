import { describe, expect, it } from 'vitest';
import {
  addGlossaryEntry,
  glossaryRecognitionTerms,
  MAX_GLOSSARY_ENTRIES,
  normalizeGlossaryEntries,
  normalizeRecognitionText,
  withGlossary,
} from './glossary';

describe('glossary', () => {
  it('keeps one row per term, and a row added again is that row', () => {
    const current = normalizeGlossaryEntries([{ id: 'one', source: 'VRChat', aliases: [] }, { source: 'vrchat' }]);
    expect(current).toEqual([{ id: 'one', source: 'VRChat', aliases: [] }]);
    expect(addGlossaryEntry(current, { source: 'vrchat', aliases: ['V R Chat'] })).toMatchObject([{ id: 'one', source: 'vrchat', aliases: ['V R Chat'] }]);
    expect(addGlossaryEntry(current, { source: 'Sokuji' })).toMatchObject([{ id: 'one' }, { source: 'Sokuji' }]);
  });

  it('keeps what a row is heard as when the row is added again (fork)', () => {
    const current = normalizeGlossaryEntries([{ id: 'one', source: 'VRChat', aliases: ['V R Chat'] }]);
    expect(addGlossaryEntry(current, { source: 'VRChat' })).toEqual([{ id: 'one', source: 'VRChat', aliases: ['V R Chat'] }]);
    expect(addGlossaryEntry(current, { source: 'vrchat', aliases: ['ブイアール', 'V R Chat'] })).toEqual([{ id: 'one', source: 'vrchat', aliases: ['V R Chat', 'ブイアール'] }]);
  });

  it('keeps an alias that is the term itself: it puts right the case recognition writes (fork)', () => {
    const entries = normalizeGlossaryEntries([{ id: 'one', source: 'VRC', aliases: ['VRC', 'ブイアールシー'] }]);
    expect(entries[0].aliases).toEqual(['VRC', 'ブイアールシー']);
    expect(normalizeRecognitionText('vrc に行こう、VRC だよ', { entries })).toBe('VRC に行こう、VRC だよ');
  });

  it('puts a word\'s own case right with nothing to fill in, and text that has been through it comes out the same (fork)', () => {
    const entries = normalizeGlossaryEntries([{ id: '1', source: 'VRC', aliases: [] }, { id: '2', source: '糖豆豆', aliases: ['糖豆'] }]);
    expect(normalizeRecognitionText('vrc に行く', { entries })).toBe('VRC に行く');
    const once = normalizeRecognitionText('糖豆来了', { entries });
    expect(once).toBe('糖豆豆来了');
    expect(normalizeRecognitionText(once, { entries })).toBe(once);
  });

  it('holds the table to its size', () => {
    const rows = Array.from({ length: MAX_GLOSSARY_ENTRIES + 5 }, (_, i) => ({ source: `Term${i}` }));
    expect(normalizeGlossaryEntries(rows)).toHaveLength(MAX_GLOSSARY_ENTRIES);
  });

  it('folds what is misheard into the term, a Latin word whole and a script without spaces anywhere', () => {
    const snapshot = { entries: [
      { id: '1', source: 'Rizum', aliases: ['リズム', 'Mia'] },
      { id: '2', source: '小明', aliases: ['晓明'] },
    ] } as const;
    expect(normalizeRecognitionText('リズムさん', snapshot)).toBe('Rizumさん');
    expect(normalizeRecognitionText('Miami and Mia', snapshot)).toBe('Miami and Rizum');
    expect(normalizeRecognitionText('晓明来了', snapshot)).toBe('小明来了');
  });

  it('tells a recognizer the terms as written, and a provider\'s instructions too', () => {
    const snapshot = { entries: [{ id: '1', source: 'Rizum', aliases: ['リズム'] }] } as const;
    expect(glossaryRecognitionTerms(snapshot)).toEqual(['Rizum']);
    // A word written with a comma in it is told as its pieces, each once.
    expect(glossaryRecognitionTerms({ entries: [{ id: 'a', source: 'Jackal, ジャカル', aliases: [] }, { id: 'b', source: 'Jackal', aliases: ['Jackero'] }] })).toEqual(['Jackal', 'ジャカル']);
    expect(withGlossary('Translate.', snapshot)).toContain('Rizum');
    expect(withGlossary('Translate.', { entries: [] })).toBe('Translate.');
  });
});
