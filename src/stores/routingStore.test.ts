import { describe, it, expect, beforeEach, vi } from 'vitest';

const { stored, setSetting } = vi.hoisted(() => {
  const stored = new Map<string, unknown>();
  return { stored, setSetting: vi.fn(async (key: string, value: unknown) => { stored.set(key, value); return { success: true }; }) };
});
vi.mock('../services/ServiceFactory', () => ({
  ServiceFactory: {
    getSettingsService: () => ({
      getSetting: async (key: string, def: unknown) => (stored.has(key) ? stored.get(key) : def),
      setSetting,
    }),
  },
}));

import { useRoutingStore } from './routingStore';

beforeEach(() => {
  stored.clear();
  setSetting.mockClear();
  useRoutingStore.setState({ meeting: true, participantSpeech: false });
});

describe('routingStore', () => {
  it('loads only non-empty meeting device ids without rewriting storage', async () => {
    expect(useRoutingStore.getInitialState().meetingDevice).toBeNull();
    for (const value of ['hardware', '', null, undefined, 42, {}]) {
      stored.set('settings.routing.meetingDevice', value);
      await useRoutingStore.getState().load();
      expect(useRoutingStore.getState().meetingDevice).toBe(value === 'hardware' ? value : null);
    }
    expect(setSetting).not.toHaveBeenCalled();
  });

  it('persists choosing a meeting device and returning to automatic selection', async () => {
    for (const id of ['hardware', null]) {
      useRoutingStore.getState().setMeetingDevice(id);
      expect(useRoutingStore.getState().meetingDevice).toBe(id);
      await vi.waitFor(() => expect(setSetting).toHaveBeenLastCalledWith('settings.routing.meetingDevice', id));
    }
  });

  it('loads finite speech volumes in range, with a separate default for each side', async () => {
    for (const [mine, theirs, expectedMine, expectedTheirs] of [
      [undefined, undefined, 0.5, 1], ['0.3', NaN, 0.5, 1], [Infinity, -Infinity, 0.5, 1],
      [-1, 2, 0, 1], [0.7, 0, 0.7, 0],
    ]) {
      stored.set('settings.routing.speechVolumeMine', mine);
      stored.set('settings.routing.speechVolumeTheirs', theirs);
      await useRoutingStore.getState().load();
      expect(useRoutingStore.getState()).toMatchObject({ speechVolumeMine: expectedMine, speechVolumeTheirs: expectedTheirs });
    }
    expect(setSetting).not.toHaveBeenCalled();
  });

  it('applies and persists the clamped volume on each side', async () => {
    useRoutingStore.getState().setSpeechVolumeMine(2);
    useRoutingStore.getState().setSpeechVolumeTheirs(-1);
    expect(useRoutingStore.getState()).toMatchObject({ speechVolumeMine: 1, speechVolumeTheirs: 0 });
    await vi.waitFor(() => {
      expect(setSetting).toHaveBeenCalledWith('settings.routing.speechVolumeMine', 1);
      expect(setSetting).toHaveBeenCalledWith('settings.routing.speechVolumeTheirs', 0);
    });
  });

  it('lets the meeting hear the translation and keeps participant speech off, until something was saved', async () => {
    await useRoutingStore.getState().load();
    expect(useRoutingStore.getState()).toMatchObject({ meeting: true, participantSpeech: false });
    stored.set('settings.routing.meeting', false);
    await useRoutingStore.getState().load();
    expect(useRoutingStore.getState()).toMatchObject({ meeting: false, participantSpeech: false });
  });

  // The owner, 2026-10-01: the switch is hidden and participant speech stays
  // off, so a choice saved while it showed must not turn it on unseen. The
  // saved value is left as it was, not rewritten.
  it('keeps participant speech off while its switch is hidden, whatever was saved', async () => {
    stored.set('settings.routing.participantSpeech', true);
    await useRoutingStore.getState().load();
    expect(useRoutingStore.getState().participantSpeech).toBe(false);
    expect(stored.get('settings.routing.participantSpeech')).toBe(true);
    expect(setSetting).not.toHaveBeenCalled();
  });

  it('ignores a saved value that is not a boolean', async () => {
    stored.set('settings.routing.meeting', 'yes');
    await useRoutingStore.getState().load();
    expect(useRoutingStore.getState().meeting).toBe(true);
  });

  it('saves each switch', async () => {
    useRoutingStore.getState().setMeeting(false);
    useRoutingStore.getState().setParticipantSpeech(true);
    expect(useRoutingStore.getState()).toMatchObject({ meeting: false, participantSpeech: true });
    await vi.waitFor(() => {
      expect(setSetting).toHaveBeenCalledWith('settings.routing.meeting', false);
      expect(setSetting).toHaveBeenCalledWith('settings.routing.participantSpeech', true);
    });
  });
});
