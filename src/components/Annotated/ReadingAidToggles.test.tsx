import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../services/persistSetting', () => ({ persistSetting: async () => true }));
vi.mock('react-i18next', async (importOriginal) => ({ ...(await importOriginal<typeof import('react-i18next')>()), useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../Settings/engine/languageName', () => ({ languageNameFor: (code: string) => code }));

import { useAnnotationStore } from '../../stores/annotationStore';
import { ReadingAidToggles } from './ReadingAidToggles';

afterEach(() => useAnnotationStore.setState({ romanization: false, romanizationOff: [] }));

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
  });
});
