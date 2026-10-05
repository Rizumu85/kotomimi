// Fork: the switch for the source text's slant — the store's field, the document's property the stylesheets read,
// and the switch itself at the foot of the display popover.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const stored = vi.hoisted(() => ({ values: {} as Record<string, unknown>, writes: [] as Array<[string, unknown]>, fail: false }));
vi.mock('../../services/persistSetting', () => ({
  persistSetting: async (key: string, value: unknown) => { stored.writes.push([key, value]); return !stored.fail; },
}));
vi.mock('../../services/ServiceFactory', () => ({
  ServiceFactory: { getSettingsService: () => ({ getSetting: async (key: string, fallback: unknown) => (key in stored.values ? stored.values[key] : fallback) }) },
}));

import { SOURCE_FONT_STYLE, useAnnotationStore } from '../../stores/annotationStore';
import { ReadingAidToggles } from './ReadingAidToggles';

const slant = () => document.documentElement.style.getPropertyValue(SOURCE_FONT_STYLE);

beforeEach(async () => {
  stored.values = {};
  stored.writes = [];
  stored.fail = false;
  await useAnnotationStore.getState().hydrate();
});

describe('the source text\'s slant', () => {
  it('is on unless it was switched off: the look upstream gave it', async () => {
    expect(useAnnotationStore.getState().sourceItalic).toBe(true);
    expect(slant()).toBe('italic');
    stored.values = { 'settings.common.annotation.sourceItalic': false };
    await useAnnotationStore.getState().hydrate();
    expect(useAnnotationStore.getState().sourceItalic).toBe(false);
    expect(slant()).toBe('normal');
  });

  it('is told to the document as the switch moves, and kept', async () => {
    await useAnnotationStore.getState().setSourceItalic(false);
    expect(slant()).toBe('normal');
    expect(stored.writes).toEqual([['settings.common.annotation.sourceItalic', false]]);
    await useAnnotationStore.getState().setSourceItalic(true);
    expect(slant()).toBe('italic');
  });

  it('goes back when it could not be saved', async () => {
    stored.fail = true;
    await useAnnotationStore.getState().setSourceItalic(false);
    expect(useAnnotationStore.getState().sourceItalic).toBe(true);
    expect(slant()).toBe('italic');
  });

  it('has its switch above the reading aids\', and leaves theirs alone', () => {
    render(<ReadingAidToggles />);
    const labels = [...document.querySelectorAll('.reading-aid-toggle')].map((n) => n.textContent);
    expect(labels).toEqual(['fork.sourceItalic', 'fork.furigana', 'fork.romanization']);
    fireEvent.click(screen.getByRole('switch', { name: 'fork.sourceItalic' }));
    expect(useAnnotationStore.getState().sourceItalic).toBe(false);
    expect(useAnnotationStore.getState().furigana).toBe(true);
  });
});
