// electron/squirrel-events.test.js
//
// Fork: the install hook leaves the list-of-apps icon where Squirrel would otherwise download it from the network.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';

// Loaded with Node's require, a fake 'electron' seeded in its cache (as subtitle-window.test.js does).
const nodeRequire = createRequire(import.meta.url);
nodeRequire.cache[nodeRequire.resolve('electron')] = { exports: { app: { getVersion: () => '0.43.160', quit: () => {} } } };
const { placeUninstallIcon } = nodeRequire('./squirrel-events.js');

const ROOT = path.join('C:', 'Users', 'u', 'AppData', 'Local', 'Kotomimi');
const execPath = path.join(ROOT, 'app-0.43.160', 'kotomimi.exe');
const resourcesPath = path.join(ROOT, 'app-0.43.160', 'resources');

function disk(present) {
  const copied = [];
  return { copied, files: { existsSync: (file) => present.includes(file), copyFileSync: (from, to) => copied.push([from, to]) } };
}

describe('the icon in the list of installed apps (fork)', () => {
  it('is copied to app.ico in the install root, and the uninstall entry pointed at it', () => {
    const { copied, files } = disk([path.join(resourcesPath, 'assets', 'icon.ico')]);
    const runs = [];
    const target = placeUninstallIcon({ execPath, resourcesPath, beta: false, files, run: (...args) => runs.push(args) });
    expect(target).toBe(path.join(ROOT, 'app.ico'));
    expect(copied).toEqual([[path.join(resourcesPath, 'assets', 'icon.ico'), path.join(ROOT, 'app.ico')]]);
    expect(runs[0][0]).toBe('reg.exe');
    expect(runs[0][1]).toEqual(['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Kotomimi', '/v', 'DisplayIcon', '/t', 'REG_SZ', '/d', path.join(ROOT, 'app.ico'), '/f']);
  });

  it('is the beta’s own in the beta, and nothing is done without an icon to copy', () => {
    const beta = disk([path.join(resourcesPath, 'assets', 'beta', 'icon.ico'), path.join(resourcesPath, 'assets', 'icon.ico')]);
    placeUninstallIcon({ execPath, resourcesPath, beta: true, files: beta.files, run: () => {} });
    expect(beta.copied[0][0]).toBe(path.join(resourcesPath, 'assets', 'beta', 'icon.ico'));
    const none = disk([]);
    const runs = [];
    expect(placeUninstallIcon({ execPath, resourcesPath, beta: false, files: none.files, run: (...args) => runs.push(args) })).toBeNull();
    expect(runs).toEqual([]);
  });
});
