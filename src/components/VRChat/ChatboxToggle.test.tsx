import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../app/vrchatHandle', () => ({ vrchatOffered: () => true }));
vi.mock('../../services/persistSetting', () => ({ persistSetting: async () => {} }));
vi.mock('react-i18next', async (importOriginal) => ({ ...(await importOriginal<typeof import('react-i18next')>()), useTranslation: () => ({ t: (key: string) => key }) }));

import { useVRChatStore } from '../../stores/vrchatStore';
import { ChatboxToggle } from './ChatboxToggle';

beforeEach(() => {
  useVRChatStore.setState({ chatbox: 'off', chatboxLast: null });
});

describe('ChatboxToggle — the chatbox on or off from the main panel (fork)', () => {
  it('is not there before a look was ever chosen', () => {
    render(<ChatboxToggle />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('turns it off, and on again to the last look', () => {
    useVRChatStore.setState({ chatbox: 'both', chatboxLast: 'both' });
    render(<ChatboxToggle />);
    const button = screen.getByRole('button', { name: 'fork.vrchat.chatbox' });
    expect(button.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(button);
    expect(useVRChatStore.getState().chatbox).toBe('off');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(button);
    expect(useVRChatStore.getState().chatbox).toBe('both');
  });
});
