import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import MicGateControl, { MIC_TEST_MOST_MS } from './MicGateControl';
import { micLevel } from '../../../lib/audio/micLevel';
import type { Source } from '../../../lib/session/source';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, def?: string) => def ?? key }),
}));

const store = vi.hoisted(() => ({ threshold: 0, set: vi.fn() }));
vi.mock('../../../stores/audioStore', () => ({
  useMicGateThreshold: () => store.threshold,
  useSetMicGateThreshold: () => store.set,
}));
// The real microphone is never opened here: the test is handed a source of its own.
vi.mock('../../../lib/audio/appCapture', () => ({ micSettings: () => ({}) }));
vi.mock('../../../lib/audio/capture/mic', () => ({ openMic: vi.fn() }));

function fakeSource() {
  const ended = new Set<(reason: string) => void>();
  const stop = vi.fn(async () => {});
  const source: Source = {
    onPcm: () => () => {},
    onEnded: (listener) => { ended.add(listener); return () => { ended.delete(listener); }; },
    onDegraded: () => () => {},
    stop,
  };
  return { source, stop, end: (reason: string) => { for (const listener of [...ended]) listener(reason); } };
}

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const testButton = () => screen.getByRole('button', { name: /test the microphone|stop the test/i });

beforeEach(() => {
  store.threshold = 0;
  store.set.mockReset();
  micLevel.reset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  micLevel.reset();
});

describe('MicGateControl — the threshold', () => {
  it('shows Off at nought and the percentage otherwise', () => {
    const { rerender } = render(<MicGateControl isSessionActive={false} />);
    expect(screen.getByTestId('mic-gate-value')).toHaveTextContent('Off');
    store.threshold = 35;
    rerender(<MicGateControl isSessionActive={false} />);
    expect(screen.getByTestId('mic-gate-value')).toHaveTextContent('35%');
  });

  it('writes the threshold when the slider is let go, not at every step', () => {
    render(<MicGateControl isSessionActive={false} />);
    const slider = screen.getByLabelText('Mic activation threshold');
    fireEvent.change(slider, { target: { value: '40' } });
    expect(screen.getByTestId('mic-gate-value')).toHaveTextContent('40%');
    expect(store.set).not.toHaveBeenCalled();
    fireEvent.pointerUp(slider);
    expect(store.set).toHaveBeenCalledWith(40);
  });

  it('is locked with the section', () => {
    render(<MicGateControl isSessionActive={false} disabled />);
    expect(screen.getByLabelText('Mic activation threshold')).toBeDisabled();
  });
});

describe('MicGateControl — the meter', () => {
  it('follows the microphone’s level on its frames, and lights up over the mark', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const frame = () => act(() => { for (const callback of frames.splice(0)) callback(0); });
    store.threshold = 50;
    render(<MicGateControl isSessionActive={false} />);
    // Nothing reporting: the hint says how to see a level.
    expect(screen.getByText(/press the microphone/i)).toBeInTheDocument();
    micLevel.set(70);
    frame();
    const fill = screen.getByTestId('mic-gate-fill');
    expect(fill.style.width).toBe('70%');
    expect(fill.classList.contains('is-over')).toBe(true);
    expect(screen.queryByText(/press the microphone/i)).not.toBeInTheDocument();
    micLevel.set(30);
    frame();
    expect(fill.style.width).toBe('30%');
    expect(fill.classList.contains('is-over')).toBe(false);
  });

  it('while a run holds the microphone and nothing has come from it yet, says so instead of the test hint', () => {
    render(<MicGateControl isSessionActive={true} />);
    expect(screen.getByText(/nothing from the microphone yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('MicGateControl — the test', () => {
  it('opens the microphone on the first press and lets go of it on the second', async () => {
    const fake = fakeSource();
    const open = vi.fn(async () => fake.source);
    render(<MicGateControl isSessionActive={false} openForTest={open} />);
    fireEvent.click(testButton());
    await flush();
    expect(open).toHaveBeenCalledTimes(1);
    expect(testButton()).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(testButton());
    expect(fake.stop).toHaveBeenCalledTimes(1);
    expect(testButton()).toHaveAttribute('aria-pressed', 'false');
  });

  it('lets go of the microphone the moment a run begins — a driver may not open one device twice', async () => {
    const fake = fakeSource();
    const { rerender } = render(<MicGateControl isSessionActive={false} openForTest={async () => fake.source} />);
    fireEvent.click(testButton());
    await flush();
    rerender(<MicGateControl isSessionActive={true} openForTest={async () => fake.source} />);
    expect(fake.stop).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('ends when the microphone itself ends', async () => {
    const fake = fakeSource();
    render(<MicGateControl isSessionActive={false} openForTest={async () => fake.source} />);
    fireEvent.click(testButton());
    await flush();
    act(() => fake.end('unplugged'));
    expect(testButton()).toHaveAttribute('aria-pressed', 'false');
  });

  it('ends by itself after a while', async () => {
    vi.useFakeTimers();
    const fake = fakeSource();
    render(<MicGateControl isSessionActive={false} openForTest={async () => fake.source} />);
    fireEvent.click(testButton());
    await flush();
    act(() => { vi.advanceTimersByTime(MIC_TEST_MOST_MS - 1); });
    expect(fake.stop).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(fake.stop).toHaveBeenCalledTimes(1);
  });

  it('ends with the section', async () => {
    const fake = fakeSource();
    const { unmount } = render(<MicGateControl isSessionActive={false} openForTest={async () => fake.source} />);
    fireEvent.click(testButton());
    await flush();
    unmount();
    expect(fake.stop).toHaveBeenCalledTimes(1);
  });

  it('lets go of a microphone that opened after the test was stopped', async () => {
    const fake = fakeSource();
    let resolve!: (source: Source) => void;
    const open = () => new Promise<Source>((r) => { resolve = r; });
    render(<MicGateControl isSessionActive={false} openForTest={open} />);
    fireEvent.click(testButton());
    fireEvent.click(testButton());
    await act(async () => { resolve(fake.source); await Promise.resolve(); });
    expect(fake.stop).toHaveBeenCalledTimes(1);
    expect(testButton()).toHaveAttribute('aria-pressed', 'false');
  });

  it('stays off, quietly, when the microphone will not open', async () => {
    render(<MicGateControl isSessionActive={false} openForTest={async () => { throw new Error('no device'); }} />);
    fireEvent.click(testButton());
    await flush();
    expect(testButton()).toHaveAttribute('aria-pressed', 'false');
  });
});
