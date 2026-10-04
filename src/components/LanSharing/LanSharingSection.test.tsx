import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LanSharingSection } from './LanSharingSection';
import { useLanStore } from '../../stores/lanStore';
import { useLocalServerStore } from '../../stores/localServerStore';
import { useModelStore } from '../../stores/modelStore';
import { NO_LOCAL_SERVER } from '../../lib/lan/localServer';

// The catalog's keys stand for its strings.
vi.mock('react-i18next', async (importOriginal) => ({ ...(await importOriginal<typeof import('react-i18next')>()), useTranslation: () => ({ t: (key: string) => key }) }));

beforeEach(() => {
  useLocalServerStore.setState({ status: NO_LOCAL_SERVER, refresh: vi.fn(async () => {}) });
  useLanStore.setState({ enabled: true, status: { state: 'starting' }, clients: 0 });
});

describe('sharing: the models it lends', () => {
  it('claims no missing recognizer before the model store has looked', () => {
    // The store is still on its first look at what is downloaded: a recognizer is, and it does not know it yet.
    useModelStore.setState({ initialized: false, modelStatuses: {}, webgpuAvailable: false });
    render(<LanSharingSection />);
    expect(screen.queryByText('fork.lan.noRecognizer')).toBeNull();
  });

  it('says so once it has looked and found none', () => {
    useModelStore.setState({ initialized: true, modelStatuses: {}, webgpuAvailable: true });
    render(<LanSharingSection />);
    expect(screen.getByText('fork.lan.noRecognizer')).toBeTruthy();
  });
});
