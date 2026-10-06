/**
 * Fork: the reading aids on the two surfaces that draw conversation text —
 * the list (the panel's, and the subtitle's expanded view) and the
 * subtitle's compact bands — with the real dictionary.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { act, render } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | { defaultValue?: string }) => (typeof fallback === 'string' ? fallback : fallback?.defaultValue ?? key),
  }),
}));

import { japaneseTokenizer, loadJapanese } from '../../lib/annotate/japaneseStore';
import type { Entry, Row } from '../../lib/projection/types';
import { useAnnotationStore } from '../../stores/annotationStore';
import { SubtitleBody, type SubtitleBodyProps } from '../Subtitle/SubtitleBands';

const DICT = resolve(__dirname, '../../../node_modules/@sglkc/kuromoji/dict');
const fromDisk = async (name: string) => {
  const data = gunzipSync(readFileSync(resolve(DICT, name)));
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
};

const row = (segmentId: string, text: string, side: 'source' | 'translation', language?: string): Row =>
  ({ key: `${segmentId}:0`, segmentId, side, start: 0, end: text.length, text, final: true, ...(language ? { language } : {}) });
/** "I read Chinese, the other side speaks Japanese": the participant leg hears Japanese and translates it into Chinese. */
const heard: Entry = { kind: 'exchange', id: 'a', leg: 'participant', languages: { source: 'ja', target: 'zh-CN' }, pairing: 'stated', source: [row('s1', '今日は天気がいいですね。', 'source')], translation: [row('t1', '今天天气真好。', 'translation')], t: 0 };
const props = (over: Partial<SubtitleBodyProps> = {}): SubtitleBodyProps => ({
  entries: [heard], lit: new Map(), compact: true, fontSize: 24, filters: { speaker: 'both', participant: 'both' }, newItemHighlightEnabled: false, ...over,
});
const rubies = (el: Element) => Array.from(el.querySelectorAll('ruby')).map((r) => `${r.firstChild?.textContent}[${r.querySelector('rt')?.textContent}]`);

beforeAll(async () => {
  loadJapanese(fromDisk);
  await vi.waitFor(() => expect(japaneseTokenizer()).toBeDefined(), { timeout: 30_000 });
}, 60_000);
afterEach(() => { useAnnotationStore.setState({ furigana: true, romanization: false }); });

describe('reading aids on the subtitle', () => {
  it('annotates the Japanese band by its leg\'s language, in the line, and leaves the Chinese band plain', () => {
    const { container } = render(<SubtitleBody {...props()} />);
    const [source, translation] = [container.querySelector('.subtitle-lane__source')!, container.querySelector('.subtitle-lane__answer')!];
    expect(rubies(source)).toEqual(['今日[きょう]', '天気[てんき]']);
    expect(source.querySelector('.annot--inline')).not.toBeNull();
    expect(translation.querySelector('ruby')).toBeNull();
    expect(translation.textContent).toBe('今天天气真好。');
  });

  it('adds the romanization under the band\'s text when it is switched on, and drops both aids when they are off', () => {
    act(() => { useAnnotationStore.setState({ romanization: true }); });
    const on = render(<SubtitleBody {...props()} />);
    expect(on.container.querySelector('.subtitle-lane__source .annot-roman')?.textContent).toBe('kyou wa tenki ga ii desu ne.');
    on.unmount();
    act(() => { useAnnotationStore.setState({ furigana: false, romanization: false }); });
    const off = render(<SubtitleBody {...props()} />);
    expect(off.container.querySelector('ruby')).toBeNull();
    expect(off.container.querySelector('.subtitle-lane__source')?.textContent).toBe('Other今日は天気がいいですね。');
  });

  it('reads a row by the language its provider reported, over its leg\'s: a coached speaker\'s Japanese on a Chinese leg', () => {
    const coached: Entry = {
      kind: 'exchange', id: 'b', leg: 'speaker', languages: { source: 'zh-CN', target: 'ja' }, pairing: 'stated', t: 0,
      source: [row('s2', '大丈夫', 'source', 'ja')],
      translation: [row('t2', '✓', 'translation', 'zh-CN')],
    };
    const { container } = render(<SubtitleBody {...props({ entries: [coached] })} />);
    expect(rubies(container.querySelector('.subtitle-lane__source')!)).toEqual(['大丈夫[だいじょうぶ]']);
  });

  it('annotates the expanded list the same way', () => {
    const { container } = render(<SubtitleBody {...props({ compact: false })} />);
    expect(rubies(container)).toEqual(['今日[きょう]', '天気[てんき]']);
  });
});
