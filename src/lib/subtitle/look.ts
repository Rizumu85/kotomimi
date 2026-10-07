/**
 * Fork: how the subtitle strip is made readable over whatever is behind it.
 *
 * Upstream has one way: a dark, half-transparent panel under light text. A
 * strip over a game is read against anything — a bright sky, a dark room, a
 * busy wall — and a panel hides what it covers. So there are four looks to
 * start from, each a set of the values the strip already had (the panel's
 * colour and opacity, the two text colours) and two it gains: a soft shadow
 * around the text, and whether the text is centred. A look is chosen, then
 * any of its values changed: it is a starting point, not a mode.
 *
 * What is drawn around the text is the look's `edge`. Where there is a
 * panel it is a soft shadow — the one the user's own lyrics mod for Folia
 * draws, a close drop and a wide glow: the panel is the background, and the
 * shadow only sets the letters a little off it. Where there is none it is an
 * outline — a close ring of ink, with a little of it spread wider — as the
 * desktop lyrics of a music player have it: over a desktop (windows, text,
 * white pages) the soft shadow did not hold the letters apart from what was
 * behind them, and over a faint panel an outline was too hard (the user,
 * 2026-10-06, both). The ink's colour is not chosen: light text gets dark
 * ink, dark text light. Pure.
 */

export type Look = 'panel' | 'soft' | 'light' | 'dark';
export type Align = 'left' | 'center';
export type Edge = 'shadow' | 'outline';

export interface LookPreset {
  bgColor: string;
  /** 0–100; 0 is no panel at all. */
  bgOpacity: number;
  /** 0–100; 0 is none. */
  shadow: number;
  /** What that strength is of. */
  edge: Edge;
  align: Align;
  sourceTextColor: string;
  translationTextColor: string;
}

/** In the order they are offered. `panel` is what the strip was before there were looks. */
export const LOOK_ORDER: readonly Look[] = ['panel', 'soft', 'light', 'dark'];

/** A panel fainter than this is no panel: the strip is clear, and what belongs to a panel — the hairline between its lanes, the box's edges — is not drawn. */
export const PANEL_FROM = 8;

/** Whether the strip draws a panel at this opacity (0–100). */
export const hasPanel = (bgOpacity: number | undefined): boolean => (bgOpacity ?? 0) >= PANEL_FROM;

export const LOOKS: Readonly<Record<Look, LookPreset>> = {
  // A dark panel under light text.
  panel: { bgColor: '#000000', bgOpacity: 80, shadow: 0, edge: 'shadow', align: 'left', sourceTextColor: '#ffffff', translationTextColor: '#9ad0ff' },
  // A faint panel, and the shadow doing half the work.
  soft: { bgColor: '#000000', bgOpacity: 30, shadow: 100, edge: 'shadow', align: 'left', sourceTextColor: '#f0f0f0', translationTextColor: '#cfe8ff' },
  // No panel: light text in a dark outline. Centred — with nothing behind it, a short line at the far left of a wide
  // strip is a long way from where the eyes are.
  light: { bgColor: '#000000', bgOpacity: 0, shadow: 65, edge: 'outline', align: 'center', sourceTextColor: '#f4f4f4', translationTextColor: '#ffffff' },
  // No panel: dark text in a light outline, for a scene that is dark throughout.
  dark: { bgColor: '#000000', bgOpacity: 0, shadow: 65, edge: 'outline', align: 'center', sourceTextColor: '#1f242c', translationTextColor: '#0f1a26' },
};

/** A colour as `#rgb` or `#rrggbb` reads light (it wants a dark shadow) or dark. Anything else is taken for light. */
export function isLight(color: string): boolean {
  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())?.[1];
  if (!hex) return true;
  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(full.slice(at, at + 2), 16) / 255);
  // Perceived lightness, near enough: green counts most.
  return 0.299 * r + 0.587 * g + 0.114 * b > 0.5;
}

const share = (value: number): string => String(Math.round(Math.min(1, Math.max(0, value)) * 100) / 100);

/** The eight directions of the ring: straight, and diagonal at the same distance. */
const RING: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1], [0.707, 0.707], [-0.707, 0.707], [0.707, -0.707], [-0.707, -0.707]];
const em = (value: number): string => (value === 0 ? '0' : `${Math.round(value * 1000) / 1000}em`);

/**
 * An outline: a ring of ink at a distance that grows with the strength, and
 * a little of it spread wider to soften the ring's edge. In ems, so that the
 * small text has a thinner outline than the large and neither is swallowed
 * by its own.
 */
function outline(ink: string, s: number): string {
  const reach = 0.03 + 0.05 * s;
  const ring = RING.map(([x, y]) => `${em(x * reach)} ${em(y * reach)} 0 rgba(${ink},${share(0.6 + 0.4 * s)})`);
  return [...ring, `0 0 ${em(0.1 + 0.12 * s)} rgba(${ink},${share(0.55 * s)})`].join(', ');
}

/**
 * A soft shadow. At 50 a dark one is the Folia mod's own; past it a closer,
 * harder layer comes in. A light one is drawn heavier at every strength: a
 * glow has to be seen against the dark it lights.
 */
function soft(dark: boolean, s: number): string {
  if (dark) {
    const layers = [`0 1px 3px rgba(0,0,0,${share(1.1 * s)})`, `0 0 14px rgba(0,0,0,${share(0.7 * s)})`];
    if (s > 0.5) layers.unshift(`0 1px 2px rgba(0,0,0,${share((s - 0.5) * 1.6)})`);
    return layers.join(', ');
  }
  return [`0 0 2px rgba(255,255,255,${share(1.9 * s)})`, `0 1px 4px rgba(255,255,255,${share(1.6 * s)})`, `0 0 14px rgba(255,255,255,${share(1.2 * s)})`].join(', ');
}

/**
 * An outline for small writing — a reading above a word, a romanization under a line: one whole pixel of ink on
 * every side, corners too, and nothing spread. In ems it comes out a fraction of a pixel wide at that size, which
 * a screen draws as a haze (the user, 2026-10-06: "the romanization's outline looks blurred").
 */
function outlineSmall(ink: string, s: number): string {
  const alpha = share(0.7 + 0.3 * s);
  return [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]].map(([x, y]) => `${x}px ${y}px 0 rgba(${ink},${alpha})`).join(', ');
}

/**
 * The `text-shadow` around text of a colour, at a strength of 0–100: the look's shadow, or its outline — `small`,
 * the outline for writing a good deal smaller than the caption's own.
 */
export function shadowFor(color: string, strength: number, edge: Edge, small = false): string {
  const s = Math.min(100, Math.max(0, strength)) / 100;
  if (s === 0) return 'none';
  const light = isLight(color);
  const ink = light ? '0,0,0' : '255,255,255';
  if (edge === 'outline') return small ? outlineSmall(ink, s) : outline(ink, s);
  return soft(light, s);
}
