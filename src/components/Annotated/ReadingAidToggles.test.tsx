import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

// The service, not `persistSetting`: a second import of a mocked module while the first is under way can load the real
// one, which then loads the settings service after the test's environment has gone (failed v0.43.134's run on CI).
vi.mock('../../services/ServiceFactory', () => ({
  ServiceFactory: { getSettingsService: () => ({ setSetting: async () => ({ success: true }) }) },
}));
vi.mock('react-i18next', async (importOriginal) => ({ ...(await importOriginal<typeof import('react-i18next')>()), useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../Settings/engine/languageName', () => ({ languageNameFor: (code: string) => code }));

import { useAnnotationStore } from '../../stores/annotationStore';
import { ReadingAidToggles } from './ReadingAidToggles';

afterEach(() => useAnnotationStore.setState({ romanization: false, romanizationOff: [] }));

describe('ReadingAidToggles — the groups (fork)', () => {
  it('says in full what a button does, and has the highlight only where it is given', () => {
    const toggle = vi.fn();
    const { rerender } = render(<ReadingAidToggles />);
    expect(screen.getByRole('button', { name: 'fork.aids.furigana' }).getAttribute('title')).toBe('fork.furigana');
    expect(screen.queryByRole('button', { name: 'fork.aids.highlight' })).toBeNull();
    rerender(<ReadingAidToggles highlight={{ on: true, toggle }} />);
    fireEvent.click(screen.getByRole('button', { name: 'fork.aids.highlight' }));
    expect(toggle).toHaveBeenCalledTimes(1);
  });
});

describe('ReadingAidToggles — the romanization by language (fork)', () => {
  it('shows its languages only with the romanization on', () => {
    render(<ReadingAidToggles />);
    expect(screen.queryByText('ja')).toBeNull();
  });

  it('takes a language out and puts it back, the others as they were', async () => {
    useAnnotationStore.setState({ romanization: true });
    render(<ReadingAidToggles />);
    fireEvent.click(screen.getByText('ja'));
    await vi.waitFor(() => expect(useAnnotationStore.getState().romanizationOff).toEqual(['ja']));
    expect(screen.getByText('ja').getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByText('ko').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByText('ja'));
    await vi.waitFor(() => expect(useAnnotationStore.getState().romanizationOff).toEqual([]));
    // What the store wrote has been written: nothing of the test is left running as its environment goes.
    await vi.dynamicImportSettled();
  });
});
