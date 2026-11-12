import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCALAI_DEFAULTS, buildLocalAI, checkLocalAIWithNative, prepareLocalAI, runSideHearing } from './localai';
import { nativeGap, nativePicked, nativeUp } from './localaiNative';
import { nativePlans } from './nativePlans';
import { useNativeEngineStore, useNativeTranslatorStore } from '../../stores/nativeEngineStore';
import { NO_NATIVE_ENGINE, type NativeEngineStatus } from '../../lib/native/nativeEngine';
import { SHARED } from './testing';

const x = 'x-asr-zh-en';
const qwen = 'qwen3-asr-0.6b-q8';
const settings = { ...LOCALAI_DEFAULTS, coach: false, asrVia: 'device' as const, translateAt: 'device' as const,
  asrNativeByLanguage: { zh: x, auto: qwen }, asrDetectOther: true, speakAlso: ['en'], theyAlso: [],
};
const pair = { source: 'zh', target: 'ja' };
const status = (ids: string[]): NativeEngineStatus => ({ ...NO_NATIVE_ENGINE, supported: true, engine: 'ready',
  models: Object.fromEntries(ids.map((id) => [id, { state: 'downloaded', received: 1, total: 1 }])) });
afterEach(() => { useNativeEngineStore.setState({ status: NO_NATIVE_ENGINE }); useNativeTranslatorStore.setState({ status: NO_NATIVE_ENGINE }); });

describe('plans and actual native stages agree', () => {
  it('builds two independent auto recognizers, checks both, and starts both engines', async () => {
    useNativeEngineStore.setState({ status: status([x, qwen]) });
    useNativeTranslatorStore.setState({ status: status(['index-translate-2b']) });
    const plan = nativePlans({ settings, pair, platform: 'win32', memoryMB: 8192, lending: false, downloaded: [x, qwen] }).plans[1];
    expect(plan.speaker.model).toBe(x);
    expect(plan.participant.model).toBe(qwen);
    const shared = { ...SHARED, models: [], reversed: (direction: { source: string }) => direction.source === 'ja' };
    for (const leg of ['speaker', 'participant'] as const) {
      const direction = leg === 'speaker' ? pair : { source: pair.target, target: pair.source };
      expect(nativePicked(runSideHearing(settings, pair, leg), 'auto')?.id).toBe(plan[leg].model);
      const built = buildLocalAI({ direction, speech: false, turns: 'auto' }, settings, shared);
      expect(built).toMatchObject({ device: { modelId: plan[leg].model } });
    }
    const checked = vi.fn(async () => ({ ok: true as const }));
    const gap = vi.fn((pick, heard) => nativeGap(pick, heard, { status: async () => status([x, qwen]) }));
    await checkLocalAIWithNative({ apiKey: '', endpoint: '' }, settings, { pair, legs: ['speaker', 'participant'] }, checked, {
      gap, idle: vi.fn(), translatorGap: vi.fn(async () => null),
    });
    expect(gap.mock.calls[0][0].selections).toHaveLength(2);
    const hears = vi.fn<typeof nativeUp>(async () => {});
    await prepareLocalAI({ pair, legs: ['speaker', 'participant'] }, settings, { hears, translates: vi.fn(async () => {}), coaches: vi.fn(async () => {}), rest: vi.fn() });
    expect(hears.mock.calls[0]).toBeDefined();
    expect(hears.mock.calls[0][0]).toMatchObject({ selections: [
      { pick: { model: x }, language: 'auto' }, { pick: { model: qwen }, language: 'auto' },
    ] });
  });
  it('keeps Apple on the known side while the other side detects with Qwen', () => {
    useNativeEngineStore.setState({ status: status(['apple-speech:zh', qwen]) });
    const s = { ...settings, speakAlso: [], asrNativeByLanguage: { zh: 'apple-speech:zh', auto: qwen } };
    expect(nativePicked(runSideHearing(s, pair, 'speaker'), 'zh')?.id).toBe('apple-speech:zh');
    expect(nativePicked(runSideHearing(s, pair, 'participant'), 'auto')?.id).toBe(qwen);
  });
  it('keeps multi-language Apple assets on the side that needs them', () => {
    useNativeEngineStore.setState({ status: status(['apple-speech:zh', 'apple-speech:en', qwen]) });
    const s = { ...settings, asrNativeByLanguage: { zh: 'apple-speech:zh', auto: qwen } };
    const pick = runSideHearing(s, pair, 'speaker');
    expect(pick.either).toEqual({ own: 'zh', others: ['en'] });
    expect(nativePicked(pick, 'auto')?.id).toBe('apple-speech:zh');
  });
  it('still rejects two different models on one downloaded engine', async () => {
    const s = { ...settings, asrNativeByLanguage: { zh: 'sensevoice-small-q8', auto: qwen } };
    const selections = (['speaker', 'participant'] as const).map((leg) => ({ pick: runSideHearing(s, pair, leg), language: 'auto' }));
    expect(await nativeGap({ model: qwen, selections }, ['auto', 'auto'], { status: async () => status(['sensevoice-small-q8', qwen]) })).toMatchObject({ code: 'native_two_models' });
  });
});
