import { beforeEach, describe, expect, it, vi } from 'vitest';

const { stored, setSetting } = vi.hoisted(() => ({
  stored: new Map<string, unknown>(),
  setSetting: vi.fn(async () => ({ success: true })),
}));

vi.mock('../services/ServiceFactory', () => ({
  ServiceFactory: {
    getSettingsService: () => ({
      getSetting: async (key: string, fallback: unknown) => (stored.has(key) ? stored.get(key) : fallback),
      setSetting,
    }),
  },
}));

import { useVRChatStore } from './vrchatStore';

const ON_VIDEO = 'settings.vrchat.onVideo';
const SWITCH = 'settings.vrchat.translateVideo';

async function load(onVideo: unknown, translateVideo?: boolean) {
  stored.clear();
  setSetting.mockClear();
  stored.set(ON_VIDEO, onVideo);
  if (translateVideo !== undefined) stored.set(SWITCH, translateVideo);
  await useVRChatStore.getState().hydrate();
  return useVRChatStore.getState().onVideo;
}

describe('vrchatStore — what an older build saved about a video (fork)', () => {
  beforeEach(() => useVRChatStore.setState({ onVideo: 'ask' }));

  it('hears both for the mix, which lost people', async () => {
    expect(await load('normal')).toBe('both');
    await vi.waitFor(() => expect(setSetting).toHaveBeenCalledWith(ON_VIDEO, 'both'));
  });

  it('hears both for the switch, and turns the switch off, so that it is read once', async () => {
    expect(await load('quick', true)).toBe('both');
    await vi.waitFor(() => {
      expect(setSetting).toHaveBeenCalledWith(ON_VIDEO, 'both');
      expect(setSetting).toHaveBeenCalledWith(SWITCH, false);
    });
  });

  it('leaves what still means the same', async () => {
    expect(await load('quick', false)).toBe('quick');
    expect(await load('pause')).toBe('pause');
    expect(await load('both')).toBe('both');
    expect(await load('whatever')).toBe('ask');
  });
});
