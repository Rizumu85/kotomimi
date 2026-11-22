import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { standingMic, type StandingMicSettings } from './standingMic';

/** A stream of one track, which records its stop and can be ended as an unplugged device ends it. */
function fakeStream() {
  const ended = new Set<() => void>();
  const track = { stop: vi.fn(), addEventListener: (_type: string, listener: () => void) => { ended.add(listener); } };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  return { stream, track, end: () => { for (const listener of ended) listener(); } };
}

function settings(initial: { id?: string; muted?: boolean } = {}) {
  let state = { id: initial.id, muted: initial.muted ?? false };
  const listeners = new Set<() => void>();
  const source: StandingMicSettings = {
    deviceId: () => state.id,
    muted: () => state.muted,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const set = (patch: Partial<typeof state>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  return { source, set, listeners };
}

describe('standingMic (fork)', () => {
  const opened: Array<ReturnType<typeof fakeStream>> = [];
  const getUserMedia = vi.fn(async (_constraints: MediaStreamConstraints) => {
    const made = fakeStream();
    opened.push(made);
    return made.stream;
  });
  const deviceListeners = new Set<() => void>();
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  beforeEach(() => {
    opened.length = 0;
    getUserMedia.mockClear();
    deviceListeners.clear();
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia,
        addEventListener: (_type: string, listener: () => void) => { deviceListeners.add(listener); },
        removeEventListener: (_type: string, listener: () => void) => { deviceListeners.delete(listener); },
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('opens the chosen device unprocessed, and lets it go when the listening ends', async () => {
    const { source, listeners } = settings({ id: 'usb-mic' });
    const heard = vi.fn();
    const off = standingMic(source)(heard);
    await flush();
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { deviceId: { exact: 'usb-mic' }, echoCancellation: { exact: false }, noiseSuppression: { exact: false }, autoGainControl: { exact: false } },
    });
    expect(heard).toHaveBeenLastCalledWith(opened[0].stream);
    off();
    expect(opened[0].track.stop).toHaveBeenCalledOnce();
    expect(heard).toHaveBeenLastCalledWith(null);
    expect(listeners.size).toBe(0);
    expect(deviceListeners.size).toBe(0);
  });

  it('follows another device chosen, and a mute', async () => {
    const { source, set } = settings({ id: 'usb-mic' });
    const heard = vi.fn();
    standingMic(source)(heard);
    await flush();
    set({ id: 'headset' });
    await flush();
    expect(opened[0].track.stop).toHaveBeenCalledOnce();
    expect(heard).toHaveBeenLastCalledWith(opened[1].stream);
    set({ muted: true });
    expect(opened[1].track.stop).toHaveBeenCalledOnce();
    expect(heard).toHaveBeenLastCalledWith(null);
    set({ muted: false });
    await flush();
    expect(heard).toHaveBeenLastCalledWith(opened[2].stream);
    expect(getUserMedia).toHaveBeenCalledTimes(3);
  });

  it('lets go a device that opens after the listening ended', async () => {
    const { source } = settings();
    const heard = vi.fn();
    const off = standingMic(source)(heard);
    off();
    await flush();
    expect(opened[0].track.stop).toHaveBeenCalledOnce();
    expect(heard).not.toHaveBeenCalled();
  });

  it('asks for a device that went away only once it is plugged back in', async () => {
    const { source, set } = settings({ id: 'usb-mic' });
    const heard = vi.fn();
    standingMic(source)(heard);
    await flush();
    opened[0].end();
    expect(heard).toHaveBeenLastCalledWith(null);
    // Another setting moving is not a reason to ask again.
    set({});
    await flush();
    expect(getUserMedia).toHaveBeenCalledOnce();
    for (const listener of deviceListeners) listener();
    await flush();
    expect(heard).toHaveBeenLastCalledWith(opened[1].stream);
  });
});
