import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LanSharingSection } from './LanSharingSection';
import { useLanStore } from '../../stores/lanStore';
import { useNativeEngineStore } from '../../stores/nativeEngineStore';
import { NO_NATIVE_ENGINE } from '../../lib/native/nativeEngine';

// The catalog's keys stand for its strings.
vi.mock('react-i18next', async (importOriginal) => ({ ...(await importOriginal<typeof import('react-i18next')>()), useTranslation: () => ({ t: (key: string) => key }) }));

beforeEach(() => {
  useNativeEngineStore.setState({ status: NO_NATIVE_ENGINE, asked: true });
  useLanStore.setState({ enabled: true, status: { state: 'starting' }, clients: 0 });
});

describe('sharing: what is seen at a glance', () => {
  it('is a switch and nothing else while it is off', () => {
    useLanStore.setState({ enabled: false, status: { state: 'off' } });
    const { container } = render(<LanSharingSection />);
    expect(screen.getByRole('switch')).toBeTruthy();
    expect(container.querySelector('.kt-lan__card')).toBeNull();
    expect(container.querySelectorAll('p').length).toBe(0);
  });

  it('is its state, and the name and address another device finds it by; the rest is one disclosure away', () => {

    useLanStore.setState({ enabled: true, status: { state: 'on', port: 8790, addresses: ['192.168.1.20', '100.64.0.7'], name: 'DESK' }, clients: 2 });
    const { container } = render(<LanSharingSection />);
    expect(screen.getByText('fork.lan.onWithClients')).toBeTruthy();
    expect(screen.getByText('DESK')).toBeTruthy();
    expect(screen.getByText('192.168.1.20:8790')).toBeTruthy();
    // Its address on another network is with the options, not in the way.
    expect(screen.getByText('100.64.0.7:8790').closest('details')?.querySelector('summary')?.textContent).toBe('fork.lan.options');
    // What is lent, and the options: closed until asked for.
    const more = [...container.querySelectorAll('details')];
    expect(more.map((d) => d.querySelector('summary')?.textContent)).toEqual(['fork.lan.models', 'fork.lan.options']);
    expect(more.every((d) => !d.open)).toBe(true);
    // No paragraph of explanation is drawn: how it works is behind the question mark.
    expect(container.querySelectorAll('.kt-lan__card > p, .kt-lan__card > ul').length).toBe(0);
  });
});

describe('sharing: the models it lends', () => {
  it('claims no missing recognizer before the native engine has looked', () => {
    // The store is still on its first look at what is downloaded: a recognizer is, and it does not know it yet.
    useNativeEngineStore.setState({ asked: false });
    render(<LanSharingSection />);
    expect(screen.queryByText('fork.lan.noRecognizer')).toBeNull();
  });

  it('says so once it has looked and found none', () => {
    useNativeEngineStore.setState({ asked: true });
    render(<LanSharingSection />);
    expect(screen.getByText('fork.lan.noRecognizer')).toBeTruthy();
  });
});
