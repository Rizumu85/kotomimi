/**
 * Fork: no string is left in English in a language someone chose, and none is left translated from English that has
 * changed. A string added or reworded fails here until `node scripts/translate-locales.mjs --model <name>` has been run:
 * the fork's strings are written in English and Chinese, and 27 catalogs once held some 500 of them in English unnoticed
 * (the user, 2026-10-31). A string that truly stays the same has a record saying so.
 */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { flatten, locales, readCatalog, readRecords, translatable } = require('../../scripts/locale-records.cjs');

describe('the catalogs nobody writes by hand', () => {
  const english: Map<string, { value: string }> = flatten(readCatalog('en').catalog);

  it.each(locales() as string[])('%s has every string translated from the English of today', (lang) => {
    const own: Map<string, { value: string }> = flatten(readCatalog(lang).catalog);
    const records: Record<string, { en: string; text: string }> = readRecords(lang);
    const left: string[] = [];
    for (const [key, { value }] of english) {
      const mine = own.get(key);
      const record = records[key];
      if (!mine) left.push(`${key}: not in the catalog`);
      else if (record && record.en !== value) left.push(`${key}: its English has changed`);
      else if (!record && mine.value === value && translatable(value)) left.push(`${key}: still English`);
    }
    expect(left.slice(0, 12), `${left.length} strings: node scripts/translate-locales.mjs --model <name>`).toEqual([]);
  });
});
