/**
 * What has been translated, and from what: `scripts/locale-translations/<locale>.json`, one record per string,
 * `{ "<key.path>": { "en": "the English it was made from", "text": "the translation" } }`.
 *
 * A record outlives the catalogs being written again (`fork-localai-locales.cjs` fills every other locale with English),
 * and says when it has gone stale: its `en` is no longer the English. `translate-locales.mjs` fills what is missing;
 * `src/locales/translated.consistency.test.ts` fails on what is left.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../src/locales');
const RECORDS = path.resolve(__dirname, 'locale-translations');

/** The catalogs someone writes by hand, or that are the source: nothing here translates them. */
const AUTHORED = new Set(['en', 'zh_CN', 'zh_TW']);

const catalogFile = (lang) => path.join(ROOT, lang, 'translation.json');
const recordFile = (lang) => path.join(RECORDS, `${lang}.json`);

function readCatalog(lang) {
  const text = fs.readFileSync(catalogFile(lang), 'utf8');
  return { text, catalog: JSON.parse(text) };
}

function writeCatalog(lang, catalog, before) {
  const eol = before.includes('\r\n') ? '\r\n' : '\n';
  const next = JSON.stringify(catalog, null, 2).replace(/\n/g, eol) + (before.endsWith('\n') ? eol : '');
  if (next !== before) fs.writeFileSync(catalogFile(lang), next);
  return next;
}

const readRecords = (lang) => (fs.existsSync(recordFile(lang)) ? JSON.parse(fs.readFileSync(recordFile(lang), 'utf8')) : {});

function writeRecords(lang, records) {
  fs.mkdirSync(RECORDS, { recursive: true });
  const sorted = Object.fromEntries(Object.entries(records).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(recordFile(lang), `${JSON.stringify(sorted, null, 2)}\n`);
}

/** Every string of a catalog, by its dotted path. */
function flatten(node, trail = [], out = new Map()) {
  for (const [key, value] of Object.entries(node)) {
    const at = [...trail, key];
    if (typeof value === 'string') out.set(at.join('.'), { at, value });
    else if (value && typeof value === 'object') flatten(value, at, out);
  }
  return out;
}

function setAt(catalog, at, value) {
  let node = catalog;
  for (const key of at.slice(0, -1)) node = node[key];
  node[at[at.length - 1]] = value;
}

/** Something a reader reads, not a name or a sign: English that has letters to translate. */
const translatable = (text) => /\p{L}{2}/u.test(text.replace(/\{\{[^}]*\}\}/g, ''));

const locales = () => fs.readdirSync(ROOT).filter((lang) => !AUTHORED.has(lang) && fs.existsSync(catalogFile(lang))).sort();

/** The records put back into a catalog: those still made from today's English. */
function applyRecords(lang, english = flatten(readCatalog('en').catalog)) {
  const { text, catalog } = readCatalog(lang);
  const records = readRecords(lang);
  const own = flatten(catalog);
  for (const [key, record] of Object.entries(records)) {
    const en = english.get(key);
    const mine = own.get(key);
    if (en && mine && record.en === en.value) setAt(catalog, mine.at, record.text);
  }
  writeCatalog(lang, catalog, text);
}

module.exports = { AUTHORED, applyRecords, flatten, locales, readCatalog, readRecords, setAt, translatable, writeCatalog, writeRecords };
