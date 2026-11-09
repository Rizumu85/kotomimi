import { describe, expect, it } from 'vitest';
import { addMine, addTheirs, isLit, pressMine, pressTheirs, removeMine, removeTheirs, type TheirLanguages } from './theirLanguages';

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
