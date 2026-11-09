import { describe, expect, it } from 'vitest';
import { addTheirs, isLit, pressTheirs, removeTheirs, type TheirLanguages } from './theirLanguages';

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
