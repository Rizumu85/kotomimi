import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';

vi.mock('react-i18next', async (importOriginal) => ({ ...(await importOriginal<typeof import('react-i18next')>()), useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../Settings/engine/languageName', () => ({ languageNameFor: (code: string) => code }));

import { useProviderStore } from '../../stores/providerStore';
import { FontSection } from './FontSection';

describe('FontSection — the readings have fonts of their own (fork)', () => {
  beforeEach(() => {
    useProviderStore.setState({ selected: 'localai', entries: { localai: { settings: {}, credentials: {}, pair: { source: 'zh-CN', target: 'ja' } } } as never });
  });

  it('offers pinyin over Chinese and furigana over Japanese, and neither elsewhere', () => {
    render(<FontSection />);
    expect(screen.getAllByText('fork.fonts.pinyin')).toHaveLength(1);
    expect(screen.getAllByText('fork.fonts.reading')).toHaveLength(1);
    act(() => useProviderStore.setState({ entries: { localai: { settings: {}, credentials: {}, pair: { source: 'en', target: 'ko' } } } as never }));
    expect(screen.queryByText('fork.fonts.pinyin')).toBeNull();
    expect(screen.queryByText('fork.fonts.reading')).toBeNull();
  });
});
