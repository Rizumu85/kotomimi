// Fork: the wizard's Kotomimi step — which starts it offers, and what each writes into the draft.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { initialDraft, type SetupAction, type SetupDraft } from '../setupDraft';

vi.mock('react-i18next', async (importOriginal) => ({ ...(await importOriginal<typeof import('react-i18next')>()), useTranslation: () => ({ t: (key: string) => key }) }));
const world = vi.hoisted(() => ({ canShare: true, sharing: false, settings: { asrVia: 'server' } as Record<string, unknown> }));
vi.mock('../../../lib/lan/discover', () => ({ canFindServers: () => world.canShare }));
vi.mock('../../../stores/lanStore', () => ({ useLanStore: (pick: (s: { enabled: boolean }) => unknown) => pick({ enabled: world.sharing }) }));
vi.mock('../../LanSharing/ServerFinder', () => ({
  ServerFinder: ({ onPick }: { onPick(server: unknown): void }) => (
    <div data-testid="finder">
      <button type="button" onClick={() => onPick({ address: '192.168.1.20:8790', kind: 'kotomimi', name: 'DESK', product: '', models: 2, needsKey: false, self: false })}>pick-open</button>
      <button type="button" onClick={() => onPick({ address: '192.168.1.21:8790', kind: 'kotomimi', name: 'MAC', product: '', models: 0, needsKey: true, self: false })}>pick-keyed</button>
    </div>
  ),
}));
vi.mock('../../providers/useAuthContext', () => ({ useAuthContext: () => ({ signedIn: false }) }));
const provider = {
  id: 'localai',
  check: vi.fn(),
  // The provider's own fields and reading, as far as the step uses them: an address, and an access key when the device asks for one.
  credentials: {
    keys: ['endpoint', 'serverKey'],
    fields: (s: { serverNeedsKey?: boolean }) => [{ key: 'endpoint', labelKey: 'e' }, ...(s.serverNeedsKey ? [{ key: 'serverKey', labelKey: 'k', secret: true }] : [])],
    read: (values: Record<string, string>) => (!values.endpoint?.trim() ? { missing: 'no address', code: 'server_address_missing' }
      : values.serverKey !== undefined && !values.serverKey.trim() ? { missing: 'no key', code: 'server_key_missing' }
      : { apiKey: values.serverKey ?? '', endpoint: `ws://${values.endpoint}/v1/realtime` }),
  },
};
vi.mock('../providerPaths', () => ({ wizardProvider: () => provider }));
vi.mock('../../../stores/providerStore', () => ({
  useProviderStore: Object.assign(
    (pick: (s: unknown) => unknown) => pick({ entries: { localai: { settings: world.settings, credentials: {}, pair: { source: 'en', target: 'ja' } } } }),
    { getState: () => ({ load: vi.fn() }) },
  ),
}));

import StepKotomimi from './StepKotomimi';

function draw(over: Partial<SetupDraft> = {}) {
  const dispatch = vi.fn<(action: SetupAction) => void>();
  const draft: SetupDraft = { ...initialDraft(), scenario: 'be-heard', providerPath: 'own-key', provider: 'localai' as SetupDraft['provider'], ...over };
  render(<StepKotomimi draft={draft} dispatch={dispatch} skipButton={() => null} />);
  const cards = () => screen.getAllByRole('radio') as HTMLInputElement[];
  return { dispatch, cards, picked: () => cards().find((c) => c.checked)?.value };
}

beforeEach(() => {
  provider.check.mockReset();
  world.canShare = true;
  world.sharing = false;
  world.settings = { asrVia: 'server' };
});

describe('the wizard\'s Kotomimi step', () => {
  it('offers three starts where this computer can share, and two where it cannot', () => {
    const { cards } = draw();
    expect(cards().map((c) => c.value)).toEqual(['server', 'device', 'share']);
    expect(screen.getByText('fork.wizard.share')).toBeTruthy();
  });

  it('offers no sharing where there is no main process to listen', () => {
    world.canShare = false;
    const { cards, picked } = draw({ credentialChoice: { setting: 'asrVia', value: 'share' } });
    expect(cards().map((c) => c.value)).toEqual(['server', 'device']);
    // A draft that says so all the same is this computer.
    expect(picked()).toBe('device');
  });

  it('carries the third start in the draft as the choice, asks for nothing, and says what Finish will do', () => {
    const first = draw();
    fireEvent.click(first.cards()[2]);
    expect(first.dispatch).toHaveBeenCalledWith({ type: 'setCredentialChoice', setting: 'asrVia', value: 'share' });
    first.dispatch.mockClear();
    document.body.replaceChildren();

    const chosen = draw({ credentialChoice: { setting: 'asrVia', value: 'share' } });
    expect(chosen.picked()).toBe('share');
    expect(screen.getByText('fork.wizard.shareNotice')).toBeTruthy();
    expect(screen.queryByTestId('finder')).toBeNull();
    // Nothing to enter: the step is complete as soon as it is chosen.
    expect(chosen.dispatch).toHaveBeenCalledWith({ type: 'credentialsValidated' });
  });

  it('shows a re-run what is saved: this computer, and sharing while it shares', () => {
    world.settings = { asrVia: 'device' };
    expect(draw().picked()).toBe('device');
    document.body.replaceChildren();
    world.sharing = true;
    expect(draw().picked()).toBe('share');
    document.body.replaceChildren();
    // Another device does the work: sharing left on from before does not make this the sharing computer's start.
    world.settings = { asrVia: 'server' };
    expect(draw().picked()).toBe('server');
  });

  it('says why a device did not answer in the words the settings use, not in the check\'s English', async () => {
    const { CheckError } = await import('../../../lib/provider/checkError');
    provider.check.mockRejectedValueOnce(new CheckError('The other device could not be reached (192.168.1.20:8790): Failed to fetch', 'server_unreachable', { address: '192.168.1.20:8790' }));
    draw();
    fireEvent.click(screen.getByText('pick-open'));
    // The catalog's key stands for its sentence: the notice's own, not "connection failed: <English>".
    await waitFor(() => expect(screen.getByText('providers.localai.serverUnreachable')).toBeTruthy());
    expect(screen.queryByText('fork.wizard.serverUnreachable')).toBeNull();
  });

  it('asks for the access key of a device that wants one, there in the step, before trying it', () => {
    const { dispatch } = draw();
    fireEvent.click(screen.getByText('pick-keyed'));
    expect(dispatch).toHaveBeenCalledWith({ type: 'setCredential', key: 'endpoint', value: '192.168.1.21:8790' });
    // Tried without its key it could only refuse: the field comes first, and says why.
    expect(provider.check).not.toHaveBeenCalled();
    expect(screen.getByLabelText('providers.localai.serverKey')).toBeTruthy();
    expect(screen.getByText('fork.wizard.keyNeeded')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('providers.localai.serverKey'), { target: { value: 's3cret' } });
    expect(dispatch).toHaveBeenCalledWith({ type: 'setCredential', key: 'serverKey', value: 's3cret' });
  });

  it('tries the device with the key typed, and opens the field when a device it was not told of asks for one', async () => {
    provider.check.mockResolvedValueOnce({ ok: true, models: [] });
    draw({ credentials: { endpoint: '192.168.1.21:8790', serverKey: 's3cret' } });
    fireEvent.click(screen.getByText('fork.wizard.tryServer'));
    await waitFor(() => expect(provider.check).toHaveBeenCalled());
    expect(provider.check.mock.calls[0][0]).toMatchObject({ apiKey: 's3cret' });
    expect(provider.check.mock.calls[0][1]).toMatchObject({ serverNeedsKey: true });
    document.body.replaceChildren();
    provider.check.mockReset();

    // A typed address whose device turns out to want a key.
    provider.check.mockResolvedValueOnce({ ok: false, code: 'server_key_needed', reason: 'The server refused the access key (HTTP 401).' });
    draw({ credentials: { endpoint: '192.168.1.22:8790' } });
    expect(screen.queryByLabelText('providers.localai.serverKey')).toBeNull();
    fireEvent.click(screen.getByText('fork.wizard.tryServer'));
    await waitFor(() => expect(screen.getByLabelText('providers.localai.serverKey')).toBeTruthy());
    expect(screen.getByText('fork.wizard.keyNeeded')).toBeTruthy();
  });
});
