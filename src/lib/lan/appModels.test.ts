// src/lib/lan/appModels.test.ts
//
// Fork: what this computer lends, as the model store says it — and that an online service the app uses for itself is
// never part of it (Rizumu85/kotomimi#2, 中-4).
import { beforeEach, describe, expect, it } from 'vitest';
import { getManifestByType } from '../local-inference/modelManifest';
import { useModelStore } from '../../stores/modelStore';
import { appLanModels } from './appModels';

const cloud = getManifestByType('translation').filter((m) => m.isCloudModel);
const local = getManifestByType('translation').find((m) => !m.isCloudModel && m.sourceLang === 'ja' && m.targetLang === 'zh')
  ?? getManifestByType('translation').find((m) => !m.isCloudModel);

beforeEach(() => {
  useModelStore.setState({ modelStatuses: {}, webgpuAvailable: true, initialized: true } as never);
});

describe('what this computer shares of the app\'s own models', () => {
  it('has an online translator among the app\'s models: the case is a real one', () => {
    expect(cloud.length).toBeGreaterThan(0);
    expect(local).toBeDefined();
  });

  it('lists no online service, downloaded models or none', () => {
    expect(appLanModels.shared().some((m) => cloud.some((c) => c.id === m.id))).toBe(false);
    useModelStore.setState({ modelStatuses: { [local!.id]: 'downloaded' } } as never);
    const shared = appLanModels.shared();
    expect(shared.some((m) => m.id === local!.id)).toBe(true);
    expect(shared.some((m) => cloud.some((c) => c.id === m.id))).toBe(false);
  });

  it('translates for another device with no online service: none named, one named, or nothing downloaded', () => {
    // Nothing downloaded: the app itself would use the online one; a device is told there is no model.
    expect(appLanModels.translator('ja', 'zh', '')).toBeNull();
    expect(appLanModels.translator('ja', 'zh', cloud[0].id)).toBeNull();
  });
});
