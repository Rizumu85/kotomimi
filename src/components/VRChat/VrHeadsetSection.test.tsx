import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../app/vrchatHandle', () => ({ vrchatOffered: () => true }));
vi.mock('../../services/persistSetting', () => ({ persistSetting: async () => {} }));
vi.mock('react-i18next', async (importOriginal) => ({ ...(await importOriginal<typeof import('react-i18next')>()), useTranslation: () => ({ t: (key: string) => key }) }));

import { useVrStore } from '../../stores/vrStore';
import { VrHeadsetSection } from './VrHeadsetSection';

beforeEach(() => {
  useVrStore.setState({ on: false, hand: 'left', link: 'off', wristShown: false });
});

describe('VrHeadsetSection — the SteamVR overlay, a card of its own (fork)', () => {
  it('is one switch while off: no state, no wrist', () => {
    render(<VrHeadsetSection />);
    expect(screen.getByText('fork.vr.title')).toBeTruthy();
    expect(screen.getByText('fork.vr.setting')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('group', { name: 'fork.vr.hand' })).toBeNull();
  });

  it('turned on, says where SteamVR is beside the title and offers the wrist', () => {
    const { rerender } = render(<VrHeadsetSection />);
    fireEvent.click(screen.getByText('fork.vr.setting'));
    expect(useVrStore.getState().on).toBe(true);
    rerender(<VrHeadsetSection />);
    expect(screen.getByRole('status').textContent).toBe('fork.vr.linkWaiting');
    useVrStore.setState({ link: 'connected' });
    rerender(<VrHeadsetSection />);
    expect(screen.getByRole('status').textContent).toBe('fork.vr.linkConnected');
    fireEvent.click(screen.getByText('fork.vr.right'));
    expect(useVrStore.getState().hand).toBe('right');
  });
});
