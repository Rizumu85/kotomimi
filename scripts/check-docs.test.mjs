// @vitest-environment node
// The repository's docs against their ledger, and the rules the ledger leans on.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkStaged, citedPaths, checkTree, datedLines } from './check-docs.mjs';

describe('docs', () => {
  it('stay within the ledger', () => {
    expect(checkTree()).toEqual([]);
  }, 20000);
});

describe('checkStaged', () => {
  const inRepo = (run) => {
    const root = mkdtempSync(join(tmpdir(), 'check-docs-'));
    const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, stdio: 'pipe' });
    const write = (file, text) => writeFileSync(join(root, file), text);
    try {
      git('init', '-q');
      mkdirSync(join(root, 'scripts'));
      write('scripts/docs-ledger.json', JSON.stringify({ 'LISTED.md': { bytes: 10, dated: 0 } }));
      write('LISTED.md', 'short\n');
      write('OTHER.md', 'one line\n');
      git('add', '-A');
      git('commit', '-qm', 'start');
      run({ root, git, write });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  it('judges what was staged, not the working copy', () => {
    inRepo(({ root, git, write }) => {
      write('LISTED.md', 'far too long for its cap\n');
      git('add', 'LISTED.md');
      write('LISTED.md', 'short\n');
      expect(checkStaged(root)).toEqual([expect.stringContaining('over its cap')]);
    });
  });

  it('sees an unlisted doc grow within a line', () => {
    inRepo(({ root, git, write }) => {
      write('OTHER.md', 'one line, and a great deal more of it\n');
      git('add', 'OTHER.md');
      expect(checkStaged(root)).toEqual([expect.stringContaining('grows by')]);
    });
  });

  it('lets an unlisted doc change in place', () => {
    inRepo(({ root, git, write }) => {
      write('OTHER.md', 'two line\n');
      git('add', 'OTHER.md');
      expect(checkStaged(root)).toEqual([]);
    });
  });
});

describe('datedLines', () => {
  it('counts a date in prose', () => {
    expect(datedLines('## A heading (2026-10-06)\nmeasured on 2026-10-12\nplain\nin 2026-10')).toBe(3);
  });

  it('leaves a date inside a path or a name alone', () => {
    expect(datedLines('docs/superpowers/specs/2026-10-04-lan-design.md\n`2026-10-04-lan.md`\nbackup-20261022')).toBe(0);
  });

  it('leaves a code block alone', () => {
    expect(datedLines('```\n2026-10-06\n```\ntext')).toBe(0);
  });
});

describe('citedPaths', () => {
  it('finds paths in backticks and relative links', () => {
    expect(citedPaths('`electron/main.js:12` and [spec](docs/a.md#b) and [web](https://x.y/z.md)')).toEqual(['electron/main.js', 'docs/a.md']);
  });

  it('leaves the local helpers, routes and bare names alone', () => {
    expect(citedPaths('`.dev/tools/relaunch.sh`, `/v1/audio/transcriptions`, `main.js`')).toEqual([]);
  });
});
