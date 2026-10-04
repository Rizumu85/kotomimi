// @vitest-environment jsdom
//
// Fork: what this computer offers another device is held to the models it
// actually holds — never a cloud fallback (FORK.md: sharing lends downloaded
// models, and a peer's speech must not leave the network through an online
// service it never chose).
import { afterEach, describe, expect, it } from 'vitest';
import { useModelStore } from '../../stores/modelStore';
import { appLanModels } from './appModels';

const DEFAULT = { ...useModelStore.getState() };
afterEach(() => useModelStore.setState(DEFAULT, true));

/** The store as if these models were downloaded, with a graphics card present. */
const downloaded = (...ids: string[]) =>
  useModelStore.setState({ modelStatuses: Object.fromEntries(ids.map((id) => [id, 'downloaded'])) as never, webgpuAvailable: true });

describe('what a sharing computer offers the network', () => {
  it('never lists a cloud model among the shared ones', () => {
    // Only cloud models "ready": nothing is actually held here.
    downloaded();
    const shared = appLanModels.shared();
    expect(shared.find((m) => m.id === 'bing-translator')).toBeUndefined();
    expect(shared.find((m) => m.id === 'edge-tts')).toBeUndefined();
  });

  it('lists a translation model that is downloaded here', () => {
    downloaded('opus-mt-ja-en');
    expect(appLanModels.shared().map((m) => m.id)).toContain('opus-mt-ja-en');
  });

  it('does not fall back to online Bing for a pair left to this computer', () => {
    // A peer leaves the model blank; nothing local translates en→ja, so there is nothing to offer — not Bing.
    downloaded();
    expect(appLanModels.translator('en', 'ja', '')).toBeNull();
    // Even named outright, a cloud model is refused for sharing.
    expect(appLanModels.translator('en', 'ja', 'bing-translator')).toBeNull();
  });

  it('resolves a blank pair to a translation model downloaded here', () => {
    downloaded('opus-mt-ja-en');
    expect(appLanModels.translator('ja', 'en', '')).toBe('opus-mt-ja-en');
  });
});
