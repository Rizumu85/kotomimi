import { describe, expect, it } from 'vitest';
import { addMine, addTheirs, isLit, pressMine, pressTheirs, removeMine, removeTheirs, settleTheirs, type TheirLanguages } from './theirLanguages';

const row = ['en', 'ko', 'ja'];
const one: TheirLanguages = { main: 'en', row, lit: '', two: true };
const two: TheirLanguages = { main: 'en', row, lit: 'ko', two: true };

describe('the other side’s languages switched by hand (fork)', () => {
  it('lights one pressed beside the main one, and puts it out pressed again', () => {
    expect(pressTheirs(one, 'ko')).toEqual({ main: 'en', row, lit: 'ko' });
    expect(pressTheirs(two, 'ko')).toEqual({ main: 'en', row, lit: '' });
    expect(isLit(two, 'ko') && isLit(two, 'en') && !isLit(two, 'ja')).toBe(true);
  });

  it('keeps one lit: the only one pressed does nothing, the main one pressed hands the main to the other', () => {
    expect(pressTheirs(one, 'en')).toBeNull();
    expect(pressTheirs(two, 'en')).toEqual({ main: 'ko', row, lit: '' });
  });

  it('puts out the one lit first where two are lit and a third is pressed', () => {
    expect(pressTheirs(two, 'ja')).toEqual({ main: 'ko', row, lit: 'ja' });
  });

  it('moves the light where what hears them takes one language', () => {
    expect(pressTheirs({ ...one, two: false }, 'ko')).toEqual({ main: 'ko', row, lit: '' });
  });

  it('lights "any language" beside the main one, never as it', () => {
    const any = { ...one, row: [...row, 'auto'] };
    expect(pressTheirs(any, 'auto')).toEqual({ main: 'en', row: any.row, lit: 'auto' });
    expect(pressTheirs({ ...any, lit: 'auto' }, 'en')).toBeNull();
    expect(pressTheirs({ ...any, lit: 'auto' }, 'ja')).toEqual({ main: 'en', row: any.row, lit: 'ja' });
  });

  it('adds one lit, and takes one out: the main to the other lit, or to the first left', () => {
    expect(addTheirs(one, 'fr')).toEqual({ main: 'en', row: [...row, 'fr'], lit: 'fr' });
    expect(removeTheirs(two, 'ko')).toEqual({ main: 'en', row: ['en', 'ja'], lit: '' });
    expect(removeTheirs(two, 'en')).toEqual({ main: 'ko', row: ['ko', 'ja'], lit: '' });
    expect(removeTheirs(one, 'en')).toEqual({ main: 'ko', row: ['ko', 'ja'], lit: '' });
    expect(removeTheirs({ main: 'en', row: ['en'], lit: '', two: true }, 'en')).toBeNull();
  });
});

describe('the user’s own language in the other side’s row (fork)', () => {
  const zhRow = ['ja', 'zh-CN', 'ko'];
  const mine = (t: Omit<TheirLanguages, 'two' | 'own'>): TheirLanguages => ({ ...t, two: true, own: 'zh-CN' });

  it('is their main one lit alone: the pair is of one language', () => {
    expect(pressTheirs({ ...mine({ main: 'ja', row: zhRow, lit: '' }), two: false }, 'zh-CN')).toEqual({ main: 'zh-CN', row: zhRow, lit: '' });
    // Beside theirs, then theirs put out.
    expect(pressTheirs(mine({ main: 'ja', row: zhRow, lit: '' }), 'zh-CN')).toEqual({ main: 'ja', row: zhRow, lit: 'zh-CN' });
    expect(pressTheirs(mine({ main: 'ja', row: zhRow, lit: 'zh-CN' }), 'ja')).toEqual({ main: 'zh-CN', row: zhRow, lit: '' });
    expect(pressTheirs(mine({ main: 'zh-CN', row: zhRow, lit: '' }), 'zh-CN')).toBeNull();
  });

  it('gives the main to another lit beside it: the user’s speech is translated into that one', () => {
    expect(pressTheirs(mine({ main: 'zh-CN', row: zhRow, lit: '' }), 'ja')).toEqual({ main: 'ja', row: zhRow, lit: 'zh-CN' });
    // Two lit and a third pressed: the one lit first goes dark, and the user’s own is still not the main.
    expect(pressTheirs(mine({ main: 'ja', row: zhRow, lit: 'zh-CN' }), 'ko')).toEqual({ main: 'ko', row: zhRow, lit: 'zh-CN' });
    expect(addTheirs(mine({ main: 'zh-CN', row: ['zh-CN'], lit: '' }), 'fr')).toEqual({ main: 'fr', row: ['zh-CN', 'fr'], lit: 'zh-CN' });
  });

  it('has no "any language" lit beside it alone: nothing would be translated into', () => {
    const any = [...zhRow, 'auto'];
    expect(pressTheirs(mine({ main: 'zh-CN', row: any, lit: '' }), 'auto')).toBeNull();
    // Left the first in the row when their main one is taken out.
    expect(removeTheirs(mine({ main: 'ja', row: ['ja', 'auto', 'zh-CN'], lit: 'auto' }), 'ja')).toEqual({ main: 'zh-CN', row: ['auto', 'zh-CN'], lit: '' });
    // Lit beside another, it takes the place of "any language".
    expect(pressTheirs(mine({ main: 'ja', row: any, lit: 'auto' }), 'zh-CN')).toEqual({ main: 'ja', row: any, lit: 'zh-CN' });
  });

  it('is put right when the user’s own language changes to their main one', () => {
    expect(settleTheirs({ main: 'ja', row: zhRow, lit: 'ko' }, 'ja')).toEqual({ main: 'ko', row: zhRow, lit: 'ja' });
    expect(settleTheirs({ main: 'ja', row: [...zhRow, 'auto'], lit: 'auto' }, 'ja')).toEqual({ main: 'ja', row: [...zhRow, 'auto'], lit: '' });
    // Lit alone, or not their main one: it stands.
    expect(settleTheirs({ main: 'ja', row: zhRow, lit: '' }, 'ja')).toBeNull();
    // Another script of the user's own is still translated into: it keeps the main.
    expect(settleTheirs({ main: 'zh-TW', row: ['zh-TW', 'ja'], lit: 'ja' }, 'zh-CN')).toBeNull();
    expect(pressTheirs({ main: 'zh-TW', row: ['zh-TW', 'ja'], lit: '', two: true, own: 'zh-CN' }, 'ja')).toEqual({ main: 'zh-TW', row: ['zh-TW', 'ja'], lit: 'ja' });
    expect(settleTheirs({ main: 'ko', row: zhRow, lit: 'ja' }, 'ja')).toBeNull();
  });

  it('changes nothing of a row that is not told the user’s own', () => {
    expect(pressTheirs({ main: 'zh-CN', row: zhRow, lit: '', two: true }, 'ja')).toEqual({ main: 'zh-CN', row: zhRow, lit: 'ja' });
  });
});

describe('the user’s own row (fork)', () => {
  const mine = { main: 'zh-CN', row: ['zh-CN', 'en', 'ja'] };

  it('makes a pressed one their own, keeping the row as it is', () => {
    expect(pressMine(mine, 'en')).toEqual({ main: 'en', row: mine.row });
    expect(pressMine(mine, 'zh-CN')).toBeNull();
  });

  it('adds beside their own, and takes one out: their own passing to the next, never the last', () => {
    expect(addMine(mine, 'ko')).toEqual({ main: 'zh-CN', row: [...mine.row, 'ko'] });
    expect(removeMine(mine, 'en')).toEqual({ main: 'zh-CN', row: ['zh-CN', 'ja'] });
    expect(removeMine(mine, 'zh-CN')).toEqual({ main: 'en', row: ['en', 'ja'] });
    expect(removeMine({ main: 'zh-CN', row: ['zh-CN'] }, 'zh-CN')).toBeNull();
  });
});
