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
 * The shadow is the one the user's own lyrics mod for Folia draws
 * (`bilingual-ruby-lyrics`, 2026-10-06): a close, slight drop and a wide,
 * faint glow — text sitting on a little darkness, not an outline. Its colour
 * is not chosen: light text gets a dark one, dark text a light one. Pure.
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
  // A faint panel, and the shadow doing half the work.
  soft: { bgColor: '#000000', bgOpacity: 30, shadow: 50, align: 'left', sourceTextColor: '#f0f0f0', translationTextColor: '#cfe8ff' },
  // No panel: light text on its own shadow. Centred — with nothing behind it, a short line at the far left of a wide
  // strip is a long way from where the eyes are.
  light: { bgColor: '#000000', bgOpacity: 0, shadow: 60, align: 'center', sourceTextColor: '#f4f4f4', translationTextColor: '#ffffff' },
  // No panel: dark text on a light glow, for a scene that is dark throughout.
  dark: { bgColor: '#000000', bgOpacity: 0, shadow: 70, align: 'center', sourceTextColor: '#2a2f38', translationTextColor: '#14202e' },
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

/**
 * The `text-shadow` for text of a colour, at a strength of 0–100. At 50 a
 * dark shadow is the Folia mod's own; past it a closer, harder layer comes
 * in, for a background that is both bright and busy. A light shadow is drawn
 * heavier at every strength: a glow has to be seen against the dark it lights.
 */
export function shadowFor(color: string, strength: number): string {
  const s = Math.min(100, Math.max(0, strength)) / 100;
  if (s === 0) return 'none';
  if (isLight(color)) {
    const layers = [`0 1px 3px rgba(0,0,0,${share(1.1 * s)})`, `0 0 14px rgba(0,0,0,${share(0.7 * s)})`];
    if (s > 0.5) layers.unshift(`0 1px 2px rgba(0,0,0,${share((s - 0.5) * 1.6)})`);
    return layers.join(', ');
  }
  return [`0 0 2px rgba(255,255,255,${share(1.9 * s)})`, `0 1px 4px rgba(255,255,255,${share(1.6 * s)})`, `0 0 14px rgba(255,255,255,${share(1.2 * s)})`].join(', ');
}
