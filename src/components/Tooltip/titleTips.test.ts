import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installTitleTips } from './titleTips';

const over = (element: Element) => element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
const out = (element: Element, to: Element | null = null) => element.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: to }));
const tip = () => document.querySelector('.kt-title-tip');

describe('a control\'s title, drawn by the app (fork)', () => {
  let remove: () => void;
  let button: HTMLButtonElement;
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<button title="显示设置"><svg></svg></button><span id="plain">x</span>';
    button = document.querySelector('button')!;
    remove = installTitleTips(document);
  });
  afterEach(() => {
    remove();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('holds the title while the pointer is there, so the system shows nothing, and gives it back', () => {
    over(button);
    expect(button.hasAttribute('title')).toBe(false);
    vi.advanceTimersByTime(349);
    expect(tip()).toBeNull();
    vi.advanceTimersByTime(1);
    expect(tip()?.textContent).toBe('显示设置');
    out(button);
    expect(tip()).toBeNull();
    expect(button.getAttribute('title')).toBe('显示设置');
  });

  it('stays on a control as the pointer crosses what is inside it', () => {
    over(button);
    vi.advanceTimersByTime(400);
    const icon = button.querySelector('svg')!;
    over(icon);
    out(button, icon);
    expect(tip()).not.toBeNull();
  });

  it('goes when the control is pressed, and leaves a title written meanwhile as it is', () => {
    over(button);
    vi.advanceTimersByTime(400);
    button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(tip()).toBeNull();
    button.setAttribute('title', '关闭设置');
    out(button);
    expect(button.getAttribute('title')).toBe('关闭设置');
  });

  it('does nothing over what has no title, and hands every title back when it is taken out', () => {
    over(document.querySelector('#plain')!);
    vi.advanceTimersByTime(400);
    expect(tip()).toBeNull();
    over(button);
    remove();
    expect(button.getAttribute('title')).toBe('显示设置');
    over(button);
    expect(button.hasAttribute('title')).toBe(true);
    remove = () => {};
  });
});
