import { languageByScript } from '../language/script';
import type { GlossaryEntry, GlossaryEntryInput, GlossaryImportResult, GlossarySnapshot } from './types';

export const MAX_GLOSSARY_ENTRIES = 500;
export const MAX_GLOSSARY_TERM_LENGTH = 120;
const MAX_GLOSSARY_ALIASES = 12;
/** How many pairs a provider is told, where it takes a prompt or a small list. */
const MAX_GLOSSARY_PAIRS = 80;

const cleanTerm = (value: unknown): string => typeof value === 'string'
  ? value.trim().slice(0, MAX_GLOSSARY_TERM_LENGTH)
  : '';

const cleanExternalId = (value: unknown): string => typeof value === 'string'
  ? value.replace(/^\uFEFF/, '').trim().slice(0, 200)
  : '';

function uniqueTerms(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const term = cleanTerm(value);
    if (!term || seen.has(term)) continue;
    seen.add(term);
    result.push(term);
    if (result.length >= MAX_GLOSSARY_ALIASES) break;
  }
  return result;
}

const newId = () => `glossary-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export const parseAliases = (text: string): string[] => text.split(/[,，、]/).map((alias) => alias.trim()).filter(Boolean);

export function normalizeGlossaryEntry(value: unknown): GlossaryEntry | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<GlossaryEntry>;
  const source = cleanTerm(raw.source);
  if (!source) return null;
  const target = cleanTerm(raw.target) || source;
  const aliases = uniqueTerms(raw.aliases).filter((alias) => alias !== source);
  const externalId = cleanExternalId(raw.externalId);
  return {
    id: cleanTerm(raw.id) || newId(),
    ...(externalId ? { externalId } : {}),
    source,
    target,
    aliases,
    enabled: raw.enabled !== false,
  };
}

export function normalizeGlossaryEntries(value: unknown): GlossaryEntry[] {
  if (!Array.isArray(value)) return [];
  const seenExternalIds = new Set<string>();
  const seenSources = new Set<string>();
  const result: GlossaryEntry[] = [];
  for (const item of value) {
    const entry = normalizeGlossaryEntry(item);
    if (!entry) continue;
    const sourceKey = entry.source.toLocaleLowerCase();
    if (entry.externalId) {
      const externalKey = entry.externalId.toLocaleLowerCase();
      if (seenExternalIds.has(externalKey)) continue;
      seenExternalIds.add(externalKey);
    } else {
      if (seenSources.has(sourceKey)) continue;
      seenSources.add(sourceKey);
    }
    result.push(entry);
  }
  return result.slice(0, MAX_GLOSSARY_ENTRIES);
}

function parseCsvRows(raw: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const source = raw.replace(/^\uFEFF/, '');
  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    if (row.some((value) => value.trim())) rows.push(row);
    row = [];
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === ',') {
      pushField();
    } else if (character === '\n') {
      pushRow();
    } else if (character !== '\r') {
      field += character;
    }
  }
  if (field.length > 0 || row.length > 0) pushRow();
  return rows;
}

function normalizeCsvHeader(value: string): string {
  return value.replace(/^\uFEFF/, '').toLocaleLowerCase().replace(/[^a-z0-9]/g, '');
}

function parseVrcxCsv(raw: string): GlossaryEntryInput[] | null {
  const rows = parseCsvRows(raw);
  if (rows.length < 2) return null;
  const header = rows[0].map(normalizeCsvHeader);
  const userIdIndex = header.findIndex((value) => value === 'userid' || value === 'id');
  const displayNameIndex = header.findIndex((value) => value === 'displayname' || value === 'name');
  if (displayNameIndex < 0 || (userIdIndex < 0 && header[displayNameIndex] !== 'name')) return null;
  const entries: GlossaryEntryInput[] = [];
  for (const row of rows.slice(1)) {
    const source = cleanTerm(row[displayNameIndex]);
    if (!source) continue;
    const externalId = userIdIndex >= 0 ? cleanExternalId(row[userIdIndex]) : '';
    entries.push({
      source,
      target: source,
      aliases: [],
      ...(externalId ? { externalId } : {}),
    });
  }
  return entries;
}

/**
 * Import VRCX's UserID,DisplayName,Memo CSV as well as the plain-text glossary
 * formats. CSV fields may contain commas, quotes, or line breaks.
 */
export function parseGlossaryClipboard(raw: string): GlossaryEntryInput[] {
  const vrcxEntries = parseVrcxCsv(raw);
  if (vrcxEntries) return vrcxEntries;

  const entries: GlossaryEntryInput[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const columns = trimmed.split('\t').map((part) => part.trim());
    let source = columns[0] ?? '';
    let target = columns[1] ?? '';
    let aliases = columns[2] ?? '';
    if (columns.length === 1) {
      const separator = source.indexOf('=');
      if (separator > 0) {
        target = source.slice(separator + 1).trim();
        source = source.slice(0, separator).trim();
      }
    }
    if (!source) continue;
    entries.push({
      source,
      target: target || source,
      aliases: parseAliases(aliases),
    });
  }
  return entries;
}

const sameEntry = (a: GlossaryEntry, b: GlossaryEntry): boolean => a.source === b.source
  && a.target === b.target
  && a.externalId === b.externalId
  && a.aliases.join('\n') === b.aliases.join('\n');

/**
 * Merge imported entries by external ID first, then canonical source. A row from
 * a friends list carries a name only: what the user wrote on it stays, the target
 * unless it was just the old name.
 */
export function mergeGlossaryEntries(current: readonly GlossaryEntry[], imported: readonly GlossaryEntryInput[]): { entries: GlossaryEntry[]; result: GlossaryImportResult } {
  const result = normalizeGlossaryEntries(current);
  const byExternalId = new Map<string, GlossaryEntry>();
  const bySource = new Map<string, GlossaryEntry>();
  const remember = (entry: GlossaryEntry) => {
    if (entry.externalId) byExternalId.set(entry.externalId.toLocaleLowerCase(), entry);
    bySource.set(entry.source.toLocaleLowerCase(), entry);
  };
  result.forEach(remember);
  let added = 0;
  let updated = 0;
  let skipped = 0;
  for (const input of imported) {
    const entry = normalizeGlossaryEntry({ ...input, id: newId() });
    if (!entry) {
      skipped += 1;
      continue;
    }
    const sourceMatch = bySource.get(entry.source.toLocaleLowerCase());
    const existing = (entry.externalId && byExternalId.get(entry.externalId.toLocaleLowerCase()))
      ?? (entry.externalId && sourceMatch?.externalId ? undefined : sourceMatch);
    if (existing) {
      const named = Boolean(entry.externalId);
      const next = normalizeGlossaryEntry({
        ...existing,
        externalId: entry.externalId ?? existing.externalId,
        source: entry.source,
        target: named && existing.target !== existing.source ? existing.target : entry.target,
        aliases: named ? existing.aliases : entry.aliases,
      });
      if (next) {
        if (!sameEntry(next, existing)) updated += 1;
        result[result.indexOf(existing)] = next;
        bySource.delete(existing.source.toLocaleLowerCase());
        remember(next);
      }
    } else if (result.length < MAX_GLOSSARY_ENTRIES) {
      result.push(entry);
      remember(entry);
      added += 1;
    } else {
      skipped += 1;
    }
  }
  return { entries: result, result: { added, updated, skipped } };
}

/** What the user wrote by hand first, so that a friends list imported before it does not push it past a provider's limit. */
function enabledEntries({ entries }: GlossarySnapshot): GlossaryEntry[] {
  const written = (entry: GlossaryEntry) => (entry.target !== entry.source || entry.aliases.length > 0 ? 0 : 1);
  return entries.filter((entry) => entry.enabled).sort((a, b) => written(a) - written(b));
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
export function normalizeRecognitionText(text: string, snapshot: GlossarySnapshot): string {
  return replaceTerms(text, enabledEntries(snapshot).flatMap((entry) => entry.aliases.map((alias) => ({ from: alias, to: entry.source }))));
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
export function normalizeTranslationText(text: string, snapshot: GlossarySnapshot): string {
  const written = writingOf(text);
  const fits = ({ source, target }: GlossaryEntry) => {
    const into = writingOf(target);
    return into ? into === written : written === undefined || written !== writingOf(source);
  };
  return replaceTerms(text, enabledEntries(snapshot).filter(fits).map((entry) => ({ from: entry.source, to: entry.target })));
}

export function glossaryRecognitionTerms(snapshot: GlossarySnapshot, limit = 100): string[] {
  const seen = new Set<string>();
  return enabledEntries(snapshot).flatMap((entry) => [entry.source, ...entry.aliases]).filter((term) => {
    const key = term.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, limit);
}

export function glossaryTranslationPairs(snapshot: GlossarySnapshot): Array<{ source: string; target: string }> {
  return enabledEntries(snapshot).slice(0, MAX_GLOSSARY_PAIRS).map(({ source, target }) => ({ source, target }));
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
