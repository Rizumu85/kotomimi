// src/components/Banner/useBanners.fork.test.tsx
//
// Fork: what the fork changes of the audio-system banner — Windows' missing VB-CABLE said as that, and nothing said
// to a provider that never speaks. These were cases of AudioSystemBanner.test.tsx before upstream drew every banner
// with one component (0.43.0).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Banners } from './useBanners';
import useAudioSystemStore from '../../stores/audioSystemStore';
import useUpdateStore from '../../stores/updateStore';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
afterEach(cleanup);

beforeEach(() => {
  useUpdateStore.setState({ status: 'idle', bannerDismissed: false, errorFrom: null });
  useAudioSystemStore.setState({ status: 'unavailable', platform: 'win32', reason: 'vbcable-missing' as never, message: null, dismissed: false, retrying: false, repairing: false, repairFailed: false, retry: vi.fn(async () => {}) });
});

describe('Banners — the audio system, as the fork has it', () => {
  it('says on Windows that VB-CABLE is not installed, and offers to install it', () => {
    render(<Banners />);
    expect(screen.getByText('fork.audio.vbcableMissing')).toBeTruthy();
    expect(screen.queryByText('audioSystem.unavailableBody')).toBeNull();
    expect(screen.queryByText('audioSystem.retry')).toBeNull();
    fireEvent.click(screen.getByText('fork.audio.vbcableInstall'));
    expect(useAudioSystemStore.getState().retry).toHaveBeenCalled();
  });

  it('says it is installing while the retry runs', () => {
    useAudioSystemStore.setState({ retrying: true });
    render(<Banners />);
    expect(screen.getByText('fork.audio.vbcableInstalling')).toBeTruthy();
  });

  it('says nothing to a provider that never speaks: subtitles need no virtual microphone', () => {
    const { container } = render(<Banners speaks={false} />);
    expect(container.innerHTML).toBe('');
  });

  it('still tells a provider that never speaks of an update', () => {
    useUpdateStore.setState({ status: 'available', newVersion: '9.9.9', supportsAutoUpdate: true });
    render(<Banners speaks={false} />);
    expect(screen.getByText('update.available')).toBeTruthy();
    expect(screen.queryByText('fork.audio.vbcableMissing')).toBeNull();
  });
});
