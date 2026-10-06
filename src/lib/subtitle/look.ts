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
 * What is drawn around the text is an outline — a close ring of ink, with a
 * little of it spread wider — as the desktop lyrics of a music player have
 * it. The first version drew the soft shadow of the user's own lyrics mod
 * for Folia, a close drop and a wide glow; that mod is shown over artwork
 * made to be a background, and over a desktop — windows, text, white pages —
 * it did not hold the letters apart from what was behind them (the user,
 * 2026-10-06). The ink's colour is not chosen: light text gets a dark
 * outline, dark text a light one. Pure.
 */

export type Look = 'panel' | 'soft' | 'light' | 'dark';
export type Align = 'left' | 'center';

export interface LookPreset {
  bgColor: string;
  /** 0–100; 0 is no panel at all. */
  bgOpacity: number;
  /** 0–100; 0 is none. */
  shadow: number;
  align: Align;
  sourceTextColor: string;
  translationTextColor: string;
}

/** In the order they are offered. `panel` is what the strip was before there were looks. */
export const LOOK_ORDER: readonly Look[] = ['panel', 'soft', 'light', 'dark'];

export const LOOKS: Readonly<Record<Look, LookPreset>> = {
  // A dark panel under light text.
  panel: { bgColor: '#000000', bgOpacity: 80, shadow: 0, align: 'left', sourceTextColor: '#ffffff', translationTextColor: '#9ad0ff' },
  // A faint panel, and the outline doing half the work.
  soft: { bgColor: '#000000', bgOpacity: 30, shadow: 45, align: 'left', sourceTextColor: '#f0f0f0', translationTextColor: '#cfe8ff' },
  // No panel: light text on its own shadow. Centred — with nothing behind it, a short line at the far left of a wide
  // strip is a long way from where the eyes are.
  light: { bgColor: '#000000', bgOpacity: 0, shadow: 65, align: 'center', sourceTextColor: '#f4f4f4', translationTextColor: '#ffffff' },
  // No panel: dark text on a light glow, for a scene that is dark throughout.
  dark: { bgColor: '#000000', bgOpacity: 0, shadow: 65, align: 'center', sourceTextColor: '#1f242c', translationTextColor: '#0f1a26' },
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
 * The `text-shadow` that outlines text of a colour, at a strength of 0–100:
 * a ring of ink at a distance that grows with the strength, and a little of
 * it spread wider to soften the ring's edge. In ems, so that the small text
 * has a thinner outline than the large and neither is swallowed by its own.
 */
export function shadowFor(color: string, strength: number): string {
  const s = Math.min(100, Math.max(0, strength)) / 100;
  if (s === 0) return 'none';
  const ink = isLight(color) ? '0,0,0' : '255,255,255';
  const reach = 0.03 + 0.05 * s;
  const ring = RING.map(([x, y]) => `${em(x * reach)} ${em(y * reach)} 0 rgba(${ink},${share(0.6 + 0.4 * s)})`);
  return [...ring, `0 0 ${em(0.1 + 0.12 * s)} rgba(${ink},${share(0.55 * s)})`].join(', ');
}
