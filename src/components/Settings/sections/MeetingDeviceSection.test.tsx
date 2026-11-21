import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import MeetingDeviceSection from './MeetingDeviceSection';
import useAudioStore from '../../../stores/audioStore';
import { useRoutingStore } from '../../../stores/routingStore';

// The stores load the catalogs, which need the rest of the module: only the hook is replaced, and keys are shown.
vi.mock('react-i18next', async (original) => ({ ...(await original<typeof import('react-i18next')>()), useTranslation: () => ({ t: (key: string) => key }) }));
const electron = vi.hoisted(() => ({ is: true }));
vi.mock('../../../utils/environment', async (original) => ({ ...(await original<typeof import('../../../utils/environment')>()), isElectron: () => electron.is }));

afterEach(cleanup);

describe('the device the other side hears from', () => {
  beforeEach(() => {
    electron.is = true;
    useAudioStore.setState({ audioMonitorDevices: [{ deviceId: 'pair-12', label: 'Playback 1/2' }, { deviceId: 'pair-34', label: 'Playback 3/4' }] });
    useRoutingStore.setState({ meetingDevice: null });
  });

  it('is the virtual microphone until another is chosen, and that again when chosen back', () => {
    render(<MeetingDeviceSection />);
    const menu = screen.getByRole('combobox', { name: 'fork.voice.meetingDevice' }) as HTMLSelectElement;
    expect(menu.value).toBe('');
    fireEvent.change(menu, { target: { value: 'pair-34' } });
    expect(useRoutingStore.getState().meetingDevice).toBe('pair-34');
    fireEvent.change(menu, { target: { value: '' } });
    expect(useRoutingStore.getState().meetingDevice).toBeNull();
  });

  it('shows the automatic choice while the chosen device is not listed', () => {
    useRoutingStore.setState({ meetingDevice: 'unplugged' });
    render(<MeetingDeviceSection />);
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('');
    // What was chosen is kept for when the device is back.
    expect(useRoutingStore.getState().meetingDevice).toBe('unplugged');
  });

  it('is not there where there is no device to choose', () => {
    electron.is = false;
    const { container } = render(<MeetingDeviceSection />);
    expect(container.firstChild).toBeNull();
  });
});
