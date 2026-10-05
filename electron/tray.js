// Fork: an icon in the notification area.
//
// The app can be running with no window to show for it: a start in the
// background at sign-in (`autostart.js`) makes one and keeps it hidden until
// the app is opened a second time. The icon is what says it is there — a
// click shows the window, and its menu can quit it without showing it first.
//
// Closing the window still quits the app, as before: the icon does not keep
// it alive. Windows and Linux; a Mac has the Dock for this.
const path = require('path');

const NAME = 'Kotomimi';

/** The menu's two entries, in the system's language: the page's own language is not known here. */
const WORDS = {
  en: { show: `Show ${NAME}`, quit: 'Quit' },
  'zh-CN': { show: `显示 ${NAME}`, quit: '退出' },
  'zh-TW': { show: `顯示 ${NAME}`, quit: '結束' },
  ja: { show: `${NAME} を表示`, quit: '終了' },
  ko: { show: `${NAME} 표시`, quit: '종료' },
};

function wordsFor(locale) {
  const tag = String(locale ?? '').toLowerCase();
  if (/^zh[-_](tw|hk|mo|hant)/.test(tag)) return WORDS['zh-TW'];
  if (tag.startsWith('zh')) return WORDS['zh-CN'];
  return WORDS[tag.split(/[-_]/)[0]] ?? WORDS.en;
}

/** Where the icon's file is: beside the packaged app's resources, or in the repository. */
function iconFile({ platform = process.platform, resourcesPath = process.resourcesPath, here = __dirname, exists }) {
  const name = platform === 'win32' ? 'icon.ico' : 'icon.png';
  const places = [resourcesPath ? path.join(resourcesPath, 'assets', name) : null, path.join(here, '..', 'assets', name)].filter(Boolean);
  return places.find((file) => exists(file)) ?? null;
}

/**
 * The icon, made once the app is ready. Null where there is none to make: a
 * Mac, a missing file, a system with no notification area. `show` brings the
 * window up; `quit` ends the app the way closing its window does.
 */
function createTray({ Tray, Menu, platform = process.platform, locale, icon, show, quit }) {
  if (platform === 'darwin' || !icon) return null;
  let tray;
  try {
    tray = new Tray(icon);
  } catch {
    return null;
  }
  const words = wordsFor(locale);
  tray.setToolTip(NAME);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: words.show, click: () => show() },
    { type: 'separator' },
    { label: words.quit, click: () => quit() },
  ]));
  tray.on('click', () => show());
  return {
    /** Taken away with the app: left behind, Windows keeps a dead icon until the pointer passes over it. */
    destroy() {
      try {
        if (!tray.isDestroyed()) tray.destroy();
      } catch { /* already gone */ }
    },
  };
}

module.exports = { createTray, iconFile, wordsFor, WORDS };
