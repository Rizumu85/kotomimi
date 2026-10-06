import { describe, expect, it } from 'vitest';
import { isLight, LOOK_ORDER, LOOKS, shadowFor } from './look';

describe('the looks of the subtitle strip', () => {
  it('start from what the strip was: a dark panel, no shadow, text at the left', () => {
    expect(LOOK_ORDER[0]).toBe('panel');
    expect(LOOKS.panel).toEqual({ bgColor: '#000000', bgOpacity: 80, shadow: 0, align: 'left', sourceTextColor: '#ffffff', translationTextColor: '#9ad0ff' });
  });

  it('have no panel where the text stands on its shadow alone, and are centred there', () => {
    for (const look of ['light', 'dark'] as const) {
      expect(LOOKS[look].bgOpacity).toBe(0);
      expect(LOOKS[look].shadow).toBeGreaterThan(0);
      expect(LOOKS[look].align).toBe('center');
    }
    // Light text for one, dark for the other: the shadow's colour follows.
    expect(isLight(LOOKS.light.translationTextColor)).toBe(true);
    expect(isLight(LOOKS.dark.translationTextColor)).toBe(false);
    expect(isLight(LOOKS.dark.sourceTextColor)).toBe(false);
  });
});

describe('the shadow around the strip\u2019s text', () => {
  it('is none at no strength', () => {
    expect(shadowFor('#ffffff', 0)).toBe('none');
    expect(shadowFor('#14202e', 0)).toBe('none');
  });

  it('is, at half strength around light text, the one the user\u2019s lyrics mod draws: a close drop and a wide glow', () => {
    expect(shadowFor('#ffffff', 50)).toBe('0 1px 3px rgba(0,0,0,0.55), 0 0 14px rgba(0,0,0,0.35)');
  });

  it('gains a closer, harder layer past half strength', () => {
    expect(shadowFor('#ffffff', 100).split('), ')).toHaveLength(3);
    expect(shadowFor('#ffffff', 100)).toContain('0 1px 2px rgba(0,0,0,0.8)');
  });

  it('is light around dark text', () => {
    const glow = shadowFor('#14202e', 70);
    expect(glow).toContain('rgba(255,255,255,');
    expect(glow).not.toContain('rgba(0,0,0,');
  });

  it('reads a colour as light or dark by how bright it looks, and anything unreadable as light', () => {
    expect(isLight('#FFFFFF')).toBe(true);
    expect(isLight('#9ad0ff')).toBe(true);
    expect(isLight('#000')).toBe(false);
    expect(isLight('#003B6F')).toBe(false);
    expect(isLight('rebeccapurple')).toBe(true);
  });
});
