// Fork: what the page may ask the system to open (open-guards.js).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const { webUrl, folderPath } = createRequire(import.meta.url)('./open-guards.js');

describe('a link the page asks to open', () => {
  it('is a web address', () => {
    expect(webUrl('https://github.com/Rizumu85/kotomimi/releases')).toBe('https://github.com/Rizumu85/kotomimi/releases');
    expect(webUrl(' http://example.com/a?b=1 ')).toBe('http://example.com/a?b=1');
  });

  it('is nothing else: another scheme, a file, a program', () => {
    for (const value of ['file:///C:/Windows/System32/calc.exe', 'ms-settings:privacy', 'javascript:alert(1)', 'C:\\Windows\\System32\\calc.exe', 'mailto:a@b.c', '', 'not a url', null, undefined, 42, {}]) {
      expect(webUrl(value), String(value)).toBeNull();
    }
  });
});

describe('a folder the page asks to open', () => {
  it('is a folder that is there, by its whole path', () => {
    expect(folderPath(os.tmpdir())).toBe(path.normalize(os.tmpdir()));
  });

  it('is not a file, a path that is not there, or one that is not whole', () => {
    expect(folderPath(process.execPath)).toBeNull();
    expect(folderPath(path.join(os.tmpdir(), 'kotomimi-no-such-folder-0f3a'))).toBeNull();
    expect(folderPath('recordings')).toBeNull();
    for (const value of ['', null, undefined, 42, {}]) expect(folderPath(value), String(value)).toBeNull();
  });
});
