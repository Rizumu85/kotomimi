// src/viewer/text.ts
/**
 * What a viewer reads of an entry (spec 2026-10-04 §5.2, decision 5): the
 * choice is a language, not a role, so "Chinese" is the translation of the
 * host's line and the original of the other side's.
 */
import { needsSpace } from '../lib/projection/join';
import type { ShareState, ViewerEntry, ViewerRow } from '../lib/share/types';

export interface Choice { code: string; both: boolean }
type Pair = ShareState['pair'];

/** Entering: the source language, both, the target language. */
export function choiceOptions(pair: Pair): Choice[] {
  return [{ code: pair.source, both: false }, { code: pair.target, both: true }, { code: pair.target, both: false }];
}

const base = (tag: string) => tag.toLowerCase().split('-')[0];

export function defaultChoice(pair: Pair, languages: readonly string[]): Choice {
  for (const lang of languages) {
    if (base(lang) === base(pair.target)) return { code: pair.target, both: false };
    if (base(lang) === base(pair.source)) return { code: pair.source, both: false };
  }
  return { code: pair.target, both: true };
}

export function validChoice(choice: Choice, pair: Pair): Choice {
  return choice.code === pair.source || choice.code === pair.target ? choice : { code: pair.target, both: true };
}

/** The chosen language can be on either side, independently for each row. */
export function sidesFor(entry: ViewerEntry, code: string): { primary: ViewerRow[]; secondary: ViewerRow[] } {
  // "Auto" is the source choice, not a language to match against detected text.
  if (code === 'auto') return { primary: entry.source, secondary: entry.translation };
  const rows = (['source', 'translation'] as const).flatMap((side) => entry[side].map((row) => ({
    row, language: (row.language ?? entry.languages[side === 'source' ? 'source' : 'target']).toLowerCase(),
  })));
  const chosen = code.toLowerCase();
  const primary: ViewerRow[] = [], secondary: ViewerRow[] = [];
  for (const { row, language } of rows) {
    // A recognizer may name only "zh"; two explicit variants still stay apart.
    const matches = language === chosen || language === base(chosen) || base(language) === chosen;
    (matches ? primary : secondary).push(row);
  }
  return { primary, secondary };
}

export interface Piece { text: string; final: boolean; space: boolean }

/** Rows as display pieces: rows of a segment tile its text; between segments a space only where `needsSpace` says. */
export function piecesOf(rows: readonly ViewerRow[], completeOnly: boolean): Piece[] {
  const segments: Array<{ id: string; text: string; final: boolean }> = [];
  for (const row of rows) {
    if (completeOnly && !row.final) continue;
    const id = row.key.slice(0, row.key.lastIndexOf(':'));
    const last = segments[segments.length - 1];
    if (last && last.id === id) last.text += row.text;
    else segments.push({ id, text: row.text, final: row.final });
  }
  const pieces: Piece[] = [];
  let joined = '';
  for (const seg of segments) {
    const text = seg.text.trim();
    if (text === '') continue;
    const space = needsSpace(joined, text);
    joined += (space ? ' ' : '') + text;
    pieces.push({ text, final: seg.final, space });
  }
  return pieces;
}

export function piecesText(pieces: readonly Piece[]): string {
  return pieces.map((p) => (p.space ? ' ' : '') + p.text).join('');
}
