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
// The same lack costs the window the system's animation: Electron's stand-in
// is one jump of the bounds. So the change is handed to the page to play
// (`pageShift`, and `playShift` in src/lib/windowShape.ts, which says how):
// the page asks for each step of the window's way there (`place`), and says
// when the change itself may be made (`ready`).
//
// No Electron import: the window, the work area and the way to the page are
// handed in.

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

/** How long the page is given to play a change before it is made without it. */
const SHIFT_WAIT_MS = 1000;

/** Bounds a page may ask for: four whole numbers, and a size. */
function sane(bounds) {
  return !!bounds
    && ['x', 'y', 'width', 'height'].every((key) => Number.isInteger(bounds[key]) && Math.abs(bounds[key]) < 100000)
    && bounds.width > 0 && bounds.height > 0;
}

/**
 * The page's part in a change of the window's bounds. `send(move)` hands
 * `{ kind, from, to }` to the page and answers whether there is a page to
 * play it. While it plays, the page asks for the window's bounds through
 * `place(bounds)`, handed on to `put`; it answers through `ready()` when the
 * change itself may be made. Outside a change `place` does nothing, and a
 * page that never answers is not waited for beyond `wait`.
 * @returns {{ shift: (move: object, run: () => void) => void, ready: () => void, place: (bounds: object) => void }}
 */
function pageShift(send, { put = () => {}, wait = SHIFT_WAIT_MS, later = setTimeout, cancel = clearTimeout } = {}) {
  let go = null;
  const shift = (move, run) => {
    let done = false;
    let timer = null;
    const once = () => {
      if (done) return;
      done = true;
      if (go === once) go = null;
      cancel(timer);
      run();
    };
    if (!send(move)) return once();
    go = once;
    timer = later(once, wait);
  };
  return { shift, ready: () => { if (go) go(); }, place: (bounds) => { if (go && sane(bounds)) put(bounds); } };
}

/**
 * Replaces `win.isMaximized`, `win.maximize` and `win.unmaximize` with ones
 * that hold on a scaled display. `workAreaOf(bounds)` answers the work area
 * of the display the bounds are on. `shift(move, run)` plays the change and
 * calls `run` when the bounds are to change (`pageShift`); without one they
 * change at once. No-op off Windows.
 * @returns {boolean} whether the window was changed.
 */
function keepMaximizeHonest(win, workAreaOf, platform = process.platform, shift = (move, run) => run()) {
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
  /** What the window is on its way to being while a change is played: asked again meanwhile, it answers that and stays its course. */
  let heading = null;
  const gone = () => typeof win.isDestroyed === 'function' && win.isDestroyed();
  // Moved or resized since: it is a window again, and the next maximize starts over.
  win.isMaximized = () => (heading !== null ? heading : native.isMaximized() || (before !== null && fills()));
  win.maximize = () => {
    if (heading !== null) return;
    if (win.isMaximized()) return native.maximize();
    before = win.getBounds();
    heading = true;
    shift({ kind: 'maximize', from: before, to: workAreaOf(before) }, () => {
      heading = null;
      if (!gone()) native.maximize();
    });
  };
  win.unmaximize = () => {
    if (heading !== null) return;
    const back = before;
    const restore = (played = false) => {
      before = null;
      native.unmaximize();
      // Electron's own restore did nothing — it did not think the window maximized — or the window is where the
      // page's playing left it: put it back by hand.
      if (back && (played || fills())) setExactly(win, back);
    };
    // Nothing to play: not maximized, or by Electron's own account alone, which knows where it goes back to and this does not.
    if (!back || !win.isMaximized()) return restore();
    heading = false;
    shift({ kind: 'restore', from: win.getBounds(), to: back }, () => {
      heading = null;
      if (!gone()) restore(true);
    });
  };
  return true;
}

module.exports = { keepMaximizeHonest, pageShift, covers, setExactly, sane, SLACK, SHIFT_WAIT_MS };
