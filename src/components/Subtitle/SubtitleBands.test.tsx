import { describe, it, expect, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { TRANSIENT_NOTICE_MS } from '../../lib/view/filter';
import type { Entry, Row } from '../../lib/projection/types';
import { SubtitleBody, type SubtitleBodyProps } from './SubtitleBands';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | { defaultValue?: string }) =>
      typeof fallback === 'string' ? fallback : fallback?.defaultValue ?? key,
  }),
}));

const row = (segmentId: string, k: number, start: number, text: string, side: 'source' | 'translation' = 'source'): Row =>
  ({ key: `${segmentId}:${k}`, segmentId, side, start, end: start + text.length, text, final: true });
const exchange = (id: string, source: Row[], translation: Row[] = []): Entry =>
  ({ kind: 'exchange', id, leg: 'speaker', languages: { source: 'en', target: 'ja' }, pairing: 'stated', source, translation, t: 0 });
const props = (over: Partial<SubtitleBodyProps> = {}): SubtitleBodyProps => ({
  entries: [exchange('a', [row('s1', 0, 0, 'Hello.')], [row('t1', 0, 0, 'こんにちは。', 'translation')])],
  lit: new Map(),
  compact: true,
  fontSize: 24,
  filters: { speaker: 'both', participant: 'both' },
  newItemHighlightEnabled: true,
  ...over,
});

describe('SubtitleBody — compact: the fork\u2019s lanes', () => {
  const theirs = (id: string, source: string, answer = ''): Entry => ({
    kind: 'exchange', id, leg: 'participant', languages: { source: 'ja', target: 'en' }, pairing: 'stated',
    source: [row(`ps-${id}`, 0, 0, source)], translation: answer ? [row(`pt-${id}`, 0, 0, answer, 'translation')] : [], t: 0,
  });
  const texts = (lane: Element) => [...lane.querySelectorAll('.subtitle-lane__text')].map((el) => el.textContent);

  it('draws a lane for each side that has spoken, the other side first: its newest sentence over what answers it', () => {
    const { container } = render(<SubtitleBody {...props({ entries: [exchange('a', [row('s1', 0, 0, 'Hello.')], [row('t1', 0, 0, 'こんにちは。', 'translation')]), theirs('b', 'そうですね。', 'That is right.')] })} />);
    const lanes = [...container.querySelectorAll('.subtitle-stream.compact .subtitle-lane')];
    expect(lanes.map((lane) => lane.getAttribute('data-lane'))).toEqual(['participant', 'speaker']);
    expect(texts(lanes[0])).toEqual(['そうですね。', 'That is right.']);
    expect(texts(lanes[1])).toEqual(['Hello.', 'こんにちは。']);
    expect(lanes[0].querySelector('.subtitle-lane__source .subtitle-lane__text')?.getAttribute('lang')).toBe('ja');
  });

  it('keeps a side\u2019s sentence and its answer in place while the other side goes on talking', () => {
    const { container } = render(<SubtitleBody {...props({ entries: [
      exchange('a', [row('s1', 0, 0, 'Hello.')], [row('t1', 0, 0, 'こんにちは。', 'translation')]),
      theirs('b', 'そうですね。', 'That is right.'), theirs('c', 'いい天気ですね。', 'Nice weather.'), theirs('d', 'はい。'),
    ] })} />);
    const [other, mine] = [...container.querySelectorAll('.subtitle-lane')];
    expect(texts(mine)).toEqual(['Hello.', 'こんにちは。']);
    // Their newest has no answer yet: the last one stays, drawn as the sentence before's.
    expect(texts(other)).toEqual(['はい。', 'Nice weather.']);
    expect(other.querySelector('.subtitle-lane__answer')?.className).toContain('subtitle-lane__answer--stale');
    expect(mine.querySelector('.subtitle-lane__answer')?.className).not.toContain('--stale');
  });

  it('has a lane, empty, for a leg the run hears that has said nothing yet', () => {
    const { container } = render(<SubtitleBody {...props({ entries: [], legs: ['speaker', 'participant'] })} />);
    expect([...container.querySelectorAll('.subtitle-lane')].map((lane) => lane.getAttribute('data-lane'))).toEqual(['participant', 'speaker']);
  });

  it('shows only the sides the subtitle is set to show', () => {
    const { container } = render(<SubtitleBody {...props({ filters: { speaker: 'translation', participant: 'both' } })} />);
    expect(texts(container.querySelector('.subtitle-lane')!)).toEqual(['こんにちは。']);
    expect(container.querySelector('.subtitle-lane__source')).toBeNull();
  });

  it('says the height it is laid out for and the least it can be squeezed into: again when the size changes, not when the words do', () => {
    const onHeight = vi.fn();
    const { rerender } = render(<SubtitleBody {...props({ onHeight })} />);
    expect(onHeight).toHaveBeenCalledTimes(1);
    const [height, least] = onHeight.mock.calls[0] as [number, number];
    expect(least).toBeLessThan(height);
    rerender(<SubtitleBody {...props({ onHeight, entries: [exchange('a', [row('s1', 0, 0, 'Hello again.')], [row('t1', 0, 0, 'また、こんにちは。', 'translation')])] })} />);
    expect(onHeight).toHaveBeenCalledTimes(1);
    rerender(<SubtitleBody {...props({ onHeight, fontSize: 36 })} />);
    expect(onHeight).toHaveBeenCalledTimes(2);
    expect((onHeight.mock.calls[1] as [number, number])[0]).toBeGreaterThan(height);
  });
});

describe('SubtitleBody — expanded', () => {
  it("draws the panel's list with the subtitle's filters and no replay", () => {
    const { container } = render(<SubtitleBody {...props({ compact: false, filters: { speaker: 'translation', participant: 'both' } })} />);
    expect(container.querySelector('.subtitle-stream.expanded')).not.toBeNull();
    expect([...container.querySelectorAll('.conversation-row .row-text')].map((el) => el.textContent)).toEqual(['こんにちは。']);
    expect(container.querySelector('.row-play-btn')).toBeNull();
  });
});

describe('SubtitleBody — a transient notice (#481)', () => {
  const transient: Entry = { kind: 'notice', id: 'n', leg: 'speaker', severity: 'info', message: 'Now using the microphone "USB Mic".', at: 10_000, lifetime: 'transient' };

  it.each([true, false])('shows it, then leaves it out once its time is up (compact: %s)', (compact) => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    try {
      const { container } = render(<SubtitleBody {...props({ compact, entries: [transient] })} />);
      expect(container.textContent).toContain('Now using the microphone');
      act(() => { vi.advanceTimersByTime(TRANSIENT_NOTICE_MS); });
      expect(container.textContent).not.toContain('Now using the microphone');
    } finally {
      vi.useRealTimers();
    }
  });
});
