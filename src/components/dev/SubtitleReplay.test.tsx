import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import fixture from '../../lib/subtitle/__fixtures__/capture.json';
import { SubtitleReplay } from './SubtitleReplay';

/** jsdom's File has no `text()`, which every browser's has. */
const fileOf = (text: string): File => Object.assign(new File([text], 'capture.json', { type: 'application/json' }), { text: async () => text });

describe('the subtitle replay (fork, development)', () => {
  it('draws a saved capture again: its lines, in a box of the window size it was saved at', async () => {
    const { container } = render(<SubtitleReplay />);
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [fileOf(JSON.stringify(fixture))] } });
    await waitFor(() => expect(screen.getAllByText(/はい/).length).toBeGreaterThan(0));
    const viewport = (fixture as { frames: Array<{ state: { viewport?: { width: number } } }> }).frames[0].state.viewport!;
    expect(container.querySelector<HTMLElement>('div[style*="dashed"]')!.style.width).toBe(`${viewport.width}px`);
  });

  it('says why a file is not a capture, and draws nothing', async () => {
    const { container } = render(<SubtitleReplay />);
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [fileOf('{"format":"other"}')] } });
    await waitFor(() => expect(container.textContent).toMatch(/\S/));
    expect(container.querySelector('div[style*="dashed"]')).toBeNull();
  });
});
