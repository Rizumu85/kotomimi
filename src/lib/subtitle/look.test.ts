import { describe, expect, it } from 'vitest';
import { isLight, LOOK_ORDER, LOOKS, shadowFor } from './look';

describe('the looks of the subtitle strip', () => {
  it('start from what the strip was: a dark panel, nothing around the text, text at the left', () => {
    expect(LOOK_ORDER[0]).toBe('panel');
    expect(LOOKS.panel).toEqual({ bgColor: '#000000', bgOpacity: 80, shadow: 0, edge: 'shadow', align: 'left', sourceTextColor: '#ffffff', translationTextColor: '#9ad0ff' });
  });

  it('have no panel where the text stands on its outline alone, and are centred there', () => {
    for (const look of ['light', 'dark'] as const) {
      expect(LOOKS[look].bgOpacity).toBe(0);
      expect(LOOKS[look].shadow).toBeGreaterThan(0);
      expect(LOOKS[look].align).toBe('center');
      expect(LOOKS[look].edge).toBe('outline');
    }
    // Under a panel, however faint, it is a shadow: an outline there was too hard (the user, 2026-10-06).
    expect(LOOKS.soft.bgOpacity).toBeGreaterThan(0);
    expect(LOOKS.soft.edge).toBe('shadow');
    // At full strength: the user's own setting after trying it (2026-10-06).
    expect(LOOKS.soft.shadow).toBe(100);
    // Light text for one, dark for the other: the outline's colour follows.
    expect(isLight(LOOKS.light.translationTextColor)).toBe(true);
    expect(isLight(LOOKS.dark.translationTextColor)).toBe(false);
    expect(isLight(LOOKS.dark.sourceTextColor)).toBe(false);
  });
});

describe('what is drawn around the strip\u2019s text', () => {
  it('is nothing at no strength', () => {
    expect(shadowFor('#ffffff', 0, 'outline')).toBe('none');
    expect(shadowFor('#14202e', 0, 'shadow')).toBe('none');
  });

  it('is, as a shadow, the one the user\u2019s own lyrics mod for Folia draws at 50: a close drop and a wide glow', () => {
    expect(shadowFor('#ffffff', 50, 'shadow')).toBe('0 1px 3px rgba(0,0,0,0.55), 0 0 14px rgba(0,0,0,0.35)');
    // Past it a closer, harder layer comes in first.
    expect(shadowFor('#ffffff', 100, 'shadow').split('), ')).toHaveLength(3);
    // A light glow around dark text, heavier at every strength.
    expect(shadowFor('#14202e', 50, 'shadow')).toBe('0 0 2px rgba(255,255,255,0.95), 0 1px 4px rgba(255,255,255,0.8), 0 0 14px rgba(255,255,255,0.6)');
  });

  it('is, as an outline, a ring of ink on every side at one distance, and a little of it spread wider', () => {
    // Asked for by the user 2026-10-06, after the soft shadow did not hold the letters apart from a desktop behind them.
    const layers = shadowFor('#ffffff', 60, 'outline').split('), ').map((layer) => layer.replace(/\)$/, ''));
    expect(layers).toHaveLength(9);
    const ring = layers.slice(0, 8);
    // No blur in the ring: the third length of each is 0.
    expect(ring.every((layer) => / 0 rgba\(0,0,0,/.test(layer))).toBe(true);
    expect(ring[0].startsWith('0.06em 0 0 ')).toBe(true);
    expect(ring[1].startsWith('-0.06em 0 0 ')).toBe(true);
    expect(layers[8].startsWith('0 0 0.172em rgba(0,0,0,')).toBe(true);
  });

  it('reaches further the stronger it is, in ems: thinner around small text than around large', () => {
    const reach = (strength: number) => Number(/^([\d.]+)em/.exec(shadowFor('#ffffff', strength, 'outline'))![1]);
    expect(reach(100)).toBeGreaterThan(reach(50));
    expect(reach(50)).toBeGreaterThan(reach(10));
  });

  it('is light around dark text', () => {
    const outline = shadowFor('#14202e', 70, 'outline');
    expect(outline).toContain('rgba(255,255,255,');
    expect(outline).not.toContain('rgba(0,0,0,');
  });

  it('reads a colour as light or dark by how bright it looks, and anything unreadable as light', () => {
    expect(isLight('#FFFFFF')).toBe(true);
    expect(isLight('#9ad0ff')).toBe(true);
    expect(isLight('#000')).toBe(false);
    expect(isLight('#003B6F')).toBe(false);
    expect(isLight('rebeccapurple')).toBe(true);
  });
});
