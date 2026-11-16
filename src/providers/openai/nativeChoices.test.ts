import { describe, expect, it } from 'vitest';
import { LOCALAI_DEFAULTS, runSideHearing, type LocalAISettings } from './localai';
import { chooseNativeRow, nativeChoiceFix, nativeChoiceRows, nativeRowChoice } from './nativeChoices';
import { NATIVE_MODELS, chooseNative, nativeChoice, nativeEngineOf, nativeGap, nativePicked, isApple } from './localaiNative';
import { NO_NATIVE_ENGINE } from '../../lib/native/nativeEngine';
import { hearingOf } from './localaiDevice';

const QWEN = 'qwen3-asr-1.7b-q8';
const R2T2 = 'r2t2-q8';
const SENSE = 'sensevoice-small-q8';
const X = 'x-asr-zh-en';
const legs = ['speaker', 'participant'] as const;
const pair = { source: 'zh-CN', target: 'yue' };
const here = () => true;
const settings = (patch: Partial<LocalAISettings> = {}): LocalAISettings => ({ ...LOCALAI_DEFAULTS, asrVia: 'device', asrNativeModel: QWEN, ...patch });

describe('native row choices', () => {
  it('keeps R2T2 visible but refuses Chinese-or-Cantonese, including the user\'s saved conflict', async () => {
    const s = settings({ speakAlso: ['yue'], asrNativeByLanguage: { zh: R2T2, yue: QWEN } });
    const rows = nativeChoiceRows(s, pair, legs, here);
    // R2T2 is the user's own language's: the Cantonese they also speak steps aside for it (`alsoSpoken`). The other
    // side's row, on the same engine, still has to be heard.
    expect(rows[0]).toMatchObject({ languages: ['zh'], detecting: false, model: { id: R2T2 } });
    expect(nativeRowChoice(rows, 'speaker', R2T2, here)).toEqual({ ok: false, unheard: 'yue' });
    expect(chooseNativeRow(s, rows, 'speaker', R2T2, here)).toBeNull();
    expect(nativeRowChoice(rows, 'participant', QWEN, here)).toEqual({ ok: true, moves: ['speaker'] });
    const fix = nativeChoiceFix(s, rows, [R2T2, QWEN], here)!;
    expect(fix.model).toBe(QWEN);
    const repaired = { ...s, ...fix.patch };
    expect(nativeChoiceFix(repaired, nativeChoiceRows(repaired, pair, legs, here), [R2T2, QWEN], here)).toBeNull();
    const selections = legs.map((leg) => ({ pick: runSideHearing(repaired, pair, leg), language: leg === 'speaker' ? 'auto' : 'yue' }));
    expect(selections.map((side) => nativePicked(side.pick, side.language, here)?.id)).toEqual([QWEN, QWEN]);
    expect(await nativeGap({ model: QWEN, selections }, ['auto', 'yue'], { status: async () => ({ ...NO_NATIVE_ENGINE, supported: true, engine: 'ready', models: { [QWEN]: { state: 'downloaded', received: 1, total: 1 } } }) })).toBeNull();
  });

  it('hears the user’s own side, alone on this computer, by its own row’s model whatever language it hears (fork)', () => {
    // Coached, the speaker is heard in the other side's Japanese; the model chosen for Japanese is the other side's,
    // who are heard elsewhere. Their row's menu wrote the Chinese slot and showed the Japanese one (the user, 2026-11-15).
    const apart = settings({ asrVia: 'server', coach: true, asrNativeByLanguage: { ja: 'qwen3-asr-0.6b-q8', zh: SENSE }, asrMine: { asrVia: 'device', asrModel: '', asrApiBaseUrl: '', asrApiModel: '', asrApiNeedsKey: true, asrOther: '', asrOtherModel: '' } });
    const mine = hearingOf(apart, 'speaker');
    const jaPair = { source: 'zh-CN', target: 'ja' };
    const rows = nativeChoiceRows(mine, jaPair, ['speaker'], here);
    expect(rows[0]).toMatchObject({ languages: ['ja'], model: { id: SENSE } });
    const chosen = { ...mine, ...chooseNativeRow(mine, rows, 'speaker', QWEN, here)! };
    expect(nativeChoiceRows(chosen, jaPair, ['speaker'], here)[0].model?.id).toBe(QWEN);
    expect(nativePicked(runSideHearing(chosen, jaPair, 'speaker'), 'ja', here)?.id).toBe(QWEN);
    // Both sides here are one engine's rows: the language heard has the one model, as ever.
    const together = settings({ coach: true, asrNativeByLanguage: { ja: 'qwen3-asr-0.6b-q8', zh: SENSE } });
    expect(nativeChoiceRows(together, jaPair, ['speaker'], here)[0].model?.id).toBe('qwen3-asr-0.6b-q8');
  });

  it('refuses a narrower model when another row on its engine needs Russian', () => {
    const s = settings();
    const rows = nativeChoiceRows(s, { source: 'ja', target: 'ru' }, legs, here);
    expect(nativeRowChoice(rows, 'speaker', SENSE, here)).toEqual({ ok: false, unheard: 'ru' });
    expect(chooseNativeRow(s, rows, 'speaker', SENSE, here)).toBeNull();
    expect(s.asrNativeByLanguage).toEqual({});
  });

  it('repairs the older auto-key form of the same Chinese-or-Cantonese conflict', () => {
    const s = settings({ speakBoth: true, asrNativeByLanguage: { auto: R2T2, yue: QWEN } });
    const rows = nativeChoiceRows(s, pair, legs, here);
    expect(rows.map((row) => row.model?.id)).toEqual([R2T2, QWEN]);
    const fix = nativeChoiceFix(s, rows, [QWEN, R2T2], here)!;
    expect(fix.patch.asrNativeByLanguage).toEqual({ auto: QWEN, zh: QWEN, yue: QWEN });
  });

  it('moves both rows when they share one persisted language key', () => {
    const s = settings();
    const p = { source: 'zh', target: 'zh' };
    const rows = nativeChoiceRows(s, p, legs, here);
    expect(nativeRowChoice(rows, 'speaker', 'apple-speech:zh', here)).toEqual({ ok: true, moves: ['participant'] });
    const patch = chooseNativeRow(s, rows, 'speaker', 'apple-speech:zh', here)!;
    expect(nativeChoiceRows({ ...s, ...patch }, p, legs, here).map((row) => row.model?.id)).toEqual(['apple-speech:zh', 'apple-speech:zh']);
  });

  it('moves every other same-engine row, including an implicit default', () => {
    const s = settings();
    const rows = nativeChoiceRows(s, { source: 'ja', target: 'ko' }, legs, here);
    expect(nativeRowChoice(rows, 'speaker', SENSE, here)).toEqual({ ok: true, moves: ['participant'] });
    expect(chooseNativeRow(s, rows, 'speaker', SENSE, here)?.asrNativeByLanguage).toEqual({ ja: SENSE, ko: SENSE });
  });

  it('best effort hears every finite language even when it cannot identify them itself', () => {
    const s = settings({ speakAlso: ['en'], asrDetectOther: true, theyAlso: ['zh'], theyLit: 'zh' });
    const rows = nativeChoiceRows(s, { source: 'zh', target: 'en' }, legs, here);
    expect(nativeRowChoice(rows, 'speaker', R2T2, here)).toEqual({ ok: true, moves: ['participant'] });
    expect(chooseNativeRow(s, rows, 'speaker', R2T2, here)?.asrNativeByLanguage).toEqual({ zh: R2T2, auto: R2T2 });
    const withCantonese = nativeChoiceRows({ ...s, theyAlso: ['yue'], theyLit: 'yue' }, { source: 'zh', target: 'en' }, legs, here);
    expect(nativeRowChoice(withCantonese, 'speaker', R2T2, here)).toEqual({ ok: false, unheard: 'yue' });
  });

  it('keeps two auto rows independent on different engines and joins them when switching to the same engine', () => {
    const p = { source: 'en', target: 'zh' };
    const s = settings({ speakAlso: ['zh'], asrDetectOther: true, asrNativeByLanguage: { en: X, auto: QWEN } });
    const rows = nativeChoiceRows(s, p, legs, here);
    expect(rows.map((row) => row.model?.id)).toEqual([X, QWEN]);
    expect(nativeRowChoice(rows, 'participant', SENSE, here)).toEqual({ ok: true, moves: [] });
    const patch = chooseNativeRow(s, rows, 'participant', SENSE, here)!;
    expect(nativeChoiceRows({ ...s, ...patch }, p, legs, here).map((row) => row.model?.id)).toEqual([X, SENSE]);
    expect(nativeRowChoice(rows, 'speaker', SENSE, here)).toEqual({ ok: true, moves: ['participant'] });
    expect(chooseNativeRow(s, rows, 'speaker', SENSE, here)?.asrNativeByLanguage).toEqual({ en: SENSE, auto: SENSE });
  });

  it('leaves Apple language assets and sherpa-onnx independent of audio.cpp', () => {
    const p = { source: 'ja', target: 'zh' };
    for (const other of ['apple-speech:zh', X]) {
      const s = settings({ asrNativeByLanguage: { ja: QWEN, zh: other } });
      const rows = nativeChoiceRows(s, p, legs, here);
      expect(nativeRowChoice(rows, 'speaker', R2T2, here)).toEqual({ ok: true, moves: [] });
      expect(chooseNativeRow(s, rows, 'speaker', R2T2, here)?.asrNativeByLanguage.zh).toBe(other);
    }
    const rows = nativeChoiceRows(settings(), p, legs, here);
    expect(nativeRowChoice(rows, 'speaker', 'apple-speech:ja', here)).toEqual({ ok: true, moves: [] });
  });

  it('requires every Apple asset for a finite detection row and rejects unbounded detection', () => {
    const s = settings({ speakAlso: ['yue'] });
    const rows = nativeChoiceRows(s, pair, legs, here);
    expect(nativeRowChoice(rows, 'speaker', 'apple-speech:zh', () => false)).toEqual({ ok: false, unheard: 'yue' });
    expect(nativeRowChoice(rows, 'speaker', 'apple-speech:zh', here)).toEqual({ ok: true, moves: [] });
    const any = nativeChoiceRows(settings({ asrDetectOther: true }), pair, legs, here);
    expect(nativeRowChoice(any, 'participant', 'apple-speech:yue', here)).toEqual({ ok: false, unheard: 'auto' });
    expect(nativeRowChoice(any, 'participant', QWEN, here).ok).toBe(true);
  });

  it('lets a model that hears the user’s own language be theirs: the others they speak step aside for it (fork)', () => {
    const s = settings({ speakAlso: ['en', 'YUE_HK'], asrDetectOther: true });
    const mixed = { source: 'ZH_cn', target: 'en' };
    const rows = nativeChoiceRows(s, mixed, ['speaker'], here);
    expect(rows[0].languages).toEqual(['zh', 'en', 'yue']);
    expect(nativeRowChoice(rows, 'speaker', R2T2, here)).toEqual({ ok: true, moves: [] });
    // Chosen, it hears their Chinese and English, and Cantonese is not asked of it.
    const chosen = { ...s, ...chooseNativeRow(s, rows, 'speaker', R2T2, here)! };
    expect(nativeChoiceRows(chosen, mixed, ['speaker'], here)[0]).toMatchObject({ languages: ['zh', 'en'], model: { id: R2T2 } });
    // Not one that misses their own language.
    expect(nativeRowChoice(nativeChoiceRows(s, { source: 'yue', target: 'en' }, ['speaker'], here), 'speaker', R2T2, here)).toEqual({ ok: false, unheard: 'yue' });
  });

  it('does not propose an unavailable model or a repair that still leaves a conflict', () => {
    const s = settings({ asrNativeByLanguage: { yue: QWEN, he: 'nemotron-asr-0.6b-q8' } });
    const rows = nativeChoiceRows(s, { source: 'yue', target: 'he' }, legs, here);
    expect(nativeChoiceFix(s, rows, [QWEN, 'nemotron-asr-0.6b-q8'], here)).toBeNull();
    const fix = nativeChoiceFix(s, rows, [QWEN, 'nemotron-asr-0.6b-q8', 'apple-speech:yue'], here);
    expect(fix?.model).toBe('apple-speech:yue');
  });

  it('every accepted catalogue choice leaves at most one model per downloaded engine', () => {
    for (const p of [pair, { source: 'ja', target: 'ru' }, { source: 'zh', target: 'en' }]) {
      for (const detecting of [false, true]) {
        const s = settings({ asrDetectOther: detecting, speakAlso: detecting ? [p.target] : [] });
        const rows = nativeChoiceRows(s, p, legs, here);
        for (const model of NATIVE_MODELS) for (const leg of legs) {
          const patch = chooseNativeRow(s, rows, leg, model.id, here);
          if (!patch) continue;
          const updated = { ...s, ...patch };
          const after = nativeChoiceRows(updated, p, legs, here);
          for (const row of after) expect(nativePicked(runSideHearing(updated, p, row.key), row.detecting ? 'auto' : row.languages[0], here)?.id).toBe(row.model?.id);
          const resolved = after.flatMap((row) => row.model && !isApple(row.model.id) ? [row.model.id] : []);
          for (const id of resolved) expect(resolved.filter((other) => nativeEngineOf(other) === nativeEngineOf(id)).every((other) => other === id)).toBe(true);
        }
      }
    }
  });
});

describe('chooseNative write guard', () => {
  it('rejects the whole change rather than partially applying an unsupported selection', () => {
    const pick = { model: QWEN, byLanguage: { zh: QWEN, yue: QWEN } };
    expect(nativeChoice(pick, R2T2, ['zh'], ['zh', 'yue'])).toEqual({ ok: false, unheard: 'yue' });
    expect(chooseNative(pick, R2T2, ['zh'], ['zh', 'yue'])).toEqual(pick);
  });

  it('moves detection rows in both directions, including best effort', () => {
    expect(chooseNative({ model: R2T2, detecting: true }, QWEN, ['auto'], ['ja', 'auto']).byLanguage).toEqual({ ja: QWEN, auto: QWEN });
    expect(chooseNative({ model: QWEN }, SENSE, ['ja'], ['ja', 'auto']).byLanguage).toEqual({ ja: SENSE, auto: SENSE });
    expect(chooseNative({ model: QWEN, bestEffort: true }, R2T2, ['ja'], ['ja', 'auto']).byLanguage).toEqual({ ja: R2T2, auto: R2T2 });
    expect(nativeChoice({ model: QWEN, bestEffort: true, autoLanguages: ['zh', 'yue'] }, R2T2, ['auto'])).toEqual({ ok: false, unheard: 'yue' });
  });
});
