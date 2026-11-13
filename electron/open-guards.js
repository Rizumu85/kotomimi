// Fork: what the page may ask the system to open.
//
// The page asks for two things by a string of its own: a link in the browser, and a folder in the file manager. The
// system's own "open" takes far more than those — any scheme a program has registered, and any file, a program
// among them, which it then runs. So each is held to what the app asks for: a web address, and a folder that is
// there. No Electron import: tested as it is.
const fs = require('fs');
const path = require('path');

/** A web address as it is opened, or null for anything else: another scheme, no address at all. */
function webUrl(value) {
  if (typeof value !== 'string') return null;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
}

/** A folder of this computer by its whole path, or null: a path that is not whole, not there, or a file. */
function folderPath(value, stat = fs.statSync) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return null;
  try {
    return stat(value).isDirectory() ? path.normalize(value) : null;
  } catch {
    return null;
  }
}

module.exports = { webUrl, folderPath };
