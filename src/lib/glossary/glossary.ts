import type { GlossaryEntry, GlossaryEntryInput, GlossarySnapshot } from './types';
import { foldBySound } from './sound';

/** A small table the user keeps by hand: a recognizer is told all of it, and a long list slows it down. */
export const MAX_GLOSSARY_ENTRIES = 50;
export const MAX_GLOSSARY_TERM_LENGTH = 120;
const MAX_GLOSSARY_ALIASES = 12;

const cleanTerm = (value: unknown): string => typeof value === 'string'
  ? value.trim().slice(0, MAX_GLOSSARY_TERM_LENGTH)
  : '';

const newId = () => `glossary-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export const parseAliases = (text: string): string[] => text.split(/[,，、]/).map((alias) => alias.trim()).filter(Boolean);

const sameTerm = (a: string, b: string): boolean => a.toLocaleLowerCase() === b.toLocaleLowerCase();

function uniqueTerms(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const result: string[] = [];
  for (const value of values) {
    const term = cleanTerm(value);
    if (term && !result.includes(term)) result.push(term);
  }
  return result.slice(0, MAX_GLOSSARY_ALIASES);
}

export function normalizeGlossaryEntry(value: unknown): GlossaryEntry | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<GlossaryEntry>;
  const source = cleanTerm(raw.source);
  if (!source) return null;
  // An alias may be the term itself: matching ignores case, so VRC puts right the vrc that recognition writes. Dropped,
  // what the user had just typed went from the cell with nothing said (the user, 2026-10-31).
  return { id: cleanTerm(raw.id) || newId(), source, aliases: uniqueTerms(raw.aliases) };
}

export function normalizeGlossaryEntries(value: unknown): GlossaryEntry[] {
  if (!Array.isArray(value)) return [];
  const result: GlossaryEntry[] = [];
  for (const item of value) {
    const entry = normalizeGlossaryEntry(item);
    if (entry && !result.some((kept) => sameTerm(kept.source, entry.source))) result.push(entry);
  }
  return result.slice(0, MAX_GLOSSARY_ENTRIES);
}

/** A new entry at the end; one the table already has a row for is that row again, as now written, with what it was heard as kept. */
export function addGlossaryEntry(entries: readonly GlossaryEntry[], input: GlossaryEntryInput): GlossaryEntry[] {
  const at = entries.findIndex((entry) => sameTerm(entry.source, input.source));
  if (at < 0) return normalizeGlossaryEntries([...entries, input]);
  return normalizeGlossaryEntries(entries.map((entry, index) => (index === at
    ? { id: entry.id, source: input.source, aliases: [...entry.aliases, ...(input.aliases ?? [])] }
    : entry)));
}

function escapeRegExp(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const WORD_EDGE = /[\p{Script=Latin}\p{N}]/u;

/** A term in Latin letters is matched as a whole word: "art" is not in "start". Scripts written without spaces have no such edge. */
function termPattern(term: string): string {
  const before = WORD_EDGE.test(term[0]) ? '(?<![\\p{Script=Latin}\\p{N}])' : '';
  const after = WORD_EDGE.test(term[term.length - 1]) ? '(?![\\p{Script=Latin}\\p{N}])' : '';
  return `${before}${escapeRegExp(term)}${after}`;
}

/**
 * Fold what recognition writes wrongly into the term as written. This runs before translation: given a name written
 * right, a translation model keeps it unprompted (11 of 11 sentences, Index-Translate, 2026-10-31).
 *
 * One pass, the longest first, over the words as well as what they are misheard as: the word's own case is put right
 * with nothing to fill in, and text that has been through this before comes out the same: 糖豆豆 misheard as 糖豆 does not
 * grow, sentence after sentence, as a row is drawn again (2026-10-31).
 */
export function normalizeRecognitionText(text: string, { entries }: GlossarySnapshot): string {
  const written = new Map<string, string>();
  for (const entry of entries) for (const term of [entry.source, ...entry.aliases]) written.set(term.toLocaleLowerCase(), entry.source);
  if (written.size === 0) return text;
  const terms = entries.flatMap((entry) => [entry.source, ...entry.aliases]).sort((a, b) => b.length - a.length);
  const spelled = text.replace(new RegExp(terms.map(termPattern).join('|'), 'giu'), (found) => written.get(found.toLocaleLowerCase()) ?? found);
  // Then what only sounds like one of them: recognition spells a name another way nearly every time (`sound.ts`).
  return foldBySound(spelled, entries);
}

/**
 * What a recognizer is told to expect. The aliases are what it writes by mistake: those are put right afterwards. A
 * word written with a comma in it ("Jackal, ジャカル") is told as its pieces: the list is joined with marks of its
 * own, and a small model read the comma back as the list's (2026-11-05).
 */
export function glossaryRecognitionTerms({ entries }: GlossarySnapshot, limit = 100): string[] {
  const terms: string[] = [];
  for (const entry of entries) {
    for (const piece of parseAliases(entry.source)) if (!terms.includes(piece)) terms.push(piece);
  }
  return terms.slice(0, limit);
}

/** A provider's instructions with the terms after them, for models without a word list of their own. */
export function withGlossary(instructions: string, snapshot: GlossarySnapshot | undefined): string {
  const terms = snapshot ? glossaryRecognitionTerms(snapshot) : [];
  if (terms.length === 0) return instructions;
  return `${instructions.trim()}\n\nTerms that may be spoken, written as they should be: ${terms.join(', ')}`;
}
