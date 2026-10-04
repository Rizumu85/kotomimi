// Fork: the wizard's Kotomimi step — which starts it offers, and what each writes into the draft.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { initialDraft, type SetupAction, type SetupDraft } from '../setupDraft';

vi.mock('react-i18next', async (importOriginal) => ({ ...(await importOriginal<typeof import('react-i18next')>()), useTranslation: () => ({ t: (key: string) => key }) }));
const world = vi.hoisted(() => ({ canShare: true, sharing: false, settings: { asrVia: 'server' } as Record<string, unknown> }));
vi.mock('../../../lib/lan/discover', () => ({ canFindServers: () => world.canShare }));
vi.mock('../../../stores/lanStore', () => ({ useLanStore: (pick: (s: { enabled: boolean }) => unknown) => pick({ enabled: world.sharing }) }));
vi.mock('../../LanSharing/ServerFinder', () => ({ ServerFinder: () => <div data-testid="finder" /> }));
vi.mock('../../providers/useAuthContext', () => ({ useAuthContext: () => ({ signedIn: false }) }));
const provider = { id: 'localai', check: vi.fn(), credentials: { keys: ['endpoint'], fields: () => [] } };
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
});
