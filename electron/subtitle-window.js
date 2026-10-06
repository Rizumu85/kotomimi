// electron/subtitle-window.js
const { ipcMain, screen } = require('electron');
const { topmostLevel } = require('./topmost-level.js');
const { raiseVisiblePopovers } = require('./popover-windows.js');

// Window managers (esp. on Linux/X11/Wayland) apply setBounds() asynchronously.
// During the settling period, the resize event fires with intermediate values
// and mainWindow.getBounds() can still report the pre-setBounds size for
// hundreds of ms. If we forward those events to the renderer, the renderer
// persists the stale bounds as "subtitle bounds", overwriting the true
// subtitle dimensions. The TRANSITION_BLACKOUT_MS window gives the WM time
// to settle before we accept user-driven resize/move events.
const TRANSITION_BLACKOUT_MS = 600;

// Module-scope state shared by the IPC handlers below. createWindow() may be
// called more than once during an app's lifetime (notably on macOS, after
// the user closes the window and clicks the dock icon — see
// `app.on('activate')` in main.js). ipcMain.handle() throws on a second
// registration of the same channel, so registering the handlers inside
// setupSubtitleHandlers() — which runs per createWindow — would crash the
// next time the window is recreated. We register the handlers once at
// module load and have them resolve the *current* mainWindow at call time
// via the activeWindow reference that setupSubtitleHandlers() updates.
let activeWindow = null;
let normalBoundsSnapshot = null;
let transitionUntil = 0;

const beginTransition = () => {
  transitionUntil = Date.now() + TRANSITION_BLACKOUT_MS;
};

function clampToScreen(bounds, work) {
  const width = Math.min(bounds.width, work.width);
  const height = Math.min(bounds.height, work.height);
  const x = Math.max(work.x, Math.min(bounds.x, work.x + work.width - width));
  const y = Math.max(work.y, Math.min(bounds.y, work.y + work.height - height));
  return { x, y, width, height };
}

function defaultSubtitleBounds(work) {
  const width = Math.round(work.width * 0.8);
  const height = 200;
  return {
    x: work.x + Math.round((work.width - width) / 2),
    y: work.y + work.height - height - 80,
    width,
    height,
  };
}

function getLiveWindow() {
  return activeWindow && !activeWindow.isDestroyed() ? activeWindow : null;
}

// --- Always-on-top enforcement (#326) --------------------------------------
// On Windows, PowerPoint's slideshow / Presenter View re-asserts its own
// HWND_TOPMOST z-order whenever window activation changes. A one-shot
// setAlwaysOnTop() is displaced permanently the moment the pinned bar is
// merely clicked (activating it deactivates PowerPoint, which re-raises
// itself above us), and Electron emits no event for "another window went
// above us". Crucially, the displaced window KEEPS its WS_EX_TOPMOST style —
// isAlwaysOnTop() still returns true (electron/electron#2097) — so the fix
// must re-assert UNCONDITIONALLY while pinned:
//  - a short delayed re-assert on focus/blur — the activation transitions
//    that make PowerPoint re-raise itself — so recovery is near-immediate;
//  - a 1s heartbeat as a safety net for re-raises we get no event for
//    (PowerToys "Always On Top" survives PowerPoint the same way, via
//    WinEvent-triggered SetWindowPos(HWND_TOPMOST) re-pins).
// Each re-assert is one setAlwaysOnTop(true, ...) call — never a false→true
// toggle (drops us out of the topmost band and can knock OTHER topmost
// windows down, electron#31536) and never moveTop() (its SWP_SHOWWINDOW
// flag would force-show a hidden window). Windows-only: on macOS the
// 'floating' NSWindow level is a real window level honored by the WM, and
// periodic raises would be needless churn.
const PIN_REASSERT_INTERVAL_MS = 1000;
const PIN_REASSERT_EVENT_DELAY_MS = 200;

// A PowerPoint slideshow sits ABOVE the taskbar, so the bar has to be pinned
// at the top of the topmost band to beat it — see topmost-level.js for why
// Electron's default 'floating' level cannot. The popover child windows use
// the same level, so the two never end up in different bands.
const pinLevel = topmostLevel;

let pinHeartbeatTimer = null;
let pinEventTimer = null;

function reassertOnTop() {
  const win = getLiveWindow();
  if (!win) {
    stopPinEnforcement();
    return;
  }
  // Don't churn the z-order of a window the user can't see; enforcement
  // resumes on the next tick once the window is visible again.
  if (!win.isVisible() || win.isMinimized()) return;
  win.setAlwaysOnTop(true, pinLevel());
  // The bar just moved to the top of the topmost band — over its own open
  // popover, whose window is a sibling, not a child. Put the popover back
  // above it in the same breath, or every heartbeat buries the settings
  // panel the user is currently using.
  raiseVisiblePopovers();
}

function startPinEnforcement() {
  stopPinEnforcement();
  if (process.platform !== 'win32') return;
  pinHeartbeatTimer = setInterval(reassertOnTop, PIN_REASSERT_INTERVAL_MS);
}

function stopPinEnforcement() {
  if (pinHeartbeatTimer) {
    clearInterval(pinHeartbeatTimer);
    pinHeartbeatTimer = null;
  }
  if (pinEventTimer) {
    clearTimeout(pinEventTimer);
    pinEventTimer = null;
  }
}

// Deferred re-assert after a focus/blur transition: give the other window
// (PowerPoint) a moment to finish its own re-raise, then top it again.
function schedulePinReassert() {
  if (!pinHeartbeatTimer) return; // only while pinned
  if (pinEventTimer) clearTimeout(pinEventTimer);
  pinEventTimer = setTimeout(() => {
    pinEventTimer = null;
    reassertOnTop();
  }, PIN_REASSERT_EVENT_DELAY_MS);
}

ipcMain.handle('subtitle:get-screen-bounds', () => {
  const display = screen.getPrimaryDisplay();
  return display.workArea;
});

ipcMain.handle('subtitle:enter', (_event, payload) => {
  const win = getLiveWindow();
  if (!win) return { ok: false };
  const work = screen.getPrimaryDisplay().workArea;
  const requested = payload?.bounds ?? defaultSubtitleBounds(work);
  const clamped = clampToScreen(requested, work);

  normalBoundsSnapshot = win.getBounds();
  beginTransition();
  win.setBounds(clamped);
  win.setAlwaysOnTop(Boolean(payload?.alwaysOnTop), pinLevel());
  if (payload?.alwaysOnTop) {
    startPinEnforcement();
  } else {
    stopPinEnforcement();
  }
  win.setResizable(!payload?.locked);
  if (process.platform === 'darwin') {
    win.setWindowButtonVisibility(false);
  }
  return { ok: true, bounds: clamped };
});

ipcMain.handle('subtitle:exit', (_event, payload) => {
  const win = getLiveWindow();
  if (!win) return { ok: false };
  // Fork: the least height the lanes asked for is the subtitle window's, not the main window's — and the main window
  // takes its own clicks. What the last fit gave the strip is nothing to the window it becomes.
  restoreLeastSize(win);
  stopThrough(win);
  fitGave = null;
  // If the user exits subtitle mode while fullscreen, drop fullscreen first;
  // otherwise setBounds() fights the fullscreen state and the window can be
  // left stuck. Guarded to avoid a needless transition on the common path.
  //
  // KNOWN, ACCEPTED limitation (macOS): setFullScreen(false) animates
  // asynchronously, so the synchronous setBounds() below can land before the
  // Space transition finishes, leaving the window slightly mis-sized when
  // exiting subtitle mode DIRECTLY from fullscreen via the ✕ button. The
  // layered-ESC path (fullscreen → windowed → exit) is unaffected. We keep
  // native setFullScreen (not setSimpleFullScreen) because it emits
  // enter/leave-full-screen, which the subtitle:fullscreen-changed sync relies
  // on. If revisited, defer setBounds to the leave-full-screen event rather
  // than switching fullscreen modes.
  if (win.isFullScreen()) win.setFullScreen(false);
  const restore = payload?.restoreBounds ?? normalBoundsSnapshot ?? { width: 1200, height: 800 };
  beginTransition();
  if (restore.x !== undefined && restore.y !== undefined) {
    win.setBounds(restore);
  } else {
    const display = screen.getPrimaryDisplay().workArea;
    win.setBounds({
      x: display.x + Math.round((display.width - 1200) / 2),
      y: display.y + Math.round((display.height - 800) / 2),
      width: 1200,
      height: 800,
    });
  }
  stopPinEnforcement();
  win.setAlwaysOnTop(false);
  win.setResizable(true);
  if (process.platform === 'darwin') {
    win.setWindowButtonVisibility(true);
  }
  normalBoundsSnapshot = null;
  return { ok: true };
});

ipcMain.handle('subtitle:set-always-on-top', (_event, flag) => {
  const win = getLiveWindow();
  if (!win) return { ok: false };
  win.setAlwaysOnTop(Boolean(flag), pinLevel());
  if (flag) {
    startPinEnforcement();
  } else {
    stopPinEnforcement();
  }
  return { ok: true };
});

// Fork: the subtitle view's lanes are laid out for a height that follows the font size chosen
// (src/lib/subtitle/lanes.ts), and can be squeezed into no less than a least height. `height`: the window takes it,
// with its bottom edge where it is — a caption strip sits low on the screen and grows upwards — and its place and
// width as they are. `least`: the window can be dragged no lower than it; 0 lifts that. Only in subtitle mode, and
// no height while the window fills the screen.
const FIT_HEIGHT_MIN = 40;
/** The window's least size as it was before the lanes asked for one. */
let leastBefore = null;
function restoreLeastSize(win) {
  if (!leastBefore) return;
  win.setMinimumSize(leastBefore[0], leastBefore[1]);
  leastBefore = null;
}
/**
 * The size the last fit gave the window, to know the window by when it is asked again. A window on a display scaled by
 * a fraction does not read back the size it was given: set 264 high at 135 %, it reads 265 or 266, and a pixel or two
 * wider. Compared with what it reads, every ask — the same height, at each start and each stop of a run — found the
 * window "wrong" and set it again from what it read: two pixels lower and one or two wider each time (the user,
 * 2026-10-06: "the window still moves a little when a run starts and stops"). So a window that reads within this
 * much of what the fit gave it is taken to be that size still.
 */
let fitGave = null;
const FIT_READS_WITHIN = 2;
const stillAs = (read, gave) => gave !== null && Math.abs(read - gave) <= FIT_READS_WITHIN;
ipcMain.handle('subtitle:fit-height', (_event, payload) => {
  const win = getLiveWindow();
  if (!win || normalBoundsSnapshot === null) return { ok: false };
  const least = Math.round(Number(payload?.least));
  if (Number.isFinite(least)) {
    if (least >= FIT_HEIGHT_MIN) {
      if (!leastBefore) leastBefore = win.getMinimumSize();
      win.setMinimumSize(leastBefore[0], least);
    } else {
      restoreLeastSize(win);
    }
  }
  const height = Math.round(Number(payload?.height));
  if (!Number.isFinite(height) || height < FIT_HEIGHT_MIN || win.isFullScreen()) return { ok: true };
  const read = win.getBounds();
  // The size the fit left it at, where it still reads as that; else what it reads — the user has resized it since.
  const bounds = {
    x: read.x,
    y: read.y,
    width: stillAs(read.width, fitGave?.width ?? null) ? fitGave.width : read.width,
    height: stillAs(read.height, fitGave?.height ?? null) ? fitGave.height : read.height,
  };
  if (bounds.height === height) return { ok: true, bounds };
  const work = screen.getDisplayMatching(read).workArea;
  const next = clampToScreen({ x: bounds.x, y: bounds.y + bounds.height - height, width: bounds.width, height }, work);
  win.setBounds(next);
  fitGave = { width: next.width, height: next.height };
  return { ok: true, bounds: next };
});

// Fork: click-through. The strip is a caption over a game: the mouse is the game's. While it is on, the window
// passes every click to whatever is under it — but for one small rectangle of it, the button that turns this off (as
// the desktop lyrics of a music player have it). Where the pointer is, is asked of the system here, a few times a
// second: the window takes clicks while it is over that rectangle and passes them everywhere else, and the page is
// told when the pointer comes onto the strip or leaves it, to show the button. (Left to the page — enter and leave
// events, the window's clicks switched on a hover — the button flickered as the pointer neared it, and a click on it
// as often went through: switching whether a window takes the mouse makes it enter and leave. Seen 2026-10-06.)
// Only in subtitle mode; leaving it gives the window its clicks back.
const THROUGH_EVERY_MS = 50;
/** The pointer counts as on the button this far outside it: a target of a few pixels more than is drawn. */
const THROUGH_MARGIN = 6;
let through = null;
function stopThrough(win) {
  if (through) clearInterval(through.timer);
  through = null;
  if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(false);
}
function watchPointer(win) {
  if (!through) return;
  if (win.isDestroyed()) { stopThrough(null); return; }
  const point = screen.getCursorScreenPoint();
  const bounds = win.getContentBounds();
  const inside = point.x >= bounds.x && point.x < bounds.x + bounds.width && point.y >= bounds.y && point.y < bounds.y + bounds.height;
  // The page's own pixels: the content's, by its zoom.
  const zoom = win.webContents.getZoomFactor?.() || 1;
  const x = (point.x - bounds.x) / zoom;
  const y = (point.y - bounds.y) / zoom;
  const hole = through.hole;
  const over = inside && hole !== null
    && x >= hole.x - THROUGH_MARGIN && x <= hole.x + hole.width + THROUGH_MARGIN
    && y >= hole.y - THROUGH_MARGIN && y <= hole.y + hole.height + THROUGH_MARGIN;
  if (over !== through.over) {
    if (over) win.setIgnoreMouseEvents(false);
    else win.setIgnoreMouseEvents(true, { forward: true });
  }
  if (inside !== through.inside || over !== through.over) win.webContents.send('subtitle:pointer', { inside, over });
  through.inside = inside;
  through.over = over;
}
const holeOf = (hole) => (hole && [hole.x, hole.y, hole.width, hole.height].every((n) => Number.isFinite(n)) && hole.width > 0 && hole.height > 0
  ? { x: hole.x, y: hole.y, width: hole.width, height: hole.height }
  : null);
ipcMain.handle('subtitle:set-click-through', (_event, payload) => {
  const win = getLiveWindow();
  if (!win || normalBoundsSnapshot === null) return { ok: false };
  if (!(payload === true || payload?.on === true)) {
    stopThrough(win);
    return { ok: true };
  }
  const hole = holeOf(payload?.hole);
  // Already on: the button's place is all that changed.
  if (through) {
    through.hole = hole;
    return { ok: true };
  }
  through = { hole, inside: false, over: false, timer: setInterval(() => watchPointer(win), THROUGH_EVERY_MS) };
  win.setIgnoreMouseEvents(true, { forward: true });
  return { ok: true };
});

ipcMain.handle('subtitle:set-locked', (_event, locked) => {
  const win = getLiveWindow();
  if (!win) return { ok: false };
  win.setResizable(!locked);
  return { ok: true };
});

ipcMain.handle('subtitle:set-fullscreen', (_event, flag) => {
  const win = getLiveWindow();
  if (!win) return { ok: false };
  // Suppress the resize/move broadcaster while the WM animates in/out of
  // fullscreen, so the fullscreen geometry is never persisted as the bar's
  // windowBounds. The isFullScreen() guard added to onChange backs this up.
  beginTransition();
  win.setFullScreen(Boolean(flag));
  return { ok: true };
});

function setupSubtitleHandlers(mainWindow) {
  // Rebind the active window. Resize/move listeners are per-window and need
  // to be attached on every createWindow() call.
  activeWindow = mainWindow;
  // Reset snapshot/transition for the fresh window so a stale snapshot
  // from a previous window can't leak in. A fresh window starts unpinned,
  // so any enforcement left over from a previous window must stop too.
  normalBoundsSnapshot = null;
  transitionUntil = 0;
  stopPinEnforcement();

  // Debounced bounds-changed broadcaster. Suppressed during transition
  // windows so we don't capture intermediate WM-reported sizes as the
  // user's intended bounds.
  let debounceTimer = null;
  const onChange = () => {
    // resize/move can fire synchronously during window teardown; isFullScreen()
    // throws on a destroyed window, so bail before touching it.
    if (mainWindow.isDestroyed()) return;
    // Never persist screen-filling geometry as the bar's bounds. Fullscreen
    // comes from the bar's own button; maximized comes from double-clicking
    // the bar (the window manager on Linux, the WM_SYSCOMMAND hook in
    // window-caption-dblclick.js on Windows). Either way the size is not the
    // bar size the user picked, and remembering it would restore a
    // screen-sized "bar" on the next entry into subtitle mode.
    if (mainWindow.isFullScreen() || mainWindow.isMaximized()) return;
    if (Date.now() < transitionUntil) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (!mainWindow.isDestroyed() && Date.now() >= transitionUntil) {
        mainWindow.webContents.send('subtitle:window-bounds-changed', mainWindow.getBounds());
      }
    }, 200);
  };
  mainWindow.on('resize', onChange);
  mainWindow.on('move', onChange);
  const onEnterFullScreen = () =>
    mainWindow.webContents.send('subtitle:fullscreen-changed', true);
  const onLeaveFullScreen = () =>
    mainWindow.webContents.send('subtitle:fullscreen-changed', false);
  mainWindow.on('enter-full-screen', onEnterFullScreen);
  mainWindow.on('leave-full-screen', onLeaveFullScreen);
  // Activation transitions are the moments PowerPoint re-raises itself
  // above a pinned bar — respond to them promptly (see enforcement above).
  mainWindow.on('focus', schedulePinReassert);
  mainWindow.on('blur', schedulePinReassert);
  mainWindow.on('closed', () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    // Drop the reference so handlers know there's no live window until the
    // next createWindow() rebinds it. Like the rest of the module-scoped
    // state, enforcement is only torn down when the closing window is still
    // the bound one — a stale 'closed' from a window that was already
    // replaced by a rebind must not stop the new window's enforcement.
    if (activeWindow === mainWindow) {
      stopPinEnforcement();
      activeWindow = null;
      normalBoundsSnapshot = null;
    }
  });
}

module.exports = { setupSubtitleHandlers };
