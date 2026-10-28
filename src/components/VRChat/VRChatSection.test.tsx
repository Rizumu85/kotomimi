import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../app/vrchatHandle', () => ({ vrchatOffered: () => true }));
vi.mock('../../services/persistSetting', () => ({ persistSetting: async () => {} }));
vi.mock('react-i18next', async (importOriginal) => ({ ...(await importOriginal<typeof import('react-i18next')>()), useTranslation: () => ({ t: (key: string) => key }) }));

import useAudioStore from '../../stores/audioStore';
import { useVRChatStore } from '../../stores/vrchatStore';
import { useProviderStore } from '../../stores/providerStore';
import { VRChatSection } from './VRChatSection';

beforeEach(() => {
  useVRChatStore.setState({ chatbox: 'off', chatboxTranslationFirst: false, recent: null, viewers: 0 });
  useProviderStore.setState({ selected: 'localai', entries: { localai: { settings: {}, credentials: {}, pair: { source: 'zh-CN', target: 'ja' } } } as never });
});

describe('VRChatSection — the chatbox chosen from pictures of it (fork)', () => {
  it('chooses what is shown and which goes on top, and shows the chatbox as it will look', () => {
    render(<VRChatSection />);
    expect(document.querySelector('.kt-chatbox-preview')).toBeNull();
    fireEvent.click(screen.getByText('fork.vrchat.chatboxTranslationFirst'));
    expect(useVRChatStore.getState()).toMatchObject({ chatbox: 'both', chatboxTranslationFirst: true });
    // Before anything was said: a sentence in the pair's languages, the translation on top.
    expect([...document.querySelectorAll('.kt-chatbox-preview__line')].map((l) => l.textContent)).toEqual(['次のワールドに行こう', '我们去下一个世界吧']);
    fireEvent.click(screen.getByText('fork.vrchat.chatboxSourceFirst'));
    expect(useVRChatStore.getState()).toMatchObject({ chatbox: 'both', chatboxTranslationFirst: false });
    fireEvent.click(screen.getByText('fork.vrchat.chatboxTranslation'));
    expect(useVRChatStore.getState().chatbox).toBe('translation');
    expect(screen.getByText('fork.vrchat.chatboxTranslation').closest('button')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('shows the user’s last sentence once there is one', () => {
    useVRChatStore.setState({ chatbox: 'both', recent: { said: '你好', translation: 'こんにちは' } });
    render(<VRChatSection />);
    expect([...document.querySelectorAll('.kt-chatbox-preview__line')].map((l) => l.textContent)).toEqual(['你好', 'こんにちは']);
  });
});

describe('VRChatSection — a chatbox that would stay empty (fork)', () => {
  it('says so while only the other side is heard, with the way to hear both, and is quiet otherwise', () => {
    useAudioStore.setState({ mode: 'participant' });
    useVRChatStore.setState({ chatbox: 'translation' });
    render(<VRChatSection />);
    expect(screen.getByText('fork.vrchat.chatboxUnheard')).toBeTruthy();
    // No picture of a chatbox that stays empty.
    expect(document.querySelector('.kt-chatbox-preview')).toBeNull();
    fireEvent.click(screen.getByText('fork.vrchat.chatboxHearBoth'));
    expect(useAudioStore.getState().mode).toBe('both');
    expect(screen.queryByText('fork.vrchat.chatboxUnheard')).toBeNull();
    // The chatbox off: nothing to say.
    act(() => { useAudioStore.setState({ mode: 'participant' }); useVRChatStore.setState({ chatbox: 'off' }); });
    expect(screen.queryByText('fork.vrchat.chatboxUnheard')).toBeNull();
  });
});
