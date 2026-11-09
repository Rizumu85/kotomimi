import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../app/vrchatHandle', () => ({ vrchatOffered: () => true }));
vi.mock('../../services/persistSetting', () => ({ persistSetting: async () => {} }));
vi.mock('react-i18next', async (importOriginal) => ({ ...(await importOriginal<typeof import('react-i18next')>()), useTranslation: () => ({ t: (key: string) => key }) }));

import { useVrStore } from '../../stores/vrStore';
import { VrHeadsetSection } from './VrHeadsetSection';

beforeEach(() => {
  useVrStore.setState({ on: false, panel: false, link: 'off' });
});

describe('VrHeadsetSection — the SteamVR overlay, a card of its own (fork)', () => {
  it('is two parts pressed on or off, the captions and the wrist panel, and no state while off', () => {
    render(<VrHeadsetSection />);
    expect(screen.getByText('fork.vr.title')).toBeTruthy();
    const strip = screen.getByRole('button', { name: 'fork.vr.strip' });
    const wrist = screen.getByRole('button', { name: 'fork.vr.wrist' });
    expect(strip.getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.click(wrist);
    expect(useVrStore.getState().panel).toBe(true);
    expect(useVrStore.getState().on).toBe(false);
    expect(wrist.getAttribute('aria-pressed')).toBe('true');
  });

  it('turned on, says where SteamVR is beside the title', () => {
    const { rerender } = render(<VrHeadsetSection />);
    fireEvent.click(screen.getByRole('button', { name: 'fork.vr.strip' }));
    expect(useVrStore.getState().on).toBe(true);
    rerender(<VrHeadsetSection />);
    expect(screen.getByRole('status').textContent).toBe('fork.vr.linkWaiting');
    useVrStore.setState({ link: 'connected' });
    rerender(<VrHeadsetSection />);
    expect(screen.getByRole('status').textContent).toBe('fork.vr.linkConnected');
  });
});
