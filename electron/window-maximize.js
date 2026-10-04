// Fork: a maximized window that can be put back, on Windows.
//
// The main window is frameless and transparent (it becomes the subtitle
// overlay), and Windows will not maximize such a window itself: Electron
// stands in, by setting its bounds to the display's work area, and later
// answers "is it maximized?" by comparing the two. On a display scaled by a
// fraction (125%, 135%, 175%) the bounds it gets back are a pixel off the
// work area it asked for, the comparison fails, and the window is "not
// maximized" for ever after: the title bar's button, the double-click and the
// caption menu all maximize it again instead of restoring it. Measured on
// Electron 44 at 135%: 1898x1030 against a work area of 1897x1028.
//
// So the window's own three methods are made to tell the truth: where it was
// before it was maximized is remembered here, "maximized" is true while it
// still covers the work area within a few pixels, and restoring puts it back
// where it was when Electron's own restore does nothing. Every caller keeps
// calling the window as before.
//
// Putting it back has the same rounding against it: on such a display
// `setBounds(getBounds())` leaves the window a pixel or two larger (measured:
// 1207x814 asked for, 1208x816 got), so a window maximized and restored a few
// times would creep. What came out too large is taken off again, once.
//
// No Electron import: the window and the work area are handed in.

/** How far a maximized window's bounds may be from the work area's: what a fractional display scale rounds away. */
const SLACK = 4;

/** `bounds` cover `area`, give or take the slack. */
function covers(bounds, area) {
  return Math.abs(bounds.x - area.x) <= SLACK
    && Math.abs(bounds.y - area.y) <= SLACK
    && bounds.width >= area.width - SLACK
    && bounds.height >= area.height - SLACK;
}

/** Gives the window these bounds, and takes off what a scaled display added to them. */
function setExactly(win, bounds) {
  win.setBounds(bounds);
  const got = win.getBounds();
  const wide = got.width - bounds.width;
  const tall = got.height - bounds.height;
  if (wide === 0 && tall === 0) return;
  if (Math.abs(wide) > SLACK || Math.abs(tall) > SLACK) return; // Not rounding: the window has a size limit. Leave it.
  win.setBounds({ ...bounds, width: bounds.width - wide, height: bounds.height - tall });
}

/**
 * Replaces `win.isMaximized`, `win.maximize` and `win.unmaximize` with ones
 * that hold on a scaled display. `workAreaOf(bounds)` answers the work area
 * of the display the bounds are on. No-op off Windows.
 * @returns {boolean} whether the window was changed.
 */
function keepMaximizeHonest(win, workAreaOf, platform = process.platform) {
  if (platform !== 'win32' || !win) return false;
  const native = {
    isMaximized: win.isMaximized.bind(win),
    maximize: win.maximize.bind(win),
    unmaximize: win.unmaximize.bind(win),
  };
  /** Where the window was before this module maximized it; null while it is not maximized by it. */
  let before = null;
  const fills = () => {
    const bounds = win.getBounds();
    return covers(bounds, workAreaOf(bounds));
  };
  // Moved or resized since: it is a window again, and the next maximize starts over.
  win.isMaximized = () => native.isMaximized() || (before !== null && fills());
  win.maximize = () => {
    if (!win.isMaximized()) before = win.getBounds();
    native.maximize();
  };
  win.unmaximize = () => {
    const back = before;
    before = null;
    native.unmaximize();
    // Electron's own restore did nothing — it did not think the window maximized: put it back by hand.
    if (back && fills()) setExactly(win, back);
  };
  return true;
}

module.exports = { keepMaximizeHonest, covers, setExactly, SLACK };
