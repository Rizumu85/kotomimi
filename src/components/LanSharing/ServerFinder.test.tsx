import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ServerFinder } from './ServerFinder';
import { foundServers, plainAddress, type FoundServer } from '../../lib/lan/discover';

// The catalog's keys stand for its strings, with what they are given.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key) }),
}));

const desk: FoundServer = { address: '192.168.4.29:8790', kind: 'kotomimi', name: 'DESK', product: '', models: 3, needsKey: false, self: false };
const mac: FoundServer = { address: '192.168.4.105:8080', kind: 'server', name: '', product: '', models: 10, needsKey: false, self: false };
const locked: FoundServer = { address: '192.168.4.40:8790', kind: 'kotomimi', name: 'LAPTOP', product: '', models: 0, needsKey: true, self: false };

describe('what the search found, held to its shape', () => {
  it('keeps servers, and drops what is none', () => {
    expect(foundServers([desk, null, { address: 'evil.example/x' }, { address: '10.0.0.2:8080', kind: 'other', models: -3, name: 7 }])).toEqual([
      desk,
      { address: '10.0.0.2:8080', kind: 'server', name: '', product: '', models: 0, needsKey: false, self: false },
    ]);
    expect(foundServers('no')).toEqual([]);
  });

  it('reads a typed address as the host and port it names', () => {
    expect(plainAddress(' http://192.168.4.29:8790/v1/ ')).toBe('192.168.4.29:8790');
    expect(plainAddress('192.168.4.29:8790')).toBe('192.168.4.29:8790');
  });
});

describe('the devices found on the network', () => {
  it('searches as soon as it is shown when asked to, and lists each device by its name or its address', async () => {
    const find = vi.fn(async () => [desk, mac, locked]);
    render(<ServerFinder auto value="" onPick={() => {}} find={find} />);
    expect(screen.getByRole('status').textContent).toContain('fork.find.searching');
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(3));
    expect(find).toHaveBeenCalledTimes(1);
    const rows = screen.getAllByRole('listitem').map((row) => row.textContent);
    expect(rows[0]).toContain('DESK');
    expect(rows[0]).toContain('fork.find.kindKotomimi');
    expect(rows[0]).toContain('192.168.4.29:8790');
    expect(rows[0]).toContain('fork.find.models {"count":3}');
    // No name: the address stands for it.
    expect(rows[1]).toContain('192.168.4.105');
    expect(rows[1]).toContain('fork.find.kindServer');
    expect(rows[2]).toContain('fork.find.needsKey');
  });

  it('hands over the device that is clicked, and marks the one whose address is in the field', async () => {
    const onPick = vi.fn();
    render(<ServerFinder auto value="http://192.168.4.105:8080/v1" onPick={onPick} find={async () => [desk, mac]} />);
    const rows = await screen.findAllByRole('button', { name: /fork\.find\.use/ });
    expect(rows.map((row) => row.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
    fireEvent.click(rows[0]);
    expect(onPick).toHaveBeenCalledWith(desk);
  });

  it('waits for its button when not asked to search by itself, and can search again', async () => {
    const find = vi.fn(async () => [desk]);
    render(<ServerFinder value="" onPick={() => {}} find={find} />);
    expect(find).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'fork.find.search' }));
    await screen.findByRole('listitem');
    fireEvent.click(screen.getByRole('button', { name: 'fork.find.again' }));
    await waitFor(() => expect(find).toHaveBeenCalledTimes(2));
  });

  it('calls a server with no name by what it is, when that is known', async () => {
    render(<ServerFinder auto value="" onPick={() => {}} find={async () => [{ ...mac, product: 'LocalAI' }]} />);
    expect((await screen.findByRole('button', { name: 'fork.find.use {"name":"LocalAI"}' })).textContent).toContain('192.168.4.105:8080');
  });

  it('says what to check when nothing is found', async () => {
    render(<ServerFinder auto value="" onPick={() => {}} find={async () => []} />);
    expect(await screen.findByText('fork.find.none')).toBeTruthy();
  });

  it('draws nothing where there is no main process to search', () => {
    const { container } = render(<ServerFinder auto value="" onPick={() => {}} />);
    expect(container.innerHTML).toBe('');
  });
});
