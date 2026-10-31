import type { GlossaryEntry, GlossaryEntryInput, GlossaryImportResult, GlossarySnapshot } from './types';

export const MAX_GLOSSARY_ENTRIES = 500;
export const MAX_GLOSSARY_TERM_LENGTH = 120;
const MAX_GLOSSARY_ALIASES = 12;

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

function idFor(index: number): string {
  return `glossary-${Date.now().toString(36)}-${index.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeGlossaryEntry(value: unknown, index = 0): GlossaryEntry | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<GlossaryEntry>;
  const source = cleanTerm(raw.source);
  if (!source) return null;
  const target = cleanTerm(raw.target) || source;
  const aliases = uniqueTerms(raw.aliases).filter((alias) => alias !== source);
  const externalId = cleanExternalId(raw.externalId);
  return {
    id: cleanTerm(raw.id) || idFor(index),
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
  value.forEach((item, index) => {
    const entry = normalizeGlossaryEntry(item, index);
    if (!entry) return;
    const sourceKey = entry.source.toLocaleLowerCase();
    if (entry.externalId) {
      const externalKey = entry.externalId.toLocaleLowerCase();
      if (seenExternalIds.has(externalKey)) return;
      seenExternalIds.add(externalKey);
    } else {
      if (seenSources.has(sourceKey)) return;
      seenSources.add(sourceKey);
    }
    result.push(entry);
  });
  return result.slice(0, MAX_GLOSSARY_ENTRIES);
}

export function createGlossaryEntry(input: GlossaryEntryInput, index = 0): GlossaryEntry | null {
  return normalizeGlossaryEntry({ ...input, id: idFor(index) }, index);
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
      aliases: aliases ? aliases.split(/[,，]/) : [],
    });
  }
  return entries;
}

function sameTerms(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Merge imported entries by external ID first, then canonical source. */
export function mergeGlossaryEntriesDetailed(current: readonly GlossaryEntry[], imported: readonly GlossaryEntryInput[]): { entries: GlossaryEntry[]; result: GlossaryImportResult } {
  const result = normalizeGlossaryEntries(current);
  const byExternalId = new Map<string, GlossaryEntry>();
  const bySource = new Map<string, GlossaryEntry>();
  result.forEach((entry) => {
    if (entry.externalId) byExternalId.set(entry.externalId.toLocaleLowerCase(), entry);
    bySource.set(entry.source.toLocaleLowerCase(), entry);
  });
  let added = 0;
  let updated = 0;
  let skipped = 0;
  for (const input of imported) {
    const entry = createGlossaryEntry(input, result.length);
    if (!entry) {
      skipped += 1;
      continue;
    }
    const sourceMatch = bySource.get(entry.source.toLocaleLowerCase());
    const existing = (entry.externalId && byExternalId.get(entry.externalId.toLocaleLowerCase()))
      ?? (entry.externalId && sourceMatch?.externalId ? undefined : sourceMatch);
    if (existing) {
      const index = result.indexOf(existing);
      const importedFromExternal = Boolean(entry.externalId);
      const preserveCustomTarget = importedFromExternal && existing.target !== existing.source;
      const nextValues = {
        ...existing,
        externalId: entry.externalId ?? existing.externalId,
        source: entry.source,
        target: preserveCustomTarget ? existing.target : entry.target,
        aliases: preserveCustomTarget ? existing.aliases : entry.aliases,
        id: existing.id,
      };
      const next = normalizeGlossaryEntry({
        ...nextValues,
      }, index);
      if (next) {
        const changed = next.source !== existing.source
          || next.target !== existing.target
          || next.externalId !== existing.externalId
          || !sameTerms(next.aliases, existing.aliases);
        result[index] = next;
        bySource.delete(existing.source.toLocaleLowerCase());
        bySource.set(next.source.toLocaleLowerCase(), next);
        if (next.externalId) byExternalId.set(next.externalId.toLocaleLowerCase(), next);
        if (changed) updated += 1;
      }
    } else if (result.length < MAX_GLOSSARY_ENTRIES) {
      result.push(entry);
      bySource.set(entry.source.toLocaleLowerCase(), entry);
      if (entry.externalId) byExternalId.set(entry.externalId.toLocaleLowerCase(), entry);
      added += 1;
    } else {
      skipped += 1;
    }
  }
  return { entries: result, result: { added, updated, skipped } };
}

/** Merge imported entries by external ID first, then canonical source. */
export function mergeGlossaryEntries(current: readonly GlossaryEntry[], imported: readonly GlossaryEntryInput[]): GlossaryEntry[] {
  return mergeGlossaryEntriesDetailed(current, imported).entries;
}

function enabledEntries(snapshot: GlossarySnapshot | readonly GlossaryEntry[]): GlossaryEntry[] {
  const entries: readonly GlossaryEntry[] = Array.isArray(snapshot)
    ? snapshot
    : (snapshot as GlossarySnapshot).entries;
  return entries.filter((entry) => entry.enabled && entry.source && entry.target);
}

function escapeRegExp(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceTerms(text: string, replacements: readonly { from: string; to: string }[]): string {
  let result = text;
  const ordered = [...replacements].sort((a, b) => b.from.length - a.from.length);
  const targetForms = ordered.filter((item) => item.from !== item.to).map((item) => item.to.toLocaleLowerCase());
  for (const { from, to } of ordered) {
    if (!from || from === to) continue;
    // Do not expand a target that already contains the source term (for
    // example `AI` → `AI assistant`) every time a streaming revision arrives.
    const pattern = new RegExp(escapeRegExp(from), 'giu');
    result = result.replace(pattern, (match, offset: number, whole: string) => {
      const lower = whole.toLocaleLowerCase();
      if (targetForms.some((target) => target.length > match.length && lower.startsWith(target, offset))) return match;
      return to;
    });
  }
  return result;
}

/** Fold ASR variants into the canonical source term. */
export function normalizeRecognitionText(text: string, snapshot: GlossarySnapshot | readonly GlossaryEntry[]): string {
  const replacements = enabledEntries(snapshot).flatMap((entry) => [
    { from: entry.source, to: entry.source },
    ...entry.aliases.map((alias) => ({ from: alias, to: entry.source })),
  ]);
  return replaceTerms(text, replacements);
}

/** Apply preferred source→target renderings to translated text. */
export function normalizeTranslationText(text: string, snapshot: GlossarySnapshot | readonly GlossaryEntry[]): string {
  return replaceTerms(text, enabledEntries(snapshot).map((entry) => ({ from: entry.source, to: entry.target })));
}

export function glossaryRecognitionTerms(snapshot: GlossarySnapshot | readonly GlossaryEntry[], limit = 100): string[] {
  const seen = new Set<string>();
  return enabledEntries(snapshot).flatMap((entry) => [entry.source, ...entry.aliases]).filter((term) => {
    const key = term.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, limit);
}

export function glossaryTranslationPairs(snapshot: GlossarySnapshot | readonly GlossaryEntry[]): Array<{ source: string; target: string }> {
  return enabledEntries(snapshot).map(({ source, target }) => ({ source, target }));
}

/** A short, provider-neutral instruction block for models without a glossary API. */
export function buildGlossaryPrompt(snapshot: GlossarySnapshot | readonly GlossaryEntry[]): string {
  // Keep provider prompts bounded when a user pastes a large friends list.
  const pairs = glossaryTranslationPairs(snapshot).slice(0, 80);
  if (pairs.length === 0) return '';
  const lines = pairs.map(({ source, target }) => `- ${source} → ${target}`);
  return [
    'Terminology preferences (use these spellings when the corresponding term is spoken):',
    ...lines,
  ].join('\n');
}

