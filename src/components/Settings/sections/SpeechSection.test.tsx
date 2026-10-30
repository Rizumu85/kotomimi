import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

const { trackEvent } = vi.hoisted(() => ({ trackEvent: vi.fn() }));
vi.mock('../../../lib/analytics', () => ({ useAnalytics: () => ({ trackEvent }) }));
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key) }) };
});
// Captured instead of rendered: floating-ui's Tooltip opens only on hover, so
// asserting its `content` prop directly is the simple way to check the
// forced-by-mode tooltip (the brief's own key, since our i18n mock above
// returns the raw key for an object-shaped fallback).
const tooltipContents: unknown[] = [];
vi.mock('../../Tooltip/Tooltip', () => ({
  default: ({ content }: { content: unknown }) => {
    tooltipContents.push(content);
    return null;
  },
}));
// LocalInference is the real one — its `TurnDetection` is what the Speech
// section draws under Auto; the fake has none.
vi.mock('../../../providers/registry', async () => {
  const { fakeProvider } = await import('../../../providers/fake/provider');
  const { localInferenceProvider } = await import('../../../providers/localInference/provider');
  return {
    presentProviders: () => [
      localInferenceProvider,
      fakeProvider,
      { ...fakeProvider, id: 'always-provider', speech: 'always' as const },
      { ...fakeProvider, id: 'never-provider', speech: 'never' as const },
    ],
  };
});
// The speaker direction's resolved ASR decides LocalInference's VAD knobs:
// `resolve` (set on the model store below) answers 'asr-model', and this is
// its manifest entry.
const asr = vi.hoisted(() => ({ entry: undefined as { type?: string; asrWorkerType?: string } | undefined }));
vi.mock('../../../lib/local-inference/modelManifest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/local-inference/modelManifest')>();
  return { ...actual, getManifestEntry: (id: string) => (id === 'asr-model' ? asr.entry : actual.getManifestEntry(id)) };
});

import { FAKE_DEFAULTS } from '../../../providers/fake/settings';
import { LOCAL_INFERENCE_DEFAULTS } from '../../../providers/localInference/settings';
import useAudioStore from '../../../stores/audioStore';
import { useModelStore } from '../../../stores/modelStore';
import { useProviderStore } from '../../../stores/providerStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useTurnModeStore } from '../../../stores/turnModeStore';
import { OutputToggles, SpeechSection } from './SpeechSection';

const entry = () => ({ settings: FAKE_DEFAULTS, credentials: {}, pair: { source: 'auto', target: 'en' } });
const localEntry = () => ({ settings: { ...LOCAL_INFERENCE_DEFAULTS }, credentials: {}, pair: { source: 'ja', target: 'en' } });
const originalResolve = useModelStore.getState().resolve;
const originalSetUIMode = useSettingsStore.getState().setUIMode;

/** The switch labeled `label`, out of every switch on the page. */
const switchByLabel = (label: string) => screen.getAllByRole('switch').find((el) => el.textContent?.includes(label))!;

beforeEach(() => {
  trackEvent.mockClear();
  tooltipContents.length = 0;
  useProviderStore.setState({ selected: 'localInference', entries: { localInference: localEntry() }, readiness: {} });
  useSettingsStore.setState({ textOnly: false, keepReplayAudio: false, settingsNavigationTarget: null, uiMode: 'basic', setUIMode: originalSetUIMode } as Partial<ReturnType<typeof useSettingsStore.getState>>);
  useTurnModeStore.setState({ turnMode: 'auto' });
  useAudioStore.setState({ mode: 'speaker' } as Partial<ReturnType<typeof useAudioStore.getState>>);
  asr.entry = { type: 'asr', asrWorkerType: 'whisper-webgpu' };
  useModelStore.setState({ resolve: () => ({ asr: { modelId: 'asr-model' }, translation: null, tts: null }) } as unknown as Partial<ReturnType<typeof useModelStore.getState>>);
});

afterEach(() => {
  useProviderStore.setState({ selected: null, entries: {}, readiness: {} });
  useModelStore.setState({ resolve: originalResolve });
});

describe('SpeechSection', () => {
  it('is one config-section with the three turn modes, the current one active, and no switch inside it', () => {
    const { container } = render(<SpeechSection locked={false} />);
    const section = container.querySelector('#turn-detection-section');
    expect(section).toBeTruthy();
    expect(section?.className).toContain('config-section');
    expect(section?.querySelector('h3')?.textContent).toContain('settings.speechMode');
    const buttons = section!.querySelectorAll('.option-button');
    expect([...buttons].map((b) => b.textContent)).toEqual(['Auto', 'Push-to-Talk', 'Push-to-Translate']);
    expect(buttons[0]).toHaveClass('active');
    expect(section!.querySelector('[role="switch"]')).toBeNull();
  });

  it('clicking a mode sets it, persists it and tracks speech_mode_changed with LocalInference selected (old spelling)', () => {
    render(<SpeechSection locked={false} />);
    fireEvent.click(screen.getByText('Push-to-Talk'));
    expect(useTurnModeStore.getState().turnMode).toBe('push-to-talk');
    expect(trackEvent).toHaveBeenCalledWith('speech_mode_changed', { provider: 'local_inference', from_mode: 'Auto', to_mode: 'Push-to-Talk' });
    // `setTurnMode` persists through the real settings service (not mocked in
    // this file), which writes settings.common.turnMode straight to
    // localStorage — no ServiceFactory mock needed to observe it.
    expect(localStorage.getItem('settings.common.turnMode')).toBe('push-to-talk');
  });

  // Ruling 8: every provider ends an utterance under Auto by its own
  // detection now (LocalInference's VAD, Soniox's endpoint model), so the
  // heading's tooltip names none of them.
  it("the Speech mode's tooltip names no mechanism: the provider's detection, for your voice and the other side's", () => {
    render(<SpeechSection locked={false} />);
    const texts = tooltipContents.filter((c): c is string => typeof c === 'string');
    // The heading's: the one that explains the three modes.
    const heading = texts.find((c) => c.includes('Push-to-Translate:'));
    expect(heading).toContain('Auto: the provider detects when you have finished speaking.');
    expect(heading).toContain("Other's audio always uses the provider's automatic detection.");
    for (const c of texts) {
      expect(c).not.toContain('semantic VAD');
      expect(c).not.toContain('local Voice Activity Detection');
    }
  });

  it('clicking the active mode does nothing', () => {
    render(<SpeechSection locked={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Auto', exact: true }));
    expect(trackEvent).not.toHaveBeenCalled();
    expect(useTurnModeStore.getState().turnMode).toBe('auto');
  });

  it("locked disables the three turn-mode buttons, and OutputToggles' Text only — Keep audio for replay stays enabled", () => {
    render(
      <>
        <SpeechSection locked={true} />
        <OutputToggles locked={true} />
      </>,
    );
    // The three turn modes — the tuning summary's link below them only
    // navigates, and stays enabled (its own case below).
    const modes = ['Auto', 'Push-to-Talk', 'Push-to-Translate'].map((label) => screen.getByRole('button', { name: label }));
    for (const button of modes) expect(button).toBeDisabled();
    expect(switchByLabel('Text Only').getAttribute('aria-disabled')).toBe('true');
    expect(switchByLabel('Keep audio for replay').getAttribute('aria-disabled')).toBe('false');
  });
});

describe("SpeechSection — automatic speech detection", () => {
  const disclosure = () => screen.getByRole('button', { name: /Speech detection/ });

  it('starts collapsed and expands controls in place without navigating', () => {
    const { container } = render(<SpeechSection locked={false} />);
    const button = disclosure();
    expect(button).toHaveAttribute('aria-expanded', 'false');
    const panel = document.getElementById(button.getAttribute('aria-controls')!)!;
    expect(panel).not.toBeVisible();
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(panel).toBeVisible();
    expect(panel.querySelectorAll('input[type="range"]').length).toBeGreaterThanOrEqual(3);
    expect(container.querySelector('#turn-detection-section')!.contains(panel)).toBe(true);
    expect(useSettingsStore.getState().settingsNavigationTarget).toBeNull();
    fireEvent.click(button);
    expect(panel).not.toBeVisible();
  });

  it('edits the current provider and updates the collapsed summary', () => {
    const { container } = render(<SpeechSection locked={false} />);
    fireEvent.click(disclosure());
    const block = container.querySelector<HTMLElement>('#turn-detection-tuning-section')!;
    const slider = within(block).getByText('Min Silence Duration').closest('.setting-item')!.querySelector('input[type="range"]')!;
    fireEvent.change(slider, { target: { value: '0.5' } });
    expect((useProviderStore.getState().entries.localInference.settings as typeof LOCAL_INFERENCE_DEFAULTS).vadMinSilenceDuration).toBe(0.5);
    fireEvent.click(disclosure());
    expect(disclosure()).toHaveTextContent('0.50s');
  });

  it.each(['push-to-talk', 'push-to-translate'] as const)('%s hides the tuning and returning to Auto collapses it', (mode) => {
    render(<SpeechSection locked={false} />);
    fireEvent.click(disclosure());
    fireEvent.click(screen.getByText(mode === 'push-to-talk' ? 'Push-to-Talk' : 'Push-to-Translate'));
    expect(screen.queryByRole('button', { name: /Speech detection/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Auto', exact: true }));
    expect(disclosure()).toHaveAttribute('aria-expanded', 'false');
  });

  it('a provider without tuning shows no disclosure', () => {
    useProviderStore.setState({ selected: 'fake', entries: { fake: entry() } });
    render(<SpeechSection locked={false} />);
    expect(screen.queryByRole('button', { name: /Speech detection/ })).toBeNull();
  });

  it('a session permits inspection while preventing parameter changes', () => {
    const { container } = render(<SpeechSection locked={true} />);
    expect(disclosure()).not.toBeDisabled();
    fireEvent.click(disclosure());
    const sliders = container.querySelectorAll('#turn-detection-tuning-section input[type="range"]');
    expect(sliders.length).toBeGreaterThanOrEqual(3);
    for (const slider of sliders) expect(slider).toBeDisabled();
  });

  it('a direct tuning target expands the controls', () => {
    useSettingsStore.setState({ settingsNavigationTarget: 'turn-detection-tuning' });
    render(<SpeechSection locked={false} />);
    expect(disclosure()).toHaveAttribute('aria-expanded', 'true');
  });

  it('keeps the provider help beside the disclosure', () => {
    render(<SpeechSection locked={false} />);
    expect(tooltipContents).toContain('Voice Activity Detection parameters. Controls how speech segments are detected and split. Changes take effect on next session start.');
  });
});

describe('OutputToggles', () => {
  it('is one config-section with no heading, holding the two switches', () => {
    const { container } = render(<OutputToggles locked={false} />);
    const section = container.querySelector('#output-section');
    expect(section).toBeTruthy();
    expect(section?.className).toContain('config-section');
    expect(section?.querySelector('h3')).toBeNull();
    expect(section!.querySelectorAll('[role="switch"]')).toHaveLength(2);
  });

  it("toggles Text Only for LocalInference (speech: 'optional')", () => {
    render(<OutputToggles locked={false} />);
    const sw = switchByLabel('Text Only');
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(sw);
    expect(useSettingsStore.getState().textOnly).toBe(true);
  });

  it('shows Text Only on and disabled in participant mode, with the forced-by-mode tooltip', () => {
    useAudioStore.setState({ mode: 'participant' } as Partial<ReturnType<typeof useAudioStore.getState>>);
    render(<OutputToggles locked={false} />);
    const sw = switchByLabel('Text Only');
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(sw.getAttribute('aria-disabled')).toBe('true');
    expect(tooltipContents).toContain('simpleConfig.textOnlyForcedByMode');
  });

  it("hides Text Only for a provider with speech: 'always'", () => {
    useProviderStore.setState({ selected: 'always-provider', entries: { 'always-provider': entry() } });
    render(<OutputToggles locked={false} />);
    expect(screen.queryByText('Text Only')).toBeNull();
    expect(screen.getAllByRole('switch')).toHaveLength(1);
  });

  it("shows Text Only on and disabled for a provider with speech: 'never'", () => {
    useProviderStore.setState({ selected: 'never-provider', entries: { 'never-provider': entry() } });
    render(<OutputToggles locked={false} />);
    const sw = switchByLabel('Text Only');
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(sw.getAttribute('aria-disabled')).toBe('true');
  });

  it('toggles Keep audio for replay', () => {
    render(<OutputToggles locked={false} />);
    const sw = switchByLabel('Keep audio for replay');
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(sw);
    expect(useSettingsStore.getState().keepReplayAudio).toBe(true);
  });
});
