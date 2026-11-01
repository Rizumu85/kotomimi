#!/usr/bin/env node
/**
 * Fills the catalogs that nobody writes by hand: what is still English in them, and what was translated from English
 * that has since changed. Each batch goes to Codex, read-only, and comes back as JSON; what keeps its placeholders is
 * written to the catalog and to the records (`locale-records.cjs`), so an interrupted run goes on from where it stopped.
 *
 *   node scripts/translate-locales.mjs --check                     only say how much is missing
 *   node scripts/translate-locales.mjs --model <name>              what is missing, everywhere
 *   node scripts/translate-locales.mjs --model <name> --only ja,ko --limit 10 --jobs 4
 *   node scripts/translate-locales.mjs --model <name> --again settings.glossaryHeard,settings.glossaryAdd
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { flatten, locales, readCatalog, readRecords, setAt, translatable, writeCatalog, writeRecords } = require('./locale-records.cjs');

const option = (name, fallback) => { const at = process.argv.indexOf(`--${name}`); return at < 0 ? fallback : process.argv[at + 1]; };
const has = (name) => process.argv.includes(`--${name}`);
const MODEL = option('model', '');
const BATCH = Number(option('batch', 120));
const JOBS = Number(option('jobs', 4));
const LIMIT = Number(option('limit', Infinity));
const ONLY = option('only', '').split(',').filter(Boolean);
const AGAIN = new Set(option('again', '').split(',').filter(Boolean));

const NAMES = {
  ar: 'Arabic', bn: 'Bengali', de: 'German', es: 'Spanish', fa: 'Persian', fi: 'Finnish', fil: 'Filipino', fr: 'French', he: 'Hebrew', hi: 'Hindi',
  id: 'Indonesian', it: 'Italian', ja: 'Japanese', ko: 'Korean', ms: 'Malay', nl: 'Dutch', pl: 'Polish', pt_BR: 'Brazilian Portuguese',
  pt_PT: 'European Portuguese', ru: 'Russian', sv: 'Swedish', ta: 'Tamil', te: 'Telugu', th: 'Thai', tr: 'Turkish', uk: 'Ukrainian', vi: 'Vietnamese',
};

const english = flatten(readCatalog('en').catalog);
const simplified = flatten(readCatalog('zh_CN').catalog);

/** What a locale is missing: still English with no record of it, or made from English that has changed. */
function missingIn(lang) {
  const own = flatten(readCatalog(lang).catalog);
  const records = readRecords(lang);
  const keys = [];
  for (const [key, { value }] of english) {
    if (!translatable(value) || !own.has(key)) continue;
    const record = records[key];
    const stale = record && record.en !== value;
    const untouched = !record && own.get(key).value === value;
    if (stale || untouched || AGAIN.has(key)) keys.push(key);
  }
  return keys;
}

const signs = (text) => (text.match(/\{\{[^}]*\}\}|<[^>]+>|%[sd]/g) ?? []).sort().join('|');

/** Why a translation cannot stand for its English, if it cannot. */
function wrong(en, text) {
  if (typeof text !== 'string' || !text.trim()) return 'empty';
  if (signs(en) !== signs(text)) return 'placeholders differ';
  // (A language that drops its subjects may drop the name with them: only a name spelled another way is wrong.)
  if (/コトミミ|코토미미|Котомими|كوتوميمي|โคโตมิมิ/.test(text)) return 'the name is spelled out';
  return null;
}

const prompt = (lang, keys) => `You are translating the interface of Kotomimi, a desktop app for live speech translation (subtitles for voice chat, VRChat, calls), into ${NAMES[lang]}.

Do not read or change any file. Answer only with the JSON asked for.

Rules:
- Natural, short interface wording that a native speaker would expect in a desktop app. Buttons and labels stay short. Friendly and plain for non-technical people.
- Each entry has its English, and its Simplified Chinese where there is one: that is the meaning the owner approved. Where they differ in nuance, follow the Chinese. The key tells you where the string sits.
- Keep exactly: {{placeholders}}, <tags>, %s, numbers, keyboard shortcuts, file names, URLs.
- Keep in Latin letters, untranslated: Kotomimi, Sokuji, VRChat, OSC, Qwen, Gemma, Gemini, OpenAI, Soniox, LocalAI, Kizuna AI, Apple Speech, ModelScope, Hugging Face, API, GGUF, model names, and other product names.
- Technical terms such as furigana, pinyin, romanization: use what readers of ${NAMES[lang]} normally call them.
- Translate everything else. If a string truly stays the same in ${NAMES[lang]} (a bare name), give it unchanged.

Answer with one JSON object, key to translation, between these two lines and nothing else:
<<<JSON
{"key": "translation"}
JSON>>>

Strings:
${JSON.stringify(Object.fromEntries(keys.map((key) => [key, { en: english.get(key).value, ...(simplified.has(key) && simplified.get(key).value !== english.get(key).value ? { zh: simplified.get(key).value } : {}) }])), null, 1)}
`;

function askCodex(text) {
  return new Promise((resolve, reject) => {
    // Through the owner's own config: its gateway (Codex++) must be running, or the request waits for ever.
    const child = spawn('codex', ['exec', '--ephemeral', '-m', MODEL, '--sandbox', 'read-only', '--skip-git-repo-check', '-c', 'model_reasoning_effort=low', '-'], { shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      const found = [...out.matchAll(/<<<JSON\s*([\s\S]*?)\s*JSON>>>/g)].pop();
      if (found) { try { resolve(JSON.parse(found[1])); return; } catch { /* said below */ } }
      reject(new Error(`codex (${code}): ${(err || out).slice(-300)}`));
    });
    child.stdin.end(text);
  });
}

let quota = false;

async function fill(lang) {
  const keys = missingIn(lang).slice(0, LIMIT);
  let done = 0;
  const left = [];
  for (let at = 0; at < keys.length && !quota; at += BATCH) {
    const batch = keys.slice(at, at + BATCH);
    let answer;
    try {
      answer = await askCodex(prompt(lang, batch));
    } catch (error) {
      console.log(`${lang}: a batch failed: ${String(error.message).slice(0, 240)}`);
      if (/quota|rate limit|usage limit|429/i.test(String(error.message))) quota = true;
      left.push(...batch);
      continue;
    }
    const { text, catalog } = readCatalog(lang);
    const own = flatten(catalog);
    const records = readRecords(lang);
    for (const key of batch) {
      const en = english.get(key).value;
      const why = wrong(en, answer[key]);
      if (why) { console.log(`${lang}: ${key}: ${why}`); left.push(key); continue; }
      setAt(catalog, own.get(key).at, answer[key]);
      records[key] = { en, text: answer[key] };
      done += 1;
    }
    writeCatalog(lang, catalog, text);
    writeRecords(lang, records);
    console.log(`${lang}: ${done}/${keys.length}`);
  }
  return { lang, done, left: left.length };
}

const langs = locales().filter((lang) => !ONLY.length || ONLY.includes(lang));
if (!MODEL && !has('check')) throw new Error('Which model? --model <name>: ask the owner, it is on their subscription.');
if (has('check')) {
  let total = 0;
  for (const lang of langs) { const count = missingIn(lang).length; total += count; console.log(`${lang}: ${count}`); }
  console.log(`missing: ${total}`);
  process.exit(0);
}

const queue = [...langs];
const results = [];
await Promise.all(Array.from({ length: JOBS }, async () => {
  for (let lang = queue.shift(); lang && !quota; lang = queue.shift()) results.push(await fill(lang));
}));
for (const { lang, done, left } of results) console.log(`${lang}: wrote ${done}, left ${left}`);
if (quota) console.log('stopped: Codex is out of quota. What was written is kept: run this again later.');
process.exit(results.some((r) => r.left > 0) || quota ? 1 : 0);
