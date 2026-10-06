// Fork: the wizard as Kotomimi shows it — four steps, with "which service" and "which device" answered instead of
// asked (`setupDraft.ts` `KOTOMIMI_HIDDEN_STEPS`). The six-step walk is `SetupWizard.test.tsx`'s.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// The desktop app: the one platform the Kotomimi provider is offered on.
vi.mock('../../utils/environment', async (orig) => ({
  ...(await orig<typeof import('../../utils/environment')>()),
  getEnvironment: () => 'electron',
  isElectron: () => true,
  isExtension: () => false,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, d?: string | object, opts?: Record<string, unknown>) => {
      const params = (typeof d === 'object' && d !== null ? d : opts) as Record<string, unknown> | undefined;
      const text = typeof d === 'string' ? d : k;
      return params ? text.replace(/{{(\w+)}}/g, (m, name) => (params[name] === undefined ? m : String(params[name]))) : text;
    },
    i18n: { language: 'en' },
  }),
}));
vi.mock('../../locales', () => ({ changeLanguageWithLoad: vi.fn(async (l: string) => l) }));
vi.mock('../../lib/auth/hooks', () => ({ useAuth: () => ({ isSignedIn: false, getToken: async () => null }), useUser: () => ({ isLoaded: true, user: null }) }));
vi.mock('../../lib/analytics', () => ({ useAnalytics: () => ({ trackEvent: vi.fn() }) }));
const applied: unknown[] = [];
vi.mock('./useApplySetup', () => ({ useApplySetup: () => async (draft: unknown) => { applied.push(draft); } }));
vi.mock('../../stores/settingsStore', () => ({
  useUILanguage: () => 'en',
  useSetUILanguage: () => vi.fn(async () => {}),
  useSetAuthOverlay: () => vi.fn(),
  useAuthOverlay: () => null,
  useProvider: () => 'localai',
}));
vi.mock('../../stores/setupStore', () => ({ useSetupRecord: () => null, SetupPersistError: class SetupPersistError extends Error {} }));
const startTour = vi.fn();
vi.mock('../Tour/TourProvider', () => ({ useTour: () => ({ start: startTour }) }));

import SetupWizard from './SetupWizard';
import { useProviderStore } from '../../stores/providerStore';

const next = () => fireEvent.click(screen.getByRole('button', { name: 'Next' }));

beforeEach(() => {
  cleanup();
  applied.length = 0;
  startTour.mockClear();
  useProviderStore.setState({ entries: {}, intent: undefined, readiness: {} });
});

describe('the wizard, as Kotomimi shows it', () => {
  it('asks neither which service nor which device: four steps, and Finish sets Kotomimi up on this computer', async () => {
    render(<SetupWizard variant="first-run" />);
    expect(screen.getByText('Step 1 of 4')).toBeTruthy();
    next();
    expect(screen.getByText('Step 2 of 4')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('radio')[0]);
    next();
    // Straight to the languages: neither hidden step is drawn.
    expect(screen.getByText('Step 3 of 4')).toBeTruthy();
    expect(screen.queryByText('fork.wizard.pathTitle')).toBeNull();
    expect(screen.queryByText('fork.wizard.title')).toBeNull();
    // The pair is whose language each one is, as Settings name it — not what a run does with it — and no line under it.
    expect(screen.getByLabelText('My language')).toBeTruthy();
    expect(screen.getByLabelText('Their language')).toBeTruthy();
    expect(document.querySelector('.setup-mirror')).toBeNull();
    expect([...(screen.getByLabelText('My language') as HTMLSelectElement).options].map((o) => o.value)).not.toContain('auto');
    // And Back lands on the scenario, not on a hidden step.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByText('Step 2 of 4')).toBeTruthy();
    next();
    await waitFor(() => expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(false));
    next();
    expect(screen.getByText('Step 4 of 4')).toBeTruthy();
    expect(screen.getByText(/^My language .+ · Their language .+$/)).toBeTruthy();
    expect(document.querySelector('.setup-summary__mirror')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }));
    await waitFor(() => expect(applied).toHaveLength(1));
    expect(applied[0]).toMatchObject({ providerPath: 'own-key', provider: 'localai', credentialChoice: { setting: 'asrVia', value: 'device' }, credentialsPending: false });
    // The tour is told that this computer has models to download.
    expect(startTour).toHaveBeenCalledTimes(1);
    expect(startTour.mock.calls[0][0]).toMatchObject({ deviceStages: true });
  });
});
