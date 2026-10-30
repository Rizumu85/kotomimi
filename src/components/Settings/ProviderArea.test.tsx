import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const { stored, setSetting } = vi.hoisted(() => {
  const stored = new Map<string, unknown>();
  return {
    stored,
    setSetting: vi.fn(async (key: string, value: unknown) => {
      stored.set(key, value);
      return { success: true };
    }),
  };
});
vi.mock('../../services/ServiceFactory', () => ({
  ServiceFactory: {
    getSettingsService: () => ({
      getSetting: async (key: string, def: unknown) => (stored.has(key) ? stored.get(key) : def),
      setSetting,
    }),
  },
}));
vi.mock('../../lib/auth/hooks', () => ({
  useAuth: () => ({ isSignedIn: false, getToken: async () => null }),
}));
vi.mock('../../lib/analytics', () => ({ useAnalytics: () => ({ trackEvent: vi.fn() }) }));
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key) }) };
});

import { FAKE_DEFAULTS } from '../../providers/fake/settings';
import { LOCAL_INFERENCE_DEFAULTS } from '../../providers/localInference/settings';
import useAudioStore from '../../stores/audioStore';
import { useProviderStore } from '../../stores/providerStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useTurnModeStore } from '../../stores/turnModeStore';
import { SessionSettingsGeneral, SessionSettingsProvider } from './ProviderArea';

const entry = () => ({ settings: { ...LOCAL_INFERENCE_DEFAULTS }, credentials: {}, pair: { source: 'ja', target: 'en' } });

// General keeps language and output preferences together.
const SECTION_IDS = ['languages-section', 'output-section'];

beforeEach(() => {
  stored.clear();
  setSetting.mockClear();
  useProviderStore.setState({ selected: 'localInference', entries: { localInference: entry() }, readiness: {}, legs: ['speaker'] });
  useAudioStore.setState({ mode: 'speaker' } as Partial<ReturnType<typeof useAudioStore.getState>>);
  useSettingsStore.setState({ textOnly: false, engineSlotTarget: null } as Partial<ReturnType<typeof useSettingsStore.getState>>);
  useTurnModeStore.setState({ turnMode: 'auto' });
});

describe('SessionSettingsGeneral', () => {
  it('renders the general controls in order without duplicating the Provider category', () => {
    const { container } = render(<SessionSettingsGeneral locked={false} />);

    const elements = SECTION_IDS.map((id) => container.querySelector(`#${id}`));
    elements.forEach((el, i) => expect(el, `#${SECTION_IDS[i]} is present`).toBeTruthy());
    for (let i = 0; i < elements.length - 1; i++) {
      // eslint-disable-next-line no-bitwise
      expect(elements[i]!.compareDocumentPosition(elements[i + 1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(container.querySelector('#provider-section')).toBeNull();

    const labels = [...container.querySelectorAll('#languages-section .language-select-group label')].map((el) => el.textContent);
    expect(labels).toEqual(['I speak', 'they hear']);
  });

  // The owner, 2026-10-01: hidden, with segmentation kept Off.
  it('does not render the sentence segmentation section', () => {
    const { container } = render(<SessionSettingsGeneral locked={false} />);
    expect(container.querySelector('#sentence-segmentation-section')).toBeNull();
  });


  it('locked disables the language pair', () => {
    render(<SessionSettingsGeneral locked={true} />);
    for (const select of screen.getAllByRole('combobox')) expect(select).toBeDisabled();
  });


});

// Fork: on the Advanced layout the provider is drawn on its own page alone.
describe('General category boundaries', () => {
  it('draws no provider block at all: the Provider page is where it is chosen and set up', () => {
    const { container } = render(<SessionSettingsGeneral locked={false} />);
    expect(container.querySelector('#provider-section')).toBeNull();
    expect(container.querySelector('.provider-select')).toBeNull();
    expect(container.querySelector('.kt-provider-pointer')).toBeNull();
    // The rest of the page is as before.
    for (const id of ['languages-section', 'output-section']) expect(container.querySelector(`#${id}`), id).toBeTruthy();
  });

});

describe('SessionSettingsProvider', () => {
  it("renders the picker, then .engine-surface, then LocalInferenceSettingsView's Speech Speed control — today's order", () => {
    const { container } = render(<SessionSettingsProvider locked={false} />);
    const select = container.querySelector('select.provider-select');
    const surface = container.querySelector('.engine-surface');
    const speed = screen.getByText('Speech Speed');
    expect(select).toBeTruthy();
    expect(surface).toBeTruthy();
    // eslint-disable-next-line no-bitwise
    expect(select!.compareDocumentPosition(surface!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // eslint-disable-next-line no-bitwise
    expect(surface!.compareDocumentPosition(speed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps speech-detection controls out of the Provider category', () => {
    const { container } = render(<SessionSettingsProvider locked={false} />);
    expect(container.querySelector('#turn-detection-tuning-section')).toBeNull();
  });

  it('a provider without TurnDetection renders no block', () => {
    useProviderStore.setState({ selected: 'fake', entries: { fake: { settings: { ...FAKE_DEFAULTS }, credentials: {}, pair: { source: 'auto', target: 'en' } } } });
    const { container } = render(<SessionSettingsProvider locked={false} />);
    // The fake's own settings did render: this is the fake's tab, not an empty one.
    expect(screen.getByText('Fake provider')).toBeTruthy();
    expect(container.querySelector('#turn-detection-tuning-section')).toBeNull();
  });

  it('a set engineSlotTarget reaches the engine as its initialSlot and is cleared once consumed', () => {
    useSettingsStore.setState({ engineSlotTarget: { dir: 'ja→en', stage: 'asr' } });
    const { container } = render(<SessionSettingsProvider locked={false} />);
    // The engine's own flash proves the slot reached it as `initialSlot`.
    expect(container.querySelector('[data-slot="ja→en:asr"].highlight')).toBeTruthy();
    expect(useSettingsStore.getState().engineSlotTarget).toBeNull();
  });
});
