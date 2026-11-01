// @vitest-environment node
// The repository's docs against their ledger, and the rules the ledger leans on.
import { describe, it, expect } from 'vitest';
import { citedPaths, checkTree, datedLines } from './check-docs.mjs';

describe('docs', () => {
  it('stay within the ledger', () => {
    expect(checkTree()).toEqual([]);
  }, 20000);
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
