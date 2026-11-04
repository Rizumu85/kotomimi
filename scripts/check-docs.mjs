// scripts/check-docs.mjs
//
// Docs are not a work log. FORK.md went from 10 KB to 218 KB in a month because
// every feature and fix added to it; this is what stops that. Run bare it checks
// the working copy (the release does, through check-docs.test.mjs); with --staged
// it checks the index instead, what the commit holds, and what the commit does to
// the ledger (.githooks/pre-commit does): a note beside the work holds up nothing.
//
// The ledger, scripts/docs-ledger.json, is per file: `bytes`, a cap, and `dated`,
// the lines that may carry a date, which is how a diary starts. Both only go down.
// Whoever wants more of a doc has to take something out first. A doc the ledger
// does not list may not grow at all, and a new one may not appear.
//
// A merge is not checked here (the hook skips it): upstream's docs come in with
// upstream, and the merge commit moves the ledger with them.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER = 'scripts/docs-ledger.json';
const FORK_DOCS = 'docs/fork/';
// What grows by nature: one file per release, the licence texts of the dependencies, and the root READMEs, the app's
// introduction in each language, which the user wants unlimited (2026-11-03).
const FREE = [/^release-notes\//, /^CHANGELOG\.md$/, /^THIRD_PARTY_NOTICES\.md$/, /^README(\.[a-z]{2})?\.md$/];
const REFUSED = 'Docs hold what is true now, not what happened: change the stale fact in place, and put measured '
  + 'numbers in docs/fork/measurements.md. Only the user can ask for more; see "Docs are not a work log" in CLAUDE.md.';

const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
const lines = (text) => text.split('\n').filter(Boolean);
// LF, whatever the checkout: core.autocrlf must not move a cap.
const toLf = (text) => text.replace(/\r\n/g, '\n');
const isFree = (file) => FREE.some((re) => re.test(file));

// Where a check reads. The working copy, with what is not yet tracked:
export const workingCopy = (root) => ({
  files: lines(git(root, 'ls-files', '--cached', '--others', '--exclude-standard')),
  exists: (file) => existsSync(join(root, file)),
  read: (file) => toLf(readFileSync(join(root, file), 'utf8')),
  grep: [],
});

// Or the index, which is what lands. Its paths are exact: what a case-insensitive disk would pass, a checkout on Linux would not.
export const theIndex = (root) => {
  const files = lines(git(root, 'ls-files', '--cached'));
  const present = new Set();
  for (const file of files) for (let p = file; p !== '.'; p = posix.dirname(p)) present.add(p);
  return {
    files,
    exists: (file) => present.has(file.replace(/\/$/, '')),
    read: (file) => toLf(git(root, 'show', `:${file}`)),
    grep: ['--cached'],
  };
};

// A date in prose. One inside a path or a name (2026-10-04-lan-design.md) is not.
const DATE = /(?<![\w/.-])20\d\d-\d\d(?:-\d\d)?(?![\w-])/;
export const datedLines = (text) => {
  let fenced = false;
  return text.split('\n').filter((line) => {
    if (line.startsWith('```')) fenced = !fenced;
    return !fenced && DATE.test(line);
  }).length;
};

// `path/with/a.slash` and [text](relative/link): what a doc says exists. Only a file
// with an extension counts, so a route or a glob is not taken for a path, and .dev/
// is the local helpers, not in a checkout.
export const citedPaths = (text) => {
  const found = new Set();
  for (const m of text.matchAll(/`([\w.-]+(?:\/[\w.-]+)+\.[A-Za-z]\w*)(?::\d+)?`/g)) found.add(m[1]);
  for (const m of text.matchAll(/\]\((?!https?:|mailto:|#)([^)#\s]+)(?:#[^)]*)?\)/g)) found.add(m[1]);
  return [...found].filter((p) => !p.startsWith('.dev/'));
};

// The headings a file has, for code that cites one by name.
const headings = (text) => lines(text).filter((l) => /^#+ /.test(l)).map((l) => l.replace(/^#+\s*/, '').trim());

const overLedger = (file, text, { bytes, dated }) => {
  const over = [];
  const size = Buffer.byteLength(text);
  if (size > bytes) over.push(`${file}: ${size} bytes, over its cap of ${bytes}`);
  const count = datedLines(text);
  if (count > dated) over.push(`${file}: ${count} dated lines, over its ${dated}`);
  return over;
};

// Code that names a doc. git grep says "none" by exiting with 1.
const citations = (root, source) => {
  try {
    return git(root, 'grep', ...source.grep, '-nE', '(FORK\\.md|docs/fork/[a-z-]+\\.md)', '--', ':!*.md', ':!scripts/check-docs*', `:!${LEDGER}`);
  } catch (err) {
    if (err.status === 1) return '';
    throw err;
  }
};

export function checkTree(root = REPO_ROOT, source = workingCopy(root)) {
  const problems = [];
  const ledger = JSON.parse(source.read(LEDGER));

  for (const [file, row] of Object.entries(ledger)) {
    if (!source.exists(file)) { problems.push(`${file}: in the ledger, but there is no such file`); continue; }
    const text = source.read(file);
    problems.push(...overLedger(file, text, row));
    if (file === 'FORK.md' || file.startsWith(FORK_DOCS)) {
      for (const p of citedPaths(text)) {
        const beside = posix.normalize(posix.join(posix.dirname(file), p));
        if (!source.exists(p) && !source.exists(beside)) problems.push(`${file}: cites ${p}, which does not exist`);
      }
    }
  }

  for (const file of source.files) {
    if (!file.endsWith('.md') || ledger[file] || isFree(file)) continue;
    if (!file.includes('/') || file.startsWith(FORK_DOCS)) problems.push(`${file}: not in the ledger`);
  }

  for (const hit of lines(citations(root, source))) {
    const at = hit.split(':').slice(0, 2).join(':');
    const m = hit.match(/(FORK\.md|docs\/fork\/[a-z-]+\.md)(?:[,:]\s*(?:section\s*)?"([^"]+)")?/);
    if (!m) continue;
    const [, doc, section] = m;
    if (!source.exists(doc)) { problems.push(`${at}: cites ${doc}, which does not exist`); continue; }
    if (section && !headings(source.read(doc)).some((h) => h.includes(section))) problems.push(`${at}: cites "${section}", no such heading in ${doc}`);
  }
  return problems;
}

// What the tree cannot show: what this commit does to the ledger, and to the docs. The index, not
// the working copy, is what lands, so a doc shortened after `git add` is judged as it was added.
export function checkStaged(root = REPO_ROOT) {
  const problems = [];
  const show = (ref) => toLf(git(root, 'show', ref));
  const stagedDocs = (filter) => lines(git(root, 'diff', '--cached', '--no-renames', '--name-only', `--diff-filter=${filter}`, '--', '*.md'));
  const added = new Set(stagedDocs('A'));
  const ledger = JSON.parse(show(`:${LEDGER}`));
  for (const file of stagedDocs('AM')) {
    if (isFree(file)) continue;
    const text = show(`:${file}`);
    if (ledger[file]) { problems.push(...overLedger(file, text, ledger[file])); continue; }
    if (added.has(file)) { problems.push(`${file}: a new .md file`); continue; }
    const grew = Buffer.byteLength(text) - Buffer.byteLength(show(`HEAD:${file}`));
    if (grew > 0) problems.push(`${file}: grows by ${grew} bytes`);
  }
  let before = {};
  try { before = JSON.parse(show(`HEAD:${LEDGER}`)); } catch { return problems; }
  for (const [file, row] of Object.entries(ledger)) {
    const was = before[file];
    if (!was) problems.push(`${LEDGER}: adds ${file}`);
    else if (row.bytes > was.bytes) problems.push(`${LEDGER}: raises ${file} from ${was.bytes} to ${row.bytes} bytes`);
    else if (row.dated > was.dated) problems.push(`${LEDGER}: raises ${file} from ${was.dated} to ${row.dated} dated lines`);
  }
  return problems;
}

// import.meta.url is the real path: argv's, through a link, would not match it, and nothing would be checked.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const staged = process.argv.includes('--staged');
  const problems = new Set(checkTree(REPO_ROOT, staged ? theIndex(REPO_ROOT) : workingCopy(REPO_ROOT)));
  if (staged) for (const problem of checkStaged()) problems.add(problem);
  if (problems.size) {
    console.error(`check-docs: ${problems.size} problem(s)\n${[...problems].map((p) => `  ${p}`).join('\n')}\n\n${REFUSED}`);
    process.exit(1);
  }
}
