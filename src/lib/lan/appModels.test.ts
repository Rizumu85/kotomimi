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

  it('does not say the SenseVoice that runs in the page hears Japanese, which it writes without its kana, nor lends it for that by itself', () => {
    useModelStore.setState({ modelStatuses: { 'sensevoice-int8': 'downloaded', 'sensevoice-nano-int8': 'downloaded' } } as never);
    const listed = appLanModels.shared().filter((m) => m.kind === 'asr');
    expect(listed.map((m) => m.id)).toEqual(['sensevoice-int8', 'sensevoice-nano-int8']);
    // A device lists a recognizer for a run by the languages it is said to take: Japanese is not among them.
    for (const model of listed) expect([...model.languages].sort()).toEqual(['en', 'ko', 'yue', 'zh']);
    // Left to this computer, nothing here hears Japanese; Chinese is heard as ever.
    expect(appLanModels.recognizer('ja', '')).toBeNull();
    expect(appLanModels.recognizer('zh', '')).toEqual({ modelId: 'sensevoice-int8', streaming: false });
    // A device that chose it by name before is still answered by it: the model is never silently another.
    expect(appLanModels.recognizer('ja', 'sensevoice-int8')).toEqual({ modelId: 'sensevoice-int8', streaming: false });
    // Beside a recognizer that hears Japanese, that one is this computer's choice.
    useModelStore.setState({ modelStatuses: { 'sensevoice-int8': 'downloaded', 'moonshine-tiny-ja-quant': 'downloaded' } } as never);
    expect(appLanModels.recognizer('ja', '')).toEqual({ modelId: 'moonshine-tiny-ja-quant', streaming: false });
    expect(appLanModels.shared().find((m) => m.id === 'moonshine-tiny-ja-quant')?.languages).toEqual(['ja']);
  });

  it('translates for another device with no online service: none named, one named, or nothing downloaded', () => {
    // Nothing downloaded: the app itself would use the online one; a device is told there is no model.
    expect(appLanModels.translator('ja', 'zh', '')).toBeNull();
    expect(appLanModels.translator('ja', 'zh', cloud[0].id)).toBeNull();
  });
});
