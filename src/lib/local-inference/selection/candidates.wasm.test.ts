import { describe, it, expect } from 'vitest';
import { wasmCandidates } from './candidates.wasm';
import { getManifestByType } from '../modelManifest';
import { byRank, resolveStage } from './resolveStage';
import { MEASURED_ASR_ORDER, measuredEntries, measuredNote, offeredFor, offeredLanguages } from './measuredRank';

const allDownloaded = () => {
  const out: Record<string, 'downloaded'> = {};
  for (const t of ['asr', 'asr-stream', 'translation', 'tts'] as const) {
    for (const m of getManifestByType(t)) out[m.id] = 'downloaded';
  }
  return out;
};

const ctx = () => ({
  modelStatuses: allDownloaded(),
  webgpuAvailable: true,
  deviceFeatures: [] as string[],
});

describe('the recognizers\' order where it was measured (fork)', () => {
  const ranked = (language: string) => wasmCandidates(ctx()).pool('asr', language, 'en').filter((c) => c.autoEligible).sort(byRank).map((c) => c.id);

  it('tries the recognizers measured best on Japanese conversation first, in that order', () => {
    expect(ranked('ja').slice(0, 3)).toEqual(['qwen3-asr-1.7b-webgpu', 'whisper-large-v3-turbo-webgpu', 'voxtral-mini-4b-webgpu']);
  });

  it('keeps the one measured unusable for Japanese to the end: picked by hand, or when nothing else is there', () => {
    const ja = ranked('ja');
    expect(ja[ja.length - 1]).toBe('granite-speech-4.1-2b');
    // Still in the pool: with only that one downloaded, it is what hears.
    const only = wasmCandidates({ ...ctx(), modelStatuses: { 'granite-speech-4.1-2b': 'downloaded' } }).pool('asr', 'ja', 'en').filter((c) => c.ready && c.autoEligible).map((c) => c.id);
    expect(only).toEqual(['granite-speech-4.1-2b']);
  });

  it('does not offer for Japanese the SenseVoice that runs in the page, which writes it without its kana: never the automatic choice, though a choice made before still finds it', () => {
    const withheld = ['sensevoice-int8', 'sensevoice-nano-int8'];
    expect(MEASURED_ASR_ORDER.ja.unoffered).toEqual(withheld);
    for (const id of withheld) expect(ranked('ja')).not.toContain(id);
    // With nothing else downloaded, nothing hears Japanese by itself…
    const only = wasmCandidates({ ...ctx(), modelStatuses: { 'sensevoice-int8': 'downloaded', 'sensevoice-nano-int8': 'downloaded' } });
    expect(resolveStage('ja→en', 'asr', {}, only)).toMatchObject({ resolved: null, note: { reason: 'no-candidate' } });
    // …and a choice of one saved by an earlier build is still the model that hears, not another.
    for (const id of withheld) {
      const saved = { 'ja→en': { asr: { modelId: id }, translation: { modelId: '' }, tts: { modelId: '' } } };
      expect(resolveStage('ja→en', 'asr', saved, only)).toEqual({ resolved: { modelId: id, variant: undefined, source: 'explicit' } });
      expect(resolveStage('ja→en', 'asr', saved, wasmCandidates(ctx())).resolved).toMatchObject({ modelId: id, source: 'explicit' });
    }
    // The languages it reads well are as they were: offered, and the automatic choice where the catalog says so.
    for (const language of ['zh', 'en', 'ko', 'yue']) {
      for (const id of withheld) {
        expect(offeredFor(id, language)).toBe(true);
        expect(wasmCandidates(ctx()).pool('asr', language, 'en').find((c) => c.id === id)?.autoEligible).toBe(true);
      }
    }
    expect(resolveStage('zh→en', 'asr', {}, only).resolved).toMatchObject({ source: 'auto' });
    expect(offeredLanguages('sensevoice-int8', ['zh', 'en', 'ja', 'ko', 'yue'])).toEqual(['zh', 'en', 'ko', 'yue']);
    expect(offeredLanguages('whisper-large-v3-turbo-webgpu', ['ja', 'en'])).toEqual(['ja', 'en']);
  });

  it('lists in the library what is offered for the language, and one that is not only while it is what hears', () => {
    const catalog = [...getManifestByType('asr'), ...getManifestByType('asr-stream')].filter((m) => m.multilingual || m.languages.includes('ja'));
    expect(measuredEntries(catalog, 'ja').map((m) => m.id)).not.toContain('sensevoice-int8');
    expect(measuredEntries(catalog, 'ja').map((m) => m.id)).not.toContain('sensevoice-nano-int8');
    // The one chosen before stays, last and unmarked, with what was found of it; the other is still not offered.
    const kept = measuredEntries(catalog, 'ja', 'sensevoice-int8');
    expect(kept[kept.length - 1]).toMatchObject({ id: 'sensevoice-int8', recommended: false });
    expect(kept.map((m) => m.id)).not.toContain('sensevoice-nano-int8');
    expect(measuredNote('sensevoice-int8', 'ja')).toBe('noteSenseVoice');
    expect(measuredNote('sensevoice-nano-int8', 'ja')).toBe('noteSenseVoice');
    // A language that was not measured lists everything, as given.
    const zh = [...getManifestByType('asr')].filter((m) => m.multilingual || m.languages.includes('zh'));
    expect(measuredEntries(zh, 'zh').map((m) => m.id)).toEqual(zh.map((m) => m.id));
  });

  it('leaves the catalog\'s order alone for a language that was not measured', () => {
    const source = wasmCandidates(ctx());
    const catalog = [...getManifestByType('asr'), ...getManifestByType('asr-stream')];
    for (const c of source.pool('asr', 'ko', 'en')) {
      const entry = catalog.find((m) => m.id === c.id)!;
      expect([c.id, c.recommended, c.sortOrder]).toEqual([entry.id, Boolean(entry.recommended), entry.sortOrder ?? 0]);
    }
    expect(ranked('ko')[0]).toBe('cohere-transcribe-webgpu');
  });
});

describe('wasmCandidates', () => {
  it('puts both asr and asr-stream models in the ASR pool', () => {
    const ids = wasmCandidates(ctx()).pool('asr', 'ja', 'en').map((c) => c.id);
    const streamIds = getManifestByType('asr-stream').map((m) => m.id);
    expect(ids.some((id) => streamIds.includes(id))).toBe(true);
  });

  it('filters ASR by SOURCE language', () => {
    const s = wasmCandidates(ctx());
    const ja = s.pool('asr', 'ja', 'en').map((c) => c.id);
    const ko = s.pool('asr', 'ko', 'en').map((c) => c.id);
    expect(ja).not.toEqual(ko);
  });

  it('filters TTS by TARGET language — the mirror of ASR', () => {
    const s = wasmCandidates(ctx());
    const toEn = s.pool('tts', 'ja', 'en').map((c) => c.id);
    const toJa = s.pool('tts', 'en', 'ja').map((c) => c.id);
    expect(toEn).not.toEqual(toJa);
  });

  it('excludes a directional translation model from the reverse direction', () => {
    const s = wasmCandidates(ctx());
    const fwd = s.pool('translation', 'ja', 'en').map((c) => c.id);
    const rev = s.pool('translation', 'en', 'ja').map((c) => c.id);
    const onlyForward = fwd.filter((id) => !rev.includes(id));
    expect(onlyForward.length).toBeGreaterThan(0);
  });

  it('keeps has() language-agnostic, so a wrong-direction model is preserved not pruned', () => {
    const s = wasmCandidates(ctx());
    const fwd = s.pool('translation', 'ja', 'en').map((c) => c.id);
    const rev = s.pool('translation', 'en', 'ja').map((c) => c.id);
    const onlyForward = fwd.find((id) => !rev.includes(id))!;
    expect(s.has('translation', onlyForward)).toBe(true);
  });

  it('reports has() false for an id no longer in the manifest', () => {
    expect(wasmCandidates(ctx()).has('asr', 'retired-model-xyz')).toBe(false);
  });

  it('marks un-downloaded models not ready', () => {
    const s = wasmCandidates({ ...ctx(), modelStatuses: {} });
    const local = s.pool('asr', 'ja', 'en').filter((c) => !c.needsKey);
    expect(local.every((c) => !c.ready)).toBe(true);
  });

  it('treats cloud models as ready regardless of download status', () => {
    const s = wasmCandidates({ ...ctx(), modelStatuses: {} });
    const cloud = s.pool('tts', 'ja', 'en').filter((c) =>
      getManifestByType('tts').find((m) => m.id === c.id)?.isCloudModel);
    expect(cloud.length).toBeGreaterThan(0);
    expect(cloud.every((c) => c.ready)).toBe(true);
  });

  it('marks WebGPU-only models hardware-gated when WebGPU is absent', () => {
    const s = wasmCandidates({ ...ctx(), webgpuAvailable: false });
    const gated = s.pool('translation', 'ja', 'en').filter((c) => !c.hardwareOk);
    expect(gated.length).toBeGreaterThan(0);
  });

  it('supportsVariant rejects a variant this device cannot run, accepts one it can, and always accepts undefined (no pin)', () => {
    // qwen3-0.6b-translation: 'q4' has no requiredFeatures, 'q4f16' requires
    // shader-f16 — see modelManifest.ts. Machine without the feature.
    const noFeature = wasmCandidates({ ...ctx(), deviceFeatures: [] });
    const c = noFeature.pool('translation', 'ja', 'en').find((x) => x.id === 'qwen3-0.6b-translation')!;
    expect(c.supportsVariant(undefined)).toBe(true);
    expect(c.supportsVariant('q4')).toBe(true);
    expect(c.supportsVariant('q4f16')).toBe(false);

    // Same entry, machine WITH the feature — the pin becomes honourable.
    const withFeature = wasmCandidates({ ...ctx(), deviceFeatures: ['shader-f16'] });
    const c2 = withFeature.pool('translation', 'ja', 'en').find((x) => x.id === 'qwen3-0.6b-translation')!;
    expect(c2.supportsVariant('q4f16')).toBe(true);
  });

  it('adds AST-capable ASR entries to the translation pool as explicit-only', () => {
    const s = wasmCandidates(ctx());
    const ast = s.pool('translation', 'ja', 'en').filter((c) => c.autoEligible === false);
    expect(ast.length).toBeGreaterThan(0);
    for (const c of ast) {
      expect(getManifestByType('translation').some((m) => m.id === c.id)).toBe(false);
    }
  });

  it('has(translation, id) accepts an AST-capable ASR id but rejects a plain (non-AST) ASR id', () => {
    const s = wasmCandidates(ctx());
    // granite-speech: astLanguages present — a legitimate translation-stage
    // pick (the AST short-circuit), so its id must stay in the catalog.
    expect(s.has('translation', 'granite-speech')).toBe(true);
    // sensevoice-int8: a plain ASR entry with no astLanguages. It was never a
    // valid translation-stage candidate, so an id like this stored under the
    // translation stage is not revivable — it must prune, not linger as
    // 'lang-incompatible'.
    const plainAsr = getManifestByType('asr').find((m) => !m.astLanguages);
    expect(plainAsr).toBeDefined();
    expect(s.has('translation', plainAsr!.id)).toBe(false);
  });
});
