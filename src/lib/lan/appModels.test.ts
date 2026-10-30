import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useModelStore } from '../../stores/modelStore';
import { useNativeCoachStore, useNativeEngineStore, useNativeTranslatorStore } from '../../stores/nativeEngineStore';
import { NO_NATIVE_ENGINE } from '../native/nativeEngine';
import { appLanModels } from './appModels';

beforeEach(() => {
  for (const store of [useNativeEngineStore, useNativeTranslatorStore, useNativeCoachStore]) store.setState({ status: NO_NATIVE_ENGINE, asked: true });
});

describe('native-only LAN sharing', () => {
  it('never resolves or advertises old browser models or online fallback translators', () => {
    useModelStore.setState({ modelStatuses: { 'sensevoice-int8': 'downloaded', 'opus-mt-ja-en': 'downloaded' }, initialized: true, webgpuAvailable: true });
    const resolve = vi.spyOn(useModelStore.getState(), 'resolve');
    try {
      expect(appLanModels.shared()).toEqual([]);
      for (const name of ['', 'sensevoice-int8']) expect(appLanModels.recognizer('ja', name)).toBeNull();
      for (const name of ['', 'opus-mt-ja-en', 'bing-translator']) expect(appLanModels.translator('ja', 'en', name)).toBeNull();
      expect(resolve).not.toHaveBeenCalled();
    } finally {
      resolve.mockRestore();
    }
  });
});
