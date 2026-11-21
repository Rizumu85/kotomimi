import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useLineVoiceStore } from '../../stores/lineVoiceStore';
import { RowSay } from './RowSay';

const sayLine = vi.fn(async () => undefined);
const stopLine = vi.fn();
vi.mock('../../app/lineVoice', () => ({ sayLine: (...args: unknown[]) => sayLine(...(args as [])), stopLine: () => stopLine() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }) }));

afterEach(() => {
  cleanup();
  sayLine.mockClear();
  stopLine.mockClear();
  useLineVoiceStore.setState({ ready: false, languages: null, line: null, phase: 'idle', failed: null });
});

describe('RowSay — a line said aloud (fork)', () => {
  it('asks for its own line, in the row\'s language', async () => {
    render(<RowSay id="s1:0" text="こんにちは。" language="ja" />);
    fireEvent.click(screen.getByRole('button', { name: 'Read this line aloud' }));
    await waitFor(() => expect(sayLine).toHaveBeenCalledWith('s1:0', 'こんにちは。', 'ja'));
  });

  it('stops its line while that is being fetched or heard, and leaves another row\'s alone', async () => {
    useLineVoiceStore.setState({ line: 's1:0', phase: 'playing' });
    render(<><RowSay id="s1:0" text="こんにちは。" language="ja" /><RowSay id="s2:0" text="ありがとう。" language="ja" /></>);
    const [mine, other] = screen.getAllByRole('button');
    expect(mine.getAttribute('aria-pressed')).toBe('true');
    expect(other.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(mine);
    await waitFor(() => expect(stopLine).toHaveBeenCalledTimes(1));
    expect(sayLine).not.toHaveBeenCalled();
  });

  it('says so on the line that could not be read, until another is asked for', () => {
    useLineVoiceStore.setState({ failed: 's1:0' });
    render(<RowSay id="s1:0" text="こんにちは。" language="ja" />);
    expect(screen.getByRole('button', { name: 'This line could not be read aloud' })).toBeTruthy();
  });

  it('cannot be pressed where nothing may be played, and says why', () => {
    render(<RowSay id="s1:0" text="こんにちは。" language="ja" blocked="Replay is off while Other's audio captures all system sound." />);
    const button = screen.getByRole('button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toContain('Replay is off');
  });
});
