// @vitest-environment node
// Fork: the icon in the notification area.
import { describe, expect, it, vi } from 'vitest';

const path = require('path');
const { createTray, iconFile, wordsFor } = require('./tray.js');

/** A notification area that remembers what it was given. */
function area() {
  const made = [];
  class Tray {
    constructor(icon) {
      this.icon = icon;
      this.handlers = {};
      this.gone = false;
      made.push(this);
    }
    setToolTip(text) { this.tip = text; }
    setContextMenu(menu) { this.menu = menu; }
    on(event, run) { this.handlers[event] = run; }
    isDestroyed() { return this.gone; }
    destroy() { this.gone = true; }
  }
  const Menu = { buildFromTemplate: (template) => template };
  return { Tray, Menu, made };
}

describe('the icon in the notification area', () => {
  it('shows the window at a click, and offers to show it or to quit in its menu', () => {
    const { Tray, Menu, made } = area();
    const show = vi.fn();
    const quit = vi.fn();
    const tray = createTray({ Tray, Menu, platform: 'win32', locale: 'zh-CN', icon: 'C:\\app\\assets\\icon.ico', show, quit });
    expect(tray).not.toBeNull();
    expect(made).toHaveLength(1);
    expect(made[0].icon).toBe('C:\\app\\assets\\icon.ico');
    expect(made[0].tip).toBe('Kotomimi');
    made[0].handlers.click();
    expect(show).toHaveBeenCalledTimes(1);
    expect(made[0].menu.map((entry) => entry.label ?? entry.type)).toEqual(['显示 Kotomimi', 'separator', '退出']);
    made[0].menu[0].click();
    expect(show).toHaveBeenCalledTimes(2);
    expect(quit).not.toHaveBeenCalled();
    made[0].menu[2].click();
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('is taken away with the app, once', () => {
    const { Tray, Menu, made } = area();
    const tray = createTray({ Tray, Menu, platform: 'win32', locale: 'en', icon: 'icon.ico', show: () => {}, quit: () => {} });
    tray.destroy();
    expect(made[0].gone).toBe(true);
    expect(() => tray.destroy()).not.toThrow();
  });

  it('is not made on a Mac, without its file, or where the system has no place for it', () => {
    const { Tray, Menu, made } = area();
    expect(createTray({ Tray, Menu, platform: 'darwin', locale: 'en', icon: 'icon.png', show: () => {}, quit: () => {} })).toBeNull();
    expect(createTray({ Tray, Menu, platform: 'win32', locale: 'en', icon: null, show: () => {}, quit: () => {} })).toBeNull();
    expect(made).toHaveLength(0);
    class Refusing { constructor() { throw new Error('no notification area'); } }
    expect(createTray({ Tray: Refusing, Menu, platform: 'linux', locale: 'en', icon: 'icon.png', show: () => {}, quit: () => {} })).toBeNull();
  });

  it('speaks the system\u2019s language, and English where it has no words for it', () => {
    expect(wordsFor('zh-CN').quit).toBe('退出');
    expect(wordsFor('zh').show).toBe('显示 Kotomimi');
    expect(wordsFor('zh-TW').quit).toBe('結束');
    expect(wordsFor('zh-Hant-HK').quit).toBe('結束');
    expect(wordsFor('ja').quit).toBe('終了');
    expect(wordsFor('en-US').quit).toBe('Quit');
    expect(wordsFor('fr').quit).toBe('Quit');
    expect(wordsFor(undefined).show).toBe('Show Kotomimi');
  });

  it('finds its file beside the packaged app\u2019s resources, and in the repository otherwise', () => {
    const packaged = path.join('C:\\app\\resources', 'assets', 'icon.ico');
    const repo = path.join('C:\\repo\\dist-electron', '..', 'assets', 'icon.ico');
    const ask = (there) => iconFile({ platform: 'win32', resourcesPath: 'C:\\app\\resources', here: 'C:\\repo\\dist-electron', exists: (file) => there.includes(file) });
    expect(ask([packaged, repo])).toBe(packaged);
    expect(ask([repo])).toBe(repo);
    expect(ask([])).toBeNull();
    // A PNG where the system does not read .ico files.
    expect(iconFile({ platform: 'linux', resourcesPath: '/opt/app/resources', here: '/opt/app/x', exists: () => true })).toBe(path.join('/opt/app/resources', 'assets', 'icon.png'));
  });
});
