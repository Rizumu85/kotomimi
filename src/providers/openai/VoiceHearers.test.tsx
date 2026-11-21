import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { VoiceHearers, hearersOf } from './VoiceHearers';
import useAudioStore from '../../stores/audioStore';
import { useRoutingStore } from '../../stores/routingStore';

// The stores load the catalogs, which need the rest of the module: only the hook is replaced, and keys are shown.
vi.mock('react-i18next', async (original) => ({ ...(await original<typeof import('react-i18next')>()), useTranslation: () => ({ t: (key: string) => key }) }));

afterEach(cleanup);

const option = (name: string) => screen.getByRole('button', { name: `fork.voice.${name}` });

describe('who hears a translation read aloud', () => {
  beforeEach(() => {
    // Only the user's own leg runs: nothing of the other side's is captured, so the monitor may sound.
    useAudioStore.setState({ mode: 'speaker', isMonitorMuted: true, isRealVoicePassthroughEnabled: false });
    useRoutingStore.setState({ meeting: true });
  });

  it('is one choice, read from the stage and the routing', () => {
    expect(hearersOf(false, true, true)).toBe('none');
    expect(hearersOf(true, true, false)).toBe('me');
    expect(hearersOf(true, false, true)).toBe('them');
    expect(hearersOf(true, true, true)).toBe('both');
    // Set to speak along with nobody able to hear it: not "off", which would hide that sentences are still made.
    expect(hearersOf(true, false, false)).toBeNull();
  });

  it('lights nothing while it speaks to nobody, and "off" then turns it off', () => {
    // Set to the user alone, and the user's own output muted since: nothing of it is heard.
    useRoutingStore.setState({ meeting: false });
    const onAuto = vi.fn();
    render(<VoiceHearers auto onAuto={onAuto} />);
    for (const name of ['hearNone', 'hearMe', 'hearThem', 'hearBoth']) expect(option(name).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(option('hearNone'));
    expect(onAuto).toHaveBeenLastCalledWith(false);
  });

  it('keeps the switch for the user\'s own voice in sight wherever that voice is going out', () => {
    useAudioStore.setState({ isMonitorMuted: false, isRealVoicePassthroughEnabled: true });
    useRoutingStore.setState({ meeting: false });
    render(<VoiceHearers auto onAuto={vi.fn()} />);
    expect(option('hearMe').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('switch', { name: 'fork.voice.myVoiceToo' }).getAttribute('aria-checked')).toBe('true');
  });

  it('has a volume for the user always, and one for the other side while they hear it', () => {
    useRoutingStore.setState({ meeting: false, speechVolumeMine: 0.5, speechVolumeTheirs: 1 });
    const { rerender } = render(<VoiceHearers auto={false} onAuto={vi.fn()} />);
    // Reading turned off: a line read on demand is still the user's to hear.
    const mine = screen.getByRole('slider', { name: 'fork.voice.volumeMine' });
    expect(screen.queryByRole('slider', { name: 'fork.voice.volumeTheirs' })).toBeNull();
    fireEvent.change(mine, { target: { value: '0.3' } });
    expect(useRoutingStore.getState().speechVolumeMine).toBeCloseTo(0.3);

    useRoutingStore.setState({ meeting: true });
    rerender(<VoiceHearers auto onAuto={vi.fn()} />);
    fireEvent.change(screen.getByRole('slider', { name: 'fork.voice.volumeTheirs' }), { target: { value: '0.6' } });
    expect(useRoutingStore.getState().speechVolumeTheirs).toBeCloseTo(0.6);
  });

  it('dims what the user cannot hear, says why to the pointer, and writes nothing under it', () => {
    // The user's output is out of scope (here: the other side alone is heard; in the app also both sides, the other
    // side's from the whole system): what is read aloud would be heard as theirs.
    useAudioStore.setState({ mode: 'participant' });
    const onAuto = vi.fn();
    render(<VoiceHearers auto onAuto={onAuto} />);
    for (const name of ['hearMe', 'hearBoth']) {
      // Dimmed, yet reachable by the pointer: a disabled button would never show its reason.
      expect(option(name).getAttribute('aria-disabled')).toBe('true');
      expect((option(name) as HTMLButtonElement).disabled).toBe(false);
    }
    fireEvent.click(option('hearMe'));
    expect(useAudioStore.getState().isMonitorMuted).toBe(true);
    expect(screen.queryByRole('status')).toBeNull();
    expect(option('hearThem').getAttribute('aria-disabled')).toBeNull();
  });

  it('sets the stage and both routes in one press', () => {
    const onAuto = vi.fn();
    const { rerender } = render(<VoiceHearers auto={false} onAuto={onAuto} />);
    expect(option('hearNone').getAttribute('aria-pressed')).toBe('true');
    // Nothing is sent anywhere yet: no switch for the user's own voice.
    expect(screen.queryByRole('switch')).toBeNull();

    fireEvent.click(option('hearMe'));
    expect(onAuto).toHaveBeenLastCalledWith(true);
    expect(useAudioStore.getState().isMonitorMuted).toBe(false);
    expect(useRoutingStore.getState().meeting).toBe(false);

    rerender(<VoiceHearers auto onAuto={onAuto} />);
    expect(option('hearMe').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(option('hearThem'));
    expect(useAudioStore.getState().isMonitorMuted).toBe(true);
    expect(useRoutingStore.getState().meeting).toBe(true);
    // Sent to the other side: whether the user's own voice goes too is asked now.
    expect(screen.getByRole('switch', { name: 'fork.voice.myVoiceToo' })).toBeTruthy();

    fireEvent.click(option('hearNone'));
    expect(onAuto).toHaveBeenLastCalledWith(false);
    // The routing is the whole app's: turning the reading off leaves it as it is.
    expect(useRoutingStore.getState().meeting).toBe(true);
  });

  it('keeps whether it speaks along while a session runs, and still moves who hears it', () => {
    const onAuto = vi.fn();
    render(<VoiceHearers auto onAuto={onAuto} locked />);
    expect((option('hearNone') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(option('hearBoth'));
    expect(onAuto).not.toHaveBeenCalled();
    expect(useAudioStore.getState().isMonitorMuted).toBe(false);
    expect(useRoutingStore.getState().meeting).toBe(true);
  });
});
