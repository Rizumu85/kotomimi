import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';

vi.mock('../../services/ServiceFactory', () => ({
  ServiceFactory: { getSettingsService: () => ({ setSetting: async () => ({ success: true }) }) },
}));
vi.mock('react-i18next', async (importOriginal) => ({ ...(await importOriginal<typeof import('react-i18next')>()), useTranslation: () => ({ t: (key: string) => key }) }));

import { useGlossaryStore } from '../../stores/glossaryStore';
import { heardIn, WordFix } from './WordFix';

const rows = `
  <span class="row-text src"><ruby>今日<rt>きょう</rt></ruby>はリズムさん<span class="annot-roman">kyou wa rizumu san</span></span>
  <span class="row-text tr">今天是节奏先生</span>`;

function select(display: HTMLElement, startText: Node, start: number, endText: Node, end: number) {
  const range = document.createRange();
  range.setStart(startText, start);
  range.setEnd(endText, end);
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return display;
}

function shown() {
  const display = document.createElement('div');
  display.innerHTML = rows;
  document.body.append(display);
  const [source, translation] = [display.querySelector('.row-text.src')!, display.querySelector('.row-text.tr')!];
  return { display, source, translation };
}

afterEach(() => {
  document.getSelection()?.removeAllRanges();
  document.body.innerHTML = '';
  useGlossaryStore.setState({ entries: [] });
});

describe('heardIn — what is taken from the conversation (fork)', () => {
  it('is what was said, without the readings over it or the romanization under it', () => {
    const { display, source } = shown();
    const ruby = source.querySelector('ruby')!;
    const after = ruby.nextSibling!;
    select(display, ruby.firstChild!, 0, after, 6);
    expect(heardIn(display)?.text).toBe('今日はリズムさん');
  });

  it('is nothing in a translation, across rows, or for a whole paragraph', () => {
    const { display, source, translation } = shown();
    select(display, translation.firstChild!, 0, translation.firstChild!, 3);
    expect(heardIn(display)).toBeNull();
    select(display, source.lastChild!.firstChild!, 0, translation.firstChild!, 3);
    expect(heardIn(display)).toBeNull();
    translation.className = 'row-text src';
    translation.textContent = 'あ'.repeat(41);
    select(display, translation.firstChild!, 0, translation.firstChild!, 41);
    expect(heardIn(display)).toBeNull();
  });
});

describe('WordFix — a word put right (fork)', () => {
  function Conversation() {
    const display = useRef<HTMLDivElement>(null);
    return (
      <>
        <div ref={display} data-testid="display"><span className="row-text src">リズムさんが来た</span></div>
        <WordFix display={display} />
      </>
    );
  }

  const select3 = () => {
    const display = screen.getByTestId('display');
    const text = display.querySelector('.row-text')!.firstChild!;
    select(display, text, 0, text, 3);
    act(() => { fireEvent.mouseUp(display); });
  };
  const pick = () => {
    select3();
    fireEvent.click(screen.getByText('settings.glossaryFixOpen'));
  };

  it('asks nothing of a selection: a small button beside it, which leaves it to be copied', () => {
    render(<Conversation />);
    select3();
    expect(screen.queryByLabelText('settings.glossaryFixTo')).toBeNull();
    const button = screen.getByText('settings.glossaryFixOpen').closest('button')!;
    // Pressing it does not move the focus, so what is selected stays selected.
    expect(fireEvent.mouseDown(button)).toBe(false);
    expect(document.getSelection()?.toString()).toBe('リズム');
    // And it goes with the selection.
    act(() => {
      document.getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event('selectionchange'));
    });
    expect(screen.queryByText('settings.glossaryFixOpen')).toBeNull();
  });

  it('writes the word and what it was heard as into the glossary', async () => {
    render(<Conversation />);
    pick();
    const field = screen.getByLabelText('settings.glossaryFixTo') as HTMLInputElement;
    expect(field.value).toBe('リズム');
    fireEvent.change(field, { target: { value: 'Rizum' } });
    fireEvent.click(screen.getByText('settings.glossaryFixSave'));
    expect(useGlossaryStore.getState().entries).toMatchObject([{ source: 'Rizum', aliases: ['リズム'] }]);
    expect(screen.queryByLabelText('settings.glossaryFixTo')).toBeNull();
    await vi.dynamicImportSettled();
  });

  it('reaches a run that has started: what it holds is the table, not a copy', () => {
    const held = useGlossaryStore.getState().snapshot();
    expect(held.entries).toEqual([]);
    useGlossaryStore.setState({ entries: [{ id: 'one', source: 'Rizum', aliases: ['リズム'] }] });
    expect(held.entries).toHaveLength(1);
  });

  it('adds to a word it already has, and writes nothing for the word unchanged', () => {
    useGlossaryStore.setState({ entries: [{ id: 'one', source: 'Rizum', aliases: ['りずむ'] }] });
    render(<Conversation />);
    pick();
    expect((screen.getByText('settings.glossaryFixSave') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('settings.glossaryFixTo'), { target: { value: 'rizum' } });
    fireEvent.click(screen.getByText('settings.glossaryFixSave'));
    expect(useGlossaryStore.getState().entries).toMatchObject([{ id: 'one', source: 'rizum', aliases: ['りずむ', 'リズム'] }]);
  });
});
