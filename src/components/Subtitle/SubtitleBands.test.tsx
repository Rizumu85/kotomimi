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

describe('SubtitleBody — the panel, said on the stream (fork)', () => {
  const stream = (over: Partial<SubtitleBodyProps>) => render(<SubtitleBody {...props(over)} />).container.querySelector('.subtitle-stream') as HTMLElement;

  it('says there is no panel under a clear strip — the two outline looks, or a panel turned down to nothing', () => {
    expect(stream({ bgOpacity: 0 }).dataset.panel).toBe('none');
    expect(stream({ bgOpacity: 5 }).dataset.panel).toBe('none');
  });

  it('says nothing where a panel is drawn, or where it is not told of one', () => {
    expect(stream({ bgOpacity: 80 }).dataset.panel).toBeUndefined();
    expect(stream({ bgOpacity: 30 }).dataset.panel).toBeUndefined();
    expect(stream({}).dataset.panel).toBeUndefined();
  });
});

describe('SubtitleBody — compact: the fork\u2019s lanes', () => {
  const theirs = (id: string, source: string, answer = ''): Entry => ({
    kind: 'exchange', id, leg: 'participant', languages: { source: 'ja', target: 'en' }, pairing: 'stated',
    source: [row(`ps-${id}`, 0, 0, source)], translation: answer ? [row(`pt-${id}`, 0, 0, answer, 'translation')] : [], t: 0,
  });
  /** A lane's texts as written, without the tag that says whose lane it is. */
  const texts = (lane: Element) => [...lane.querySelectorAll('.subtitle-lane__source, .subtitle-lane__answer, .subtitle-lane__said, .subtitle-lane__reply')].map((el) => {
    const copy = el.cloneNode(true) as Element;
    copy.querySelectorAll('.subtitle-lane__tag').forEach((tag) => tag.remove());
    return copy.textContent;
  });
  const tags = (root: Element) => [...root.querySelectorAll('.subtitle-lane__tag')].map((tag) => tag.textContent);

  it('draws a lane for each side that has spoken: the other side\u2019s newest sentence over what answers it, then the user\u2019s own on one row', () => {
    const { container } = render(<SubtitleBody {...props({ entries: [exchange('a', [row('s1', 0, 0, 'Hello.')], [row('t1', 0, 0, 'こんにちは。', 'translation')]), theirs('b', 'そうですね。', 'That is right.')] })} />);
    const lanes = [...container.querySelectorAll('.subtitle-stream.compact .subtitle-lane')];
    expect(lanes.map((lane) => lane.getAttribute('data-lane'))).toEqual(['participant', 'speaker']);
    expect(texts(lanes[0])).toEqual(['そうですね。', 'That is right.']);
    expect(texts(lanes[1])).toEqual(['Hello.', 'こんにちは。']);
    expect(lanes[0].querySelector('.subtitle-lane__source .subtitle-lane__text')?.getAttribute('lang')).toBe('ja');
    // Each says whose it is, once; theirs is a pair, the user's own a row with an arrow between its two texts.
    expect(tags(container)).toEqual(['Other', 'Me']);
    expect(lanes[0].className).toContain('subtitle-lane--pair');
    expect(lanes[1].className).toContain('subtitle-lane--row');
    expect(lanes[1].querySelector('.subtitle-lane__arrow')).not.toBeNull();
    expect(lanes[1].querySelector('.subtitle-lane__said')?.getAttribute('lang')).toBe('en');
  });

  it('draws the user\u2019s own lane as a pair where it is the only one, and no arrow before anything answers', () => {
    const alone = render(<SubtitleBody {...props()} />);
    const lane = alone.container.querySelector('.subtitle-lane')!;
    expect(lane.className).toContain('subtitle-lane--pair');
    expect(texts(lane)).toEqual(['Hello.', 'こんにちは。']);
    alone.unmount();
    // In its row, a sentence still waiting for its answer says so where the answer will be.
    const waiting = render(<SubtitleBody {...props({ entries: [exchange('z', [row('s0', 0, 0, 'Hi.')], [row('t0', 0, 0, 'やあ。', 'translation')]), exchange('a', [row('s1', 0, 0, 'Hello.')]), theirs('b', 'はい。', 'Yes.')] })} />);
    const mine = waiting.container.querySelector('.subtitle-lane--row')!;
    expect(mine.querySelector('.subtitle-lane__reply')).toBeNull();
    expect(mine.querySelector('.subtitle-lane__pending')).not.toBeNull();
  });

  it('keeps a side\u2019s sentence and its answer in place while the other side goes on talking', () => {
    const { container } = render(<SubtitleBody {...props({ entries: [
      exchange('a', [row('s1', 0, 0, 'Hello.')], [row('t1', 0, 0, 'こんにちは。', 'translation')]),
      theirs('b', 'そうですね。', 'That is right.'), theirs('c', 'いい天気ですね。', 'Nice weather.'), theirs('d', 'はい。'),
    ] })} />);
    const [other, mine] = [...container.querySelectorAll('.subtitle-lane')];
    expect(texts(mine)).toEqual(['Hello.', 'こんにちは。']);
    // Their newest has no answer yet: the answer is still the sentence before's, and the small line goes on from
    // that sentence into what is being said — which is itself the sign that more is coming.
    expect(texts(other)).toEqual(['いい天気ですね。はい。', 'Nice weather.']);
    expect(other.querySelector('.subtitle-lane__pending')).toBeNull();
    expect(mine.querySelector('.subtitle-lane__pending')).toBeNull();
  });

  it('draws feedback that only approves as the app’s own tick, and keeps the arrow for a sentence put right', () => {
    // As a character the tick came from whatever font had one, and did not look of a piece with the sentence (the user, 2026-10-06).
    const approved = render(<SubtitleBody {...props({ entries: [exchange('a', [row('s1', 0, 0, 'Hello.')], [row('t1', 0, 0, '✓', 'translation')]), theirs('b', 'はい。', 'Yes.')] })} />);
    const mine = approved.container.querySelector('[data-lane="speaker"]')!;
    expect(mine.querySelector('.subtitle-lane__ok')).not.toBeNull();
    expect(mine.querySelector('.subtitle-lane__arrow')).toBeNull();
    expect(mine.textContent).not.toContain('✓');
    approved.unmount();
    const corrected = render(<SubtitleBody {...props({ entries: [exchange('a', [row('s1', 0, 0, 'Hello.')], [row('t1', 0, 0, 'Hello there.', 'translation')]), theirs('b', 'はい。', 'Yes.')] })} />);
    const put = corrected.container.querySelector('[data-lane="speaker"]')!;
    expect(put.querySelector('.subtitle-lane__ok')).toBeNull();
    expect(put.querySelector('.subtitle-lane__arrow')).not.toBeNull();
    expect(put.querySelector('.subtitle-lane__reply')?.textContent).toBe('Hello there.');
  });

  it('draws the newest sentence alone, whatever was said before: a higher window is room for it, not for those', () => {
    const { container } = render(<SubtitleBody {...props({ entries: [theirs('a', 'こんにちは。', 'Hello.'), theirs('b', 'そうですね。', 'That is right.')] })} />);
    expect(texts(container.querySelector('.subtitle-lane')!)).toEqual(['そうですね。', 'That is right.']);
    expect(container.textContent).not.toContain('こんにちは。');
    // Fitted (a test's document has no layout): one line for the sentence, two for its answer.
    const strip = container.querySelector('.subtitle-lanes') as HTMLElement;
    expect(strip.style.getPropertyValue('--lane-source-lines')).toBe('1');
    expect(strip.style.getPropertyValue('--lane-answer-lines')).toBe('2');
    expect(strip.style.getPropertyValue('--lane-row-lines')).toBe('1');
  });

  it('has a lane for a leg the run hears that has said nothing yet — and says nothing in it, not even whose it is', () => {
    // Seen 2026-10-06: with nobody speaking, the other side's tag sat alone on the screen.
    const { container } = render(<SubtitleBody {...props({ entries: [], legs: ['speaker', 'participant'] })} />);
    const lanes = [...container.querySelectorAll('.subtitle-lane')];
    expect(lanes.map((lane) => lane.getAttribute('data-lane'))).toEqual(['participant', 'speaker']);
    expect(lanes.every((lane) => lane.classList.contains('is-silent'))).toBe(true);
    expect(container.querySelector('.subtitle-lane__tag')).toBeNull();
    // A strip with no panel would then be nothing at all on the screen: a quiet mark says where it is.
    expect(container.querySelector('.subtitle-lanes__waiting')?.textContent).toBe('· · ·');
    // One side has spoken: it is tagged, the other still is not, and the mark is gone.
    const one = render(<SubtitleBody {...props({ legs: ['speaker', 'participant'] })} />);
    expect(one.container.querySelector('.subtitle-lanes__waiting')).toBeNull();
    expect([...one.container.querySelectorAll('.subtitle-lane__tag')].map((tag) => tag.textContent)).toEqual(['Me']);
    expect(one.container.querySelector('[data-lane="participant"]')?.classList.contains('is-silent')).toBe(true);
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

describe('SubtitleBody — the look\u2019s shadow and alignment (fork)', () => {
  it('draws no shadow and sits at the left as the strip always did, and follows the look when one is chosen', async () => {
    const { useSubtitleLookStore } = await import('../../stores/subtitleLookStore');
    const plain = render(<SubtitleBody {...props({ sourceTextColor: '#ffffff', translationTextColor: '#9ad0ff' })} />);
    const stream = plain.container.querySelector('.subtitle-stream') as HTMLElement;
    expect(stream.getAttribute('data-align')).toBe('left');
    expect(stream.style.getPropertyValue('--subtitle-shadow-answer')).toBe('none');
    plain.unmount();
    act(() => { useSubtitleLookStore.setState({ shadow: 50, align: 'center' }); });
    try {
      // Dark text gets a light shadow, light text a dark one: each by its own colour.
      const { container } = render(<SubtitleBody {...props({ sourceTextColor: '#f4f4f4', translationTextColor: '#14202e' })} />);
      const lit = container.querySelector('.subtitle-stream') as HTMLElement;
      expect(lit.getAttribute('data-align')).toBe('center');
      expect(lit.style.getPropertyValue('--subtitle-shadow-source')).toContain('rgba(0,0,0,');
      expect(lit.style.getPropertyValue('--subtitle-shadow-answer')).toContain('rgba(255,255,255,');
    } finally {
      act(() => { useSubtitleLookStore.setState({ shadow: 0, align: 'left' }); });
    }
  });
});

describe('SubtitleBody — an answer stays long enough to be read (fork)', () => {
  const theirs = (id: string, source: string, answer = ''): Entry => ({
    kind: 'exchange', id, leg: 'participant', languages: { source: 'ja', target: 'zh-CN' }, pairing: 'stated',
    source: [row(`s-${id}`, 0, 0, source)], translation: answer ? [row(`t-${id}`, 0, 0, answer, 'translation')] : [], t: 0,
  });
  const answer = (container: HTMLElement) => container.querySelector('[data-lane="participant"] .subtitle-lane__answer .subtitle-lane__text')?.textContent;

  it('keeps the answer on screen for its reading time when the next comes at once, then shows the next', () => {
    vi.useFakeTimers();
    try {
      const first = [theirs('a', 'これで全種かな。', '这样就是所有种类了。')];
      const { container, rerender } = render(<SubtitleBody {...props({ entries: first, legs: ['participant'] })} />);
      expect(answer(container)).toBe('这样就是所有种类了。');
      // The next sentence is answered a moment later: gone at once, the first was never read (seen 2026-10-06).
      act(() => { vi.advanceTimersByTime(300); });
      const second = [...first, theirs('b', 'はい。', '好的。')];
      rerender(<SubtitleBody {...props({ entries: second, legs: ['participant'] })} />);
      expect(answer(container)).toBe('这样就是所有种类了。');
      act(() => { vi.advanceTimersByTime(700); });
      expect(answer(container)).toBe('这样就是所有种类了。');
      // Ten characters of Chinese: the least a caption is held, 1.2 s from when it came.
      act(() => { vi.advanceTimersByTime(300); });
      expect(answer(container)).toBe('好的。');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows an answer at once where the one before has been read already', () => {
    vi.useFakeTimers();
    try {
      const first = [theirs('a', 'これで全種かな。', '这样就是所有种类了。')];
      const { container, rerender } = render(<SubtitleBody {...props({ entries: first, legs: ['participant'] })} />);
      act(() => { vi.advanceTimersByTime(3000); });
      rerender(<SubtitleBody {...props({ entries: [...first, theirs('b', 'はい。', '好的。')], legs: ['participant'] })} />);
      act(() => { vi.advanceTimersByTime(20); });
      expect(answer(container)).toBe('好的。');
    } finally {
      vi.useRealTimers();
    }
  });
});
