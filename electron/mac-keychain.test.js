// @vitest-environment node
// electron/mac-keychain.test.js
//
// Fork: on a Mac the app does not ask the system keychain for Chromium's cookie key — macOS asks the person for it
// after every update of an app that is not signed by an Apple team (FORK.md, "macOS 的签名"). The switch that does
// this has to be set before the app is ready, on macOS alone, and nothing may read the keychain by another way.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

describe('the system keychain on a Mac', () => {
  it('is left alone: the switch is set on macOS, and only there', () => {
    expect(main).toMatch(/if \(process\.platform === 'darwin'\) app\.commandLine\.appendSwitch\('use-mock-keychain'\);/);
    expect(main.match(/use-mock-keychain/g)).toHaveLength(1);
  });

  it('is set before the app is ready: Chromium reads it when it first wants the key', () => {
    expect(main.indexOf("appendSwitch('use-mock-keychain')")).toBeGreaterThan(-1);
    expect(main.indexOf("appendSwitch('use-mock-keychain')")).toBeLessThan(main.indexOf('app.whenReady('));
  });

  it('keeps nothing of the app\'s own under that key: a secret stored through it would be protected by nothing', () => {
    for (const file of fs.readdirSync(__dirname).filter((name) => name.endsWith('.js') && !name.endsWith('.test.js'))) {
      expect(fs.readFileSync(path.join(__dirname, file), 'utf8'), file).not.toMatch(/safeStorage/);
    }
  });
});
