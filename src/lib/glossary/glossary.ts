import { languageByScript } from '../language/script';
import type { GlossaryEntry, GlossaryEntryInput, GlossarySnapshot } from './types';

/** A small table the user keeps by hand: a recognizer is told all of it, and a long list slows it down. */
export const MAX_GLOSSARY_ENTRIES = 50;
export const MAX_GLOSSARY_TERM_LENGTH = 120;
const MAX_GLOSSARY_ALIASES = 12;
/** The most pairs one translation request is told. */
const MAX_TERMS_PER_SENTENCE = 8;

const cleanTerm = (value: unknown): string => typeof value === 'string'
  ? value.trim().slice(0, MAX_GLOSSARY_TERM_LENGTH)
  : '';

const newId = () => `glossary-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export const parseAliases = (text: string): string[] => text.split(/[,，、]/).map((alias) => alias.trim()).filter(Boolean);

const sameTerm = (a: string, b: string): boolean => a.toLocaleLowerCase() === b.toLocaleLowerCase();

function uniqueTerms(values: unknown, except: string): string[] {
  if (!Array.isArray(values)) return [];
  const result: string[] = [];
  for (const value of values) {
    const term = cleanTerm(value);
    if (term && term !== except && !result.includes(term)) result.push(term);
  }
  return result.slice(0, MAX_GLOSSARY_ALIASES);
}

/** An empty target is the term left as written. */
export function normalizeGlossaryEntry(value: unknown): GlossaryEntry | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<GlossaryEntry>;
  const source = cleanTerm(raw.source);
  if (!source) return null;
  return { id: cleanTerm(raw.id) || newId(), source, target: cleanTerm(raw.target) || source, aliases: uniqueTerms(raw.aliases, source) };
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

/** A new entry at the end; one the table already has a row for is that row again, as now written. */
export function addGlossaryEntry(entries: readonly GlossaryEntry[], input: GlossaryEntryInput): GlossaryEntry[] {
  const at = entries.findIndex((entry) => sameTerm(entry.source, input.source));
  if (at < 0) return normalizeGlossaryEntries([...entries, input]);
  return normalizeGlossaryEntries(entries.map((entry, index) => (index === at ? { ...input, id: entry.id } : entry)));
}

function escapeRegExp(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const WORD_EDGE = /[\p{Script=Latin}\p{N}]/u;

/** A term in Latin letters is matched as a whole word: "art" is not in "start". Scripts written without spaces have no such edge. */
function termPattern(term: string): RegExp {
  const before = WORD_EDGE.test(term[0]) ? '(?<![\\p{Script=Latin}\\p{N}])' : '';
  const after = WORD_EDGE.test(term[term.length - 1]) ? '(?![\\p{Script=Latin}\\p{N}])' : '';
  return new RegExp(`${before}${escapeRegExp(term)}${after}`, 'giu');
}

function replaceTerms(text: string, replacements: readonly { from: string; to: string }[]): string {
  let result = text;
  const ordered = replacements.filter((item) => item.from !== item.to).sort((a, b) => b.from.length - a.from.length);
  const targetForms = ordered.map((item) => item.to.toLocaleLowerCase());
  for (const { from, to } of ordered) {
    // Do not expand a target that already contains the source term (for
    // example `AI` → `AI assistant`) every time a streaming revision arrives.
    result = result.replace(termPattern(from), (match, offset: number, whole: string) => {
      const lower = whole.toLocaleLowerCase();
      if (targetForms.some((target) => target.length > match.length && lower.startsWith(target, offset))) return match;
      return to;
    });
  }
  return result;
}

/** Fold ASR variants into the canonical source term. */
export function normalizeRecognitionText(text: string, { entries }: GlossarySnapshot): string {
  return replaceTerms(text, entries.flatMap((entry) => entry.aliases.map((alias) => ({ from: alias, to: entry.source }))));
}

/** Chinese and Japanese share the characters a rendering is often written in. */
const writingOf = (text: string): string | undefined => {
  const language = languageByScript(text);
  return language === 'ja' ? 'zh' : language;
};

/**
 * Apply preferred source→target renderings to translated text. An entry has no
 * direction and both legs pass through here, so the writing decides: `Alice → 爱丽丝`
 * belongs in a Chinese translation, not in the English one going the other way.
 */
export function normalizeTranslationText(text: string, { entries }: GlossarySnapshot): string {
  const written = writingOf(text);
  const fits = ({ source, target }: GlossaryEntry) => {
    const into = writingOf(target);
    return into ? into === written : written === undefined || written !== writingOf(source);
  };
  return replaceTerms(text, entries.filter(fits).map((entry) => ({ from: entry.source, to: entry.target })));
}

/** What a recognizer is told to expect. The aliases are what it writes by mistake: those are put right afterwards. */
export function glossaryRecognitionTerms({ entries }: GlossarySnapshot, limit = 100): string[] {
  return entries.map((entry) => entry.source).slice(0, limit);
}

export function glossaryTranslationPairs({ entries }: GlossarySnapshot): Array<{ source: string; target: string }> {
  return entries.map(({ source, target }) => ({ source, target }));
}

/** The pairs a sentence needs, either way: the sentence may be on its way back from the target's language. */
export function termsIn(text: string, { entries }: GlossarySnapshot): Array<[from: string, to: string]> {
  const found = new Map<string, string>();
  const has = (term: string) => termPattern(term).test(text);
  for (const { source, target, aliases } of entries) {
    for (const term of [source, ...aliases]) if (has(term)) found.set(term, target);
    if (target !== source && has(target)) found.set(target, source);
  }
  return [...found].slice(0, MAX_TERMS_PER_SENTENCE);
}

/**
 * A translation model's request with the pairs ahead of it, in Hunyuan MT's own form (its card's). Index-Translate
 * follows the same words: ten of eleven terms against none without them (measured 2026-10-31).
 */
export function withTerms(request: string, terms: ReadonlyArray<readonly [string, string]>): string {
  if (terms.length === 0) return request;
  return `参考下面的翻译：\n${terms.map(([from, to]) => `${from} 翻译成 ${to}`).join('\n')}\n\n${request}`;
}

/** A provider's instructions with the glossary after them, for models without a glossary API. */
export function withGlossary(instructions: string, snapshot: GlossarySnapshot | undefined): string {
  const pairs = snapshot ? glossaryTranslationPairs(snapshot) : [];
  if (pairs.length === 0) return instructions;
  return [
    instructions.trim(),
    '',
    'Terminology preferences (use these spellings when the corresponding term is spoken):',
    ...pairs.map(({ source, target }) => `- ${source} → ${target}`),
  ].join('\n').trim();
}
