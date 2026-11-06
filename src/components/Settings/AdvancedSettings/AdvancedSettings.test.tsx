/** Categorized settings show only the selected category and preserve session locks. */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key) }) };
});

vi.mock('../../../services/ServiceFactory', () => ({
  ServiceFactory: {
    getSettingsService: () => ({
      getSetting: async (_k: string, d: unknown) => d,
      setSetting: async () => ({ success: true }),
    }),
  },
}));

const run = vi.hoisted(() => ({ locked: false }));
vi.mock('../../../app/useRun', () => ({ useSessionLocked: () => run.locked, useRunPhase: () => (run.locked ? 'running' : 'idle'), useFollowedLanguage: () => undefined }));

vi.mock('../shared/WarningModal', () => ({ default: () => null }));
vi.mock('../sections/SpeechSection', () => ({
  SpeechSection: () => <div data-testid="speech-section" />,
}));

const blocks = vi.hoisted(() => ({
  general: [] as Array<{ locked: boolean }>,
}));
vi.mock('../ProviderArea', () => ({
  SessionSettingsGeneral: (props: { locked: boolean }) => {
    blocks.general.push(props);
    return <div data-testid="session-settings-general" />;
  },
  SessionSettingsProvider: () => <div data-testid="session-settings-provider" />,
}));

vi.mock('../sections', () => ({
  AudioDeviceSection: () => <div data-testid="audio-device-section" />,
  SystemAudioSection: () => <div data-testid="system-audio-section" />,
  VoicePassthroughSection: () => <div data-testid="voice-passthrough-section" />,
  HelpSection: () => <div data-testid="help-section" />,
}));

const { default: useSettingsStore } = await import('../../../stores/settingsStore');
const { default: AdvancedSettings } = await import('./AdvancedSettings');

beforeEach(() => {
  run.locked = false;
  blocks.general.length = 0;
  useSettingsStore.setState({ engineSlotTarget: null, settingsNavigationTarget: null });
});

describe("Categorized settings", () => {

  it("hands SessionSettingsGeneral the run's lock", () => {
    run.locked = true;
    render(<AdvancedSettings activeTab="general" />);
    expect(blocks.general[blocks.general.length - 1].locked).toBe(true);
  });

  it('keeps provider controls in their own category', () => {
    const { rerender } = render(<AdvancedSettings activeTab="general" />);
    expect(screen.getByTestId('session-settings-general')).toBeInTheDocument();
    expect(screen.queryByTestId('session-settings-provider')).toBeNull();
    rerender(<AdvancedSettings activeTab="provider" />);
    expect(screen.queryByTestId('session-settings-general')).toBeNull();
    expect(screen.getByTestId('session-settings-provider')).toBeInTheDocument();
  });
});
