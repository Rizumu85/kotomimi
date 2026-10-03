import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { act, render } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { japaneseTokenizer, loadJapanese } from '../../lib/annotate/japaneseStore';
import { useAnnotationStore } from '../../stores/annotationStore';
import { AnnotatedLines, useAnnotation } from './AnnotatedText';

const DICT = resolve(__dirname, '../../../node_modules/@sglkc/kuromoji/dict');
const fromDisk = async (name: string) => {
  const data = gunzipSync(readFileSync(resolve(DICT, name)));
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
};

/** A row as a surface draws it: annotated when there is something to add, else the plain text. */
function Row({ text, language }: { text: string; language?: string }) {
  const lines = useAnnotation(text, language);
  return <div data-testid="row">{lines ? <AnnotatedLines lines={lines} /> : <span className="plain">{text}</span>}</div>;
}

const set = (furigana: boolean, romanization: boolean) => act(() => { useAnnotationStore.setState({ furigana, romanization }); });
const rubies = (el: HTMLElement) => Array.from(el.querySelectorAll('ruby')).map((r) => `${r.firstChild?.textContent}[${r.querySelector('rt')?.textContent}]`);

beforeAll(async () => {
  loadJapanese(fromDisk);
  await vi.waitFor(() => expect(japaneseTokenizer()).toBeDefined(), { timeout: 30_000 });
}, 60_000);
afterEach(() => { useAnnotationStore.setState({ furigana: true, romanization: false }); });

describe('conversation text with reading aids', () => {
  it('draws hiragana over the kanji of a Japanese row, and leaves the kana plain', () => {
    const { container } = render(<Row text="今日は天気がいいですね。" language="ja" />);
    expect(rubies(container)).toEqual(['今日[きょう]', '天気[てんき]']);
    expect(container.querySelector('.annot-text')?.textContent).toBe('今日きょうは天気てんきがいいですね。');
    expect(container.querySelector('.annot-roman')).toBeNull();
  });

  it('adds the romanization line when it is switched on', () => {
    set(true, true);
    const { container } = render(<Row text="今日は天気がいいですね。" language="ja" />);
    expect(container.querySelector('.annot-roman')?.textContent).toBe('kyou wa tenki ga ii desu ne.');
  });

  it('is the plain text with both switches off, and for a language with no aid', () => {
    const chinese = render(<Row text="今天天气很好。" language="zh-CN" />);
    expect(chinese.container.querySelector('.plain')?.textContent).toBe('今天天气很好。');
    set(false, false);
    const japanese = render(<Row text="今日は天気がいいですね。" language="ja" />);
    expect(japanese.container.querySelector('.plain')).not.toBeNull();
    expect(japanese.container.querySelector('ruby')).toBeNull();
  });

  it('romanizes Korean and Russian only when romanization is on', () => {
    const off = render(<Row text="감사합니다" language="ko" />);
    expect(off.container.querySelector('.plain')).not.toBeNull();
    set(true, true);
    const korean = render(<Row text="감사합니다" language="ko" />);
    expect(korean.container.querySelector('.annot-roman')?.textContent).toBe('gamsahamnida');
    const russian = render(<Row text="Спасибо" language="ru" />);
    expect(russian.container.querySelector('.annot-roman')?.textContent).toBe('Spasibo');
  });

  it('annotates grammar feedback line by line: the corrected sentence, not its Chinese explanation', () => {
    const { container } = render(<Row text={'昨日映画を見ました。\n动词时态与过去时间不符。'} language="zh-CN" />);
    const lines = Array.from(container.querySelectorAll('.annot-line'));
    expect(lines).toHaveLength(2);
    expect(rubies(lines[0] as HTMLElement)).toEqual(['昨日[きのう]', '映画[えいが]', '見[み]']);
    expect(lines[1].querySelector('ruby')).toBeNull();
    expect(lines[1].textContent).toBe('动词时态与过去时间不符。');
  });
});
