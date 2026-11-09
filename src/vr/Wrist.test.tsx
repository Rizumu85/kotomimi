import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const sent = vi.hoisted(() => [] as unknown[]);
vi.mock('./bridge', () => ({ send: (command: unknown) => { sent.push(command); }, fill: (text: string) => text }));

import Wrist from './Wrist';
import type { VrState } from './types';

const words = new Proxy({}, { get: (_target, key) => String(key) }) as VrState['words'];
const state = (theirs: Partial<VrState['theirs']>): VrState => ({
  words,
  phase: 'idle',
  switching: null,
  failed: null,
  heard: null,
  muted: false,
  lines: [],
  theirs: { value: 'en', options: [{ value: 'en', label: '英语' }, { value: 'ko', label: '韩语' }, { value: 'ja', label: '日语' }], quick: ['en', 'ko', 'ja'], row: true, ...theirs },
  mine: { value: 'zh-CN', options: [] },
  hear: { value: '', options: [] },
  translate: { value: '', options: [] },
  strip: true,
  chatbox: false,
} as unknown as VrState);

describe('the wrist panel: their languages in the first row of six buttons (fork)', () => {
  it('shows both lit with the four actions, and puts one out when pressed', () => {
    sent.length = 0;
    render(<Wrist state={state({ lit: 'ko' })} perf={null} />);
    const buttons = document.querySelectorAll('.actions button');
    expect(buttons).toHaveLength(6);
    expect([...buttons].slice(0, 2).map((b) => b.textContent)).toEqual(['英语', '韩语']);
    fireEvent.click(buttons[1]);
    expect(sent).toEqual([{ type: 'theirs', value: 'ko' }]);
  });

  it('offers "+" beside the only one lit, which opens every language in the captions’ place, theirs first', () => {
    sent.length = 0;
    render(<Wrist state={state({})} perf={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'more' }));
    const listed = [...document.querySelectorAll('.more button')].map((b) => b.textContent);
    expect(listed).toEqual(['英语', '韩语', '日语']);
    fireEvent.click(screen.getByRole('button', { name: '韩语' }));
    expect(sent).toEqual([{ type: 'theirs', value: 'ko' }]);
    expect(document.querySelector('.more')).toBeNull();
  });
});

describe('the wrist panel’s second page: their languages there too (fork)', () => {
  it('lists their row with "…" for every other language, and presses them as the first page does', () => {
    sent.length = 0;
    render(<Wrist state={state({ lit: 'ko', quick: ['en', 'ko'] })} perf={null} />);
    fireEvent.click(screen.getByRole('button', { name: /tune/ }));
    const group = () => [...document.querySelectorAll('.group')].find((g) => g.querySelector('.group__head')?.textContent === 'theirs')!;
    expect([...group().querySelectorAll('button')].map((b) => b.textContent)).toEqual(['英语', '韩语', '…']);
    fireEvent.click(screen.getByRole('button', { name: 'more' }));
    expect([...group().querySelectorAll('button')].map((b) => b.textContent)).toEqual(['英语', '韩语', '日语']);
    fireEvent.click(screen.getByRole('button', { name: '日语' }));
    expect(sent).toEqual([{ type: 'theirs', value: 'ja' }]);
  });
});
