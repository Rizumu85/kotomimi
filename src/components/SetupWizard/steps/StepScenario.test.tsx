// Fork: the uses offered where the provider is not chosen in the wizard.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../../../utils/environment', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../utils/environment')>()), getEnvironment: () => 'electron' }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string, fallback?: string) => (typeof fallback === 'string' ? fallback : key) }),
}));

import { initialDraft, KOTOMIMI_HIDDEN_STEPS, setHiddenSetupSteps } from '../setupDraft';
import StepScenario from './StepScenario';

afterEach(() => setHiddenSetupSteps(KOTOMIMI_HIDDEN_STEPS));

const offered = () => screen.getAllByRole('radio').map((r) => (r as HTMLInputElement).value);

describe('StepScenario (fork)', () => {
  it('offers only the uses Kotomimi serves while the provider is not chosen here: none that speaks', () => {
    render(<StepScenario draft={initialDraft()} dispatch={vi.fn()} />);
    expect(offered()).toEqual(['understand-others', 'subtitle-myself', 'two-way-text']);
  });

  it('offers every use where the provider is chosen in the wizard', () => {
    setHiddenSetupSteps([]);
    render(<StepScenario draft={initialDraft()} dispatch={vi.fn()} />);
    expect(offered()).toEqual(['understand-others', 'be-heard', 'subtitle-myself', 'two-way-voice', 'two-way-text']);
  });
});
