import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LocalServerCard } from './LocalServerCard';
import { ServingBadge } from './ServingBadge';
import { localServerStatus, NO_LOCAL_SERVER, type LocalServerStatus } from '../../lib/lan/localServer';
import { useLocalServerStore } from '../../stores/localServerStore';
import { useLanStore } from '../../stores/lanStore';

// The catalog's keys stand for its strings, with what they are given.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key) }),
}));
vi.mock('../../utils/openExternalUrl', () => ({ openExternalUrl: vi.fn() }));

const installed: LocalServerStatus = { installed: true, state: 'stopped', port: 8080, models: [], tail: '' };
const start = vi.fn(async () => {});
const stop = vi.fn(async () => {});
const refresh = vi.fn(async () => {});
const setAutoStart = vi.fn();

function show(status: LocalServerStatus, autoStart = false) {
  useLocalServerStore.setState({ status, autoStart, start, stop, refresh, setAutoStart });
  return render(<LocalServerCard />);
}

beforeEach(() => {
  for (const fn of [start, stop, refresh, setAutoStart]) fn.mockClear();
  useLanStore.setState({ status: { state: 'off' }, clients: 0 });
});

describe('what the main process says of the LocalAI, held to its shape', () => {
  it('keeps a status, and takes anything else for none installed', () => {
    expect(localServerStatus({ installed: true, state: 'running', port: 8085, models: ['a', 7, 'b'], tail: '' })).toEqual({ installed: true, state: 'running', port: 8085, models: ['a', 'b'], tail: '' });
    for (const bad of [null, 'running', {}, { state: 'exploded' }]) expect(localServerStatus(bad)).toEqual(NO_LOCAL_SERVER);
    expect(localServerStatus({ state: 'stopped', port: 99999 }).port).toBe(8080);
  });
});

describe('the LocalAI of this computer, in the settings', () => {
  it('is not drawn where none is installed', () => {
    const { container } = show(NO_LOCAL_SERVER);
    expect(container.innerHTML).toBe('');
  });

  it('asks again whether it is up each time it is shown', () => {
    show(installed);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('offers Start while it is not running, and whether to start it with the app', async () => {
    show(installed);
    expect(screen.getByRole('status').textContent).toBe('fork.server.stopped');
    fireEvent.click(screen.getByRole('button', { name: 'fork.server.start' }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('switch'));
    expect(setAutoStart).toHaveBeenCalledWith(true);
  });

  it('shows what it serves while it runs, and offers Stop', async () => {
    show({ ...installed, state: 'running', models: Array.from({ length: 10 }, (_, i) => `model-${i}`) });
    expect(screen.getByRole('status').textContent).toBe('fork.server.running {"count":10}');
    expect(screen.getByText('model-0')).toBeTruthy();
    expect(screen.getByText('fork.server.more {"count":2}')).toBeTruthy();
    expect(screen.queryByText('model-9')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'fork.server.stop' }));
    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
  });

  it('leaves alone one that something else started: no button, and why', () => {
    show({ ...installed, state: 'external', models: ['a'] });
    expect(screen.getByRole('status').textContent).toBe('fork.server.external {"count":1}');
    expect(screen.getByText('fork.server.externalNote')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'fork.server.stop' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'fork.server.start' })).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('shows its last words when it would not start, and lets it be tried again', () => {
    show({ ...installed, state: 'failed', tail: 'fatal: port in use' });
    expect(screen.getByRole('status').textContent).toBe('fork.server.failed');
    expect(screen.getByText('fatal: port in use')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'fork.server.start' })).toBeTruthy();
  });
});

describe('the title bar\'s mark of a computer that is lending its models', () => {
  it('is absent while nothing is lent', () => {
    useLocalServerStore.setState({ status: installed });
    const { container } = render(<ServingBadge />);
    expect(container.innerHTML).toBe('');
  });

  it('shows while the app shares its models, with how many are in use', () => {
    useLocalServerStore.setState({ status: installed });
    useLanStore.setState({ status: { state: 'on', port: 8790, addresses: [], name: 'DESK' }, clients: 0 });
    const { rerender } = render(<ServingBadge />);
    expect(screen.getByRole('status').textContent).toBe('fork.lan.serving');
    useLanStore.setState({ clients: 2 });
    rerender(<ServingBadge />);
    expect(screen.getByRole('status').textContent).toBe('fork.lan.servingClients {"count":2}');
  });

  it('shows while a LocalAI this app started is up, and not for one it did not start', () => {
    useLocalServerStore.setState({ status: { ...installed, state: 'external' } });
    const { container, rerender } = render(<ServingBadge />);
    expect(container.innerHTML).toBe('');
    useLocalServerStore.setState({ status: { ...installed, state: 'running' } });
    rerender(<ServingBadge />);
    expect(screen.getByRole('status').textContent).toBe('fork.lan.serving');
  });
});
