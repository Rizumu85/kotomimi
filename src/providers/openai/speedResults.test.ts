import { describe, expect, it } from 'vitest';
import { LOCALAI_DEFAULTS, type LocalAISettings } from './localai';
import { clipFor, reportStands, stageResult, stageSig, summarize } from './speedResults';
import type { LegTiming } from './speedTest';

const pair = { source: 'zh-CN', target: 'ja' };
const settings: LocalAISettings = { ...LOCALAI_DEFAULTS, asrVia: 'device', asrHere: 'native', asrNativeModel: 'qwen3-asr-1.7b-q8' };
const leg = (over: Partial<LegTiming>): LegTiming => ({ leg: 'participant', answeredBy: 'translate', speechMs: 8000, hearMs: 1800, answerMs: [900], sentences: 1, totalMs: 2700, ...over });

describe('summarize', () => {
  const sig = (stage: string) => stage;

  it('keeps up when the text and the answers come within the speech they follow', () => {
    const report = summarize([leg({})], sig, 1);
    expect(report.stages.hear).toEqual({ ms: 1800, slow: false, sig: 'hear' });
    expect(report.stages.translate).toEqual({ ms: 900, slow: false, sig: 'translate' });
    expect(report.legs).toEqual([{ leg: 'participant', answeredBy: 'translate', ms: 2700 }]);
  });

  it('falls behind when the text comes later than the speech lasted, plus a pause', () => {
    expect(summarize([leg({ hearMs: 9600 })], sig, 1).stages.hear?.slow).toBe(true);
    expect(summarize([leg({ hearMs: 9400 })], sig, 1).stages.hear?.slow).toBe(false);
    expect(summarize([leg({ hearMs: null })], sig, 1).stages.hear).toMatchObject({ ms: null, slow: true });
  });

  it('falls behind when an answer takes longer than its sentence took to say', () => {
    expect(summarize([leg({ answerMs: [4500], sentences: 2 })], sig, 1).stages.translate?.slow).toBe(true);
    expect(summarize([leg({ answerMs: [3500], sentences: 2 })], sig, 1).stages.translate?.slow).toBe(false);
  });

  it('reads each stage as its slowest leg found it, the feedback apart from the translation', () => {
    const report = summarize([leg({ leg: 'speaker', answeredBy: 'coach', hearMs: 2500, answerMs: [1600] }), leg({})], sig, 1);
    expect(report.stages.hear?.ms).toBe(2500);
    expect(report.stages.coach?.ms).toBe(1600);
    expect(report.stages.translate?.ms).toBe(900);
  });
});

describe('what a result stands for', () => {
  const sigs = (s: LocalAISettings) => (stage: 'hear' | 'translate' | 'coach') => stageSig(stage, s, '', pair, ['participant']);

  it('goes with a change to its own stage, and not with one to another', () => {
    const report = summarize([leg({})], sigs(settings), 1);
    const otherRecognizer = { ...settings, asrNativeModel: 'qwen3-asr-0.6b-q8' };
    expect(stageResult(report, 'hear', sigs(otherRecognizer)('hear'))).toBeNull();
    expect(stageResult(report, 'translate', sigs(otherRecognizer)('translate'))).toEqual({ ms: 900, slow: false });
    expect(reportStands(report, sigs(otherRecognizer))).toBe(false);
    expect(reportStands(report, sigs(settings))).toBe(true);
  });

  it('stays through a change that does not decide the speed', () => {
    const report = summarize([leg({})], sigs(settings), 1);
    expect(reportStands(report, sigs({ ...settings, coachPrompt: 'Be kind.' }))).toBe(true);
  });

  it('goes with the languages', () => {
    const report = summarize([leg({})], sigs(settings), 1);
    expect(stageResult(report, 'hear', stageSig('hear', settings, '', { source: 'en', target: 'ja' }, ['participant']))).toBeNull();
  });
});

describe('clipFor', () => {
  it('finds a language by its base, a region or a script being the same speech', () => {
    expect(clipFor('ja')?.file).toBe('ja.ogg');
    expect(clipFor('zh-TW')?.file).toBe('zh.ogg');
    expect(clipFor('pt-PT')?.file).toBe('pt.ogg');
    expect(clipFor('nb')?.file).toBe('no.ogg');
    expect(clipFor('xx')).toBeNull();
  });
});
