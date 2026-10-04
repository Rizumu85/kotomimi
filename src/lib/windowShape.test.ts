import { afterEach, describe, expect, it } from 'vitest';
import { fillsScreen, ROUNDED_CLASS, watchWindowShape } from './windowShape';

const size = (width: number, height: number) => {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
  Object.defineProperty(window, 'screen', { value: { availWidth: 1920, availHeight: 1032 }, configurable: true });
};
const rounded = () => document.documentElement.classList.contains(ROUNDED_CLASS);

afterEach(() => document.documentElement.classList.remove(ROUNDED_CLASS));

describe('the window\'s corners on Windows', () => {
  it('are square for a window that fills the screen, give or take a pixel of display scaling', () => {
    const screen = { availWidth: 1920, availHeight: 1032 };
    expect(fillsScreen({ innerWidth: 1200, innerHeight: 800, screen })).toBe(false);
    expect(fillsScreen({ innerWidth: 1920, innerHeight: 1032, screen })).toBe(true);
    expect(fillsScreen({ innerWidth: 1919, innerHeight: 1031, screen })).toBe(true);
    // Full screen is taller than the work area.
    expect(fillsScreen({ innerWidth: 1920, innerHeight: 1080, screen })).toBe(true);
    // Snapped to half the screen: still a window with corners.
    expect(fillsScreen({ innerWidth: 960, innerHeight: 1032, screen })).toBe(false);
  });

  it('follow the window as it is maximized and restored', () => {
    size(1200, 800);
    const stop = watchWindowShape(true);
    expect(rounded()).toBe(true);
    size(1920, 1032);
    window.dispatchEvent(new Event('resize'));
    expect(rounded()).toBe(false);
    size(1200, 800);
    window.dispatchEvent(new Event('resize'));
    expect(rounded()).toBe(true);
    stop();
    expect(rounded()).toBe(false);
  });

  it('are left to the system where it rounds the window itself, and in a browser', () => {
    size(1200, 800);
    watchWindowShape(false);
    expect(rounded()).toBe(false);
  });
});
