const fs = require('node:fs/promises');
const path = require('node:path');
const { CAPTURE_FORMAT, CAPTURE_VERSION, CAPTURE_MAX_BYTES, captureError } = require('../src/lib/subtitle/captureFormat.js');

const pad = (n, width = 2) => String(n).padStart(width, '0');
function timestamp(date) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`;
}

/** The main process owns metadata and the path; a renderer can supply only caption data and its UI language. */
async function writeSubtitleCapture({ userData, payload, appVersion, platform, showItemInFolder, now = new Date() }) {
  try {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, error: 'Invalid subtitle capture payload.' };
    const capture = { ...payload, format: CAPTURE_FORMAT, version: CAPTURE_VERSION, appVersion, platform };
    const error = captureError(capture);
    if (error) return { ok: false, error };
    const content = JSON.stringify(capture);
    if (Buffer.byteLength(content, 'utf8') > CAPTURE_MAX_BYTES * 2) return { ok: false, error: 'Subtitle capture exceeds the file size limit.' };
    const dir = path.join(userData, 'subtitle-captures');
    await fs.mkdir(dir, { recursive: true });
    const base = timestamp(now);
    for (let n = 0; n < 100; n++) {
      const file = path.join(dir, `${base}${n ? ` (${n})` : ''}.json`);
      try {
        await fs.writeFile(file, content, { encoding: 'utf8', flag: 'wx' });
      } catch (cause) {
        if (cause.code === 'EEXIST') continue;
        throw cause;
      }
      showItemInFolder(file);
      return { ok: true, path: file };
    }
    return { ok: false, error: 'Too many subtitle captures with the same timestamp.' };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

function setupSubtitleCaptureHandler({ ipcMain, app, shell, isTrustedSender }) {
  ipcMain.handle('subtitle:save-capture', (event, payload) => {
    if (!isTrustedSender(event.sender)) return { ok: false, error: 'Subtitle capture refused: not the main window.' };
    return writeSubtitleCapture({ userData: app.getPath('userData'), payload, appVersion: app.getVersion(),
      platform: process.platform, showItemInFolder: (file) => shell.showItemInFolder(file) });
  });
}

module.exports = { writeSubtitleCapture, setupSubtitleCaptureHandler };
