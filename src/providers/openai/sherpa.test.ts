import { afterEach, describe, expect, it, vi } from 'vitest';
import { nativeEngineOf, nativeModel, nativeModelFor, chooseNative, nativePicked, nativeGap, nativeUp, holdNative } from './localaiNative';
import { useNativeEngineStore } from '../../stores/nativeEngineStore';
import { NO_NATIVE_ENGINE, type NativeEngineStatus } from '../../lib/native/nativeEngine';
import { buildLocalAI, LOCALAI_DEFAULTS } from './localai';
import { SHARED } from './testing';

const CPU = 'x-asr-zh-en';
const GPU = 'qwen3-asr-1.7b-q8';
const pick = { model: CPU, byLanguage: { zh: CPU, ja: GPU, auto: GPU } };
const status: NativeEngineStatus = {
  ...NO_NATIVE_ENGINE, supported: true, engine: 'ready',
  models: Object.fromEntries([CPU, GPU, 'r2t2-q8'].map((id) => [id, { state: 'downloaded', received: 1, total: 1 }])),
};
afterEach(() => { useNativeEngineStore.setState({ status: NO_NATIVE_ENGINE }); vi.useRealTimers(); });

describe('CPU and GPU recognition on separate engines', () => {
  it('exposes its capabilities and hears only Chinese, English and their automatic detection', () => {
    expect(nativeModel(CPU)).toMatchObject({ bytes: 614596718, languages: ['zh', 'en'], detects: true, usesGpu: false, takesHints: false });
    expect(nativeEngineOf(CPU)).toBe('sherpa-onnx');
    expect(nativeEngineOf(GPU)).toBe('audio.cpp');
    expect(nativeEngineOf('apple-speech:zh')).toBe('apple-speech');
    for (const language of ['zh-CN', 'en', 'auto']) expect(nativeModelFor(CPU, language)?.id).toBe(CPU);
    expect(nativeModelFor(CPU, 'ja')).toBeNull();
  });

  it('keeps the other engine choice, including when the other leg detects its language', async () => {
    expect(chooseNative({ model: GPU }, CPU, ['zh'], ['zh', 'ja']).byLanguage).toEqual({ zh: CPU, ja: GPU });
    expect(nativePicked({ ...pick, detecting: true }, 'zh')?.id).toBe(CPU);
    expect(nativePicked({ ...pick, detecting: true }, 'auto')?.id).toBe(GPU);
    expect(await nativeGap(pick, ['zh', 'ja'], { status: async () => status })).toBeNull();
    expect(await nativeGap({ ...pick, detecting: true }, ['zh', 'auto'], { status: async () => status })).toBeNull();
    const conflict = { model: GPU, byLanguage: { zh: GPU, ja: 'r2t2-q8' } };
    expect(await nativeGap(conflict, ['zh', 'ja'], { status: async () => status })).toMatchObject({ code: 'native_two_models' });
  });

  it('starts both engines while a sharing device holds the GPU engine, but refuses another model on it', async () => {
    vi.useFakeTimers();
    useNativeEngineStore.setState({ status: { ...status, up: [GPU], run: { state: 'ready', model: GPU, port: 10, tail: '' } } });
    const release = holdNative('asr', { stop: { asr: () => {}, translation: () => {}, coach: () => {} } });
    const start = vi.fn(async (id: string) => ({ ...status, up: [GPU, id] }));
    try {
      await nativeUp(pick, ['zh', 'ja'], { start });
      expect(start.mock.calls.map(([id]) => id).sort()).toEqual([GPU, CPU].sort());
      await expect(nativeUp('r2t2-q8', ['ja'], { start })).rejects.toMatchObject({ code: 'native_busy' });
    } finally { release(); vi.runAllTimers(); }
  });

  it('builds the two legs with their own model and omits recognition hints only for X-ASR', () => {
    const s = { ...LOCALAI_DEFAULTS, asrVia: 'device' as const, asrHere: 'native' as const, asrNativeModel: CPU,
      asrNativeByLanguage: pick.byLanguage, translateAt: 'api' as const, translateBaseUrl: 'https://example.test/v1', translateModel: 'test', translateNeedsKey: false };
    const shared = { ...SHARED, reversed: (d: { source: string }) => d.source !== 'zh', models: [], glossary: { entries: [{ id: 'one', source: 'VRChat', aliases: [] }] } };
    const own = buildLocalAI({ direction: { source: 'zh', target: 'ja' }, speech: false, turns: 'auto' }, s, shared);
    const other = buildLocalAI({ direction: { source: 'ja', target: 'zh' }, speech: false, turns: 'auto' }, s, shared);
    expect(own).toMatchObject({ device: { modelId: CPU, native: { model: CPU } } });
    expect(other).toMatchObject({ device: { modelId: GPU, native: { model: GPU, hints: ['VRChat'] } } });
    if ('refused' in own) throw new Error(own.refused);
    expect(own.device?.native).not.toHaveProperty('hints');
  });

  it('does not reserve an idle GPU model while a device holds only the CPU recognizer', async () => {
    vi.useFakeTimers();
    useNativeEngineStore.setState({ status: { ...status, up: [GPU, CPU] } });
    const release = holdNative('asr', { stop: { asr: () => {}, translation: () => {}, coach: () => {} } }, CPU);
    const start = vi.fn(async (id: string) => ({ ...status, up: [CPU, id] }));
    try {
      await nativeUp('r2t2-q8', ['ja'], { start });
      expect(start).toHaveBeenCalledWith('r2t2-q8');
    } finally { release(); vi.runAllTimers(); }
  });
});
