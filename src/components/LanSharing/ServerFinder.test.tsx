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

  it('keeps a phone that asks for its access key a phone, though nothing it lends is seen yet', () => {
    expect(foundServers([{ address: '192.168.4.28:8792', kind: 'phone', name: 'F22', models: 0, needsKey: true }])).toEqual([
      { address: '192.168.4.28:8792', kind: 'phone', name: 'F22', product: '', models: 0, needsKey: true, self: false },
    ]);
    expect(foundServers([{ address: '192.168.4.28:8792', kind: 'phone', name: 'F22', models: 0, needsKey: false }])[0].kind).toBe('server');
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
    expect(rows[0]).toContain('fork.find.kindComputer');
    // Where it is, without the port that says nothing to a person.
    expect(rows[0]).toContain('192.168.4.29');
    expect(rows[0]).not.toContain(':8790');
    expect(rows[0]).toContain('fork.find.models {"count":3}');
    // No name: the address stands for it.
    expect(rows[1]).toContain('192.168.4.105');
    expect(rows[1]).toContain('fork.find.kindServer');
    expect(rows[2]).toContain('fork.find.needsKey');
  });

  describe('a phone that lends its recognition engine', () => {
    const phone: FoundServer = { address: '192.168.4.28:8792', kind: 'phone', name: '朋友的手机', product: '', models: 1, needsKey: false, self: false, model: 'qwen3-asr-0.6b-q8' };

    it('is listed where recognition can be set to it, as a phone, with how many models it lends', async () => {
      const onPick = vi.fn();
      render(<ServerFinder auto phones onPick={onPick} find={async () => [desk, phone]} />);
      await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(2));
      const row = screen.getAllByRole('listitem')[1];
      expect(row.textContent).toContain('朋友的手机');
      expect(row.textContent).toContain('fork.find.kindPhone');
      expect(row.textContent).toContain('fork.find.models {"count":1}');
      fireEvent.click(screen.getByRole('button', { name: 'fork.find.use {"name":"朋友的手机"}' }));
      expect(onPick).toHaveBeenCalledWith(phone);
    });

    it('shows the stages each device runs, by their cards\' icons, in place of a check', async () => {
      const uses = (server: FoundServer) => (server === phone ? ['asr' as const] : server === desk ? ['translate' as const, 'coach' as const] : []);
      render(<ServerFinder auto phones uses={uses} onPick={() => {}} find={async () => [desk, phone]} />);
      await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(2));
      const used = (name: string) => screen.getByRole('button', { name: `fork.find.use {"name":"${name}"}` });
      expect(used('朋友的手机').getAttribute('aria-pressed')).toBe('true');
      expect(used('DESK').getAttribute('aria-pressed')).toBe('true');
      expect(used('朋友的手机').querySelectorAll('.kt-find__uses svg')).toHaveLength(1);
      expect(used('DESK').querySelectorAll('.kt-find__uses svg')).toHaveLength(2);
      expect(used('DESK').querySelector('.kt-find__check')).toBeNull();
    });

    it('is not listed where it could not be used: the wizard asks for a device with a whole pipeline', async () => {
      render(<ServerFinder auto onPick={() => {}} find={async () => [desk, phone]} />);
      await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(1));
    });

    it('is held to its shape on the way from the main process', () => {
      expect(foundServers([phone])).toEqual([phone]);
      // A phone that names no model is nothing recognition can be set to: it is read as any server.
      expect(foundServers([{ ...phone, model: undefined }])[0].kind).toBe('server');
    });
  });

  describe('a phone that lends text models too (0.8.0 on)', () => {
    const text = [{ id: 'index-translate-2b', kind: 'translate' as const, name: 'Index-Translate 2B', loaded: false }, { id: 'gemma-4-e2b', kind: 'coach' as const, name: 'Gemma 4 E2B', loaded: true }];
    const lending: FoundServer = { address: '192.168.4.28:8792', kind: 'phone', name: '朋友的手机', product: '', models: 3, needsKey: false, self: false, model: 'qwen3-asr-0.6b-q8', text };
    const textOnly: FoundServer = { address: '192.168.4.30:8792', kind: 'phone', name: 'F22', product: '', models: 1, needsKey: false, self: false, text: text.slice(0, 1) };

    it('is kept with what it lends, and so is one that lends text models alone', () => {
      expect(foundServers([lending, textOnly])).toEqual([lending, textOnly]);
      // What is not a text model of a phone's is left out of it; a phone with nothing left is any server.
      expect(foundServers([{ ...textOnly, text: [{ id: 'x', kind: 'asr' }] }])[0]).toEqual({ address: '192.168.4.30:8792', kind: 'server', name: 'F22', product: '', models: 1, needsKey: false, self: false });
    });

    it('is listed as a phone with how many models it lends: its recognizer and its text models', async () => {
      render(<ServerFinder auto phones onPick={() => {}} find={async () => [lending, textOnly]} />);
      await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(2));
      const [both, alone] = screen.getAllByRole('listitem').map((row) => row.textContent ?? '');
      expect(both).toContain('fork.find.kindPhone');
      expect(both).toContain('fork.find.models {"count":3}');
      expect(alone).toContain('192.168.4.30');
      expect(alone).toContain('fork.find.models {"count":1}');
    });

    it('is called a tablet where it says it is one (the iPad app), even lending its recognizer alone', async () => {
      const ipad: FoundServer = { address: '192.168.4.31:8792', kind: 'phone', name: 'iPad', product: '', models: 1, needsKey: false, self: false, model: 'apple-speech', tablet: true };
      expect(foundServers([ipad])).toEqual([ipad]);
      // Only a node is one.
      expect(foundServers([{ ...ipad, kind: 'server', model: undefined }])[0]).not.toHaveProperty('tablet');
      render(<ServerFinder auto phones onPick={() => {}} find={async () => [ipad]} />);
      await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(1));
      expect(screen.getByRole('listitem').textContent).toContain('fork.find.kindTablet');
    });

    it('is marked as in use by whichever stage asks it', async () => {
      render(<ServerFinder auto phones uses={(server) => (server === textOnly ? ['translate'] : [])} onPick={() => {}} find={async () => [lending, textOnly]} />);
      await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(2));
      expect(screen.getByRole('button', { name: 'fork.find.use {"name":"F22"}' }).getAttribute('aria-pressed')).toBe('true');
      expect(screen.getByRole('button', { name: 'fork.find.use {"name":"朋友的手机"}' }).getAttribute('aria-pressed')).toBe('false');
    });
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

  it('stands under a card\'s own heading, searching again an icon beside it', async () => {
    const find = vi.fn(async () => [desk]);
    render(<ServerFinder auto heading={<h4>card</h4>} onPick={() => {}} find={find} />);
    await screen.findByRole('listitem');
    expect(screen.queryByText('fork.find.title')).toBeNull();
    const again = screen.getByRole('button', { name: 'fork.find.again' });
    expect(again.textContent).toBe('');
    fireEvent.click(again);
    await waitFor(() => expect(find).toHaveBeenCalledTimes(2));
  });

  it('calls a server with no name by what it is, when that is known', async () => {
    render(<ServerFinder auto value="" onPick={() => {}} find={async () => [{ ...mac, product: 'LocalAI' }]} />);
    expect((await screen.findByRole('button', { name: 'fork.find.use {"name":"LocalAI"}' })).textContent).toContain('192.168.4.105');
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
