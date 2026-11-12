const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

/**
 * Fork: the icon Windows shows for the app in its list of installed apps, put where Squirrel looks for it before the
 * hook returns. Squirrel opens the app first and then downloads that icon from the package's `iconUrl`, its install
 * animation left on the screen until the download ends: with raw.githubusercontent.com slow or out of reach, a friend
 * of the user's had it over the open app (2026-11-11). With `app.ico` already there it downloads nothing, and sets no
 * `DisplayIcon` either, which is set here instead.
 */
function placeUninstallIcon({ execPath = process.execPath, resourcesPath = process.resourcesPath, beta = /-beta\./.test(app.getVersion()), files = fs, run = spawnSync } = {}) {
  const root = path.dirname(path.dirname(execPath));
  const target = path.join(root, 'app.ico');
  const source = [path.join(resourcesPath, beta ? 'assets/beta' : 'assets', 'icon.ico'), path.join(resourcesPath, 'assets', 'icon.ico')].find((file) => files.existsSync(file));
  if (!source) return null;
  try {
    files.copyFileSync(source, target);
  } catch {
    return null;
  }
  // The key Squirrel writes its entry under, named as the package is.
  const name = path.basename(root);
  run('reg.exe', ['add', `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${name}`, '/v', 'DisplayIcon', '/t', 'REG_SZ', '/d', target, '/f'], { windowsHide: true, timeout: 5000 });
  return target;
}

function handleSquirrelEvent() {
  if (process.argv.length === 1) {
    return false;
  }

  const appFolder = path.resolve(process.execPath, '..');
  const rootAtomFolder = path.resolve(appFolder, '..');
  const updateDotExe = path.resolve(path.join(rootAtomFolder, 'Update.exe'));
  const exeName = path.basename(process.execPath);

  const spawnUpdate = function(args) {
    return spawn(updateDotExe, args, { detached: true });
  };

  const squirrelEvent = process.argv[1];

  switch (squirrelEvent) {
    case '--squirrel-install':
    case '--squirrel-updated':
      // Create shortcuts on Desktop and Start Menu
      console.log('[Sokuji] Creating shortcuts for:', exeName);
      spawnUpdate(['--createShortcut', exeName]);
      try { placeUninstallIcon(); } catch { /* the list's icon is a convenience */ }

      // Always quit when done
      setTimeout(app.quit, 1000);
      return true;

    case '--squirrel-uninstall':
      // Remove shortcuts
      console.log('[Sokuji] Removing shortcuts for:', exeName);
      spawnUpdate(['--removeShortcut', exeName]);

      // Always quit when done
      setTimeout(app.quit, 1000);
      return true;

    case '--squirrel-obsolete':
      // This is called on the outgoing version before update
      console.log('[Sokuji] Handling obsolete version');
      app.quit();
      return true;
  }

  return false;
}

module.exports = handleSquirrelEvent;
module.exports.placeUninstallIcon = placeUninstallIcon;
