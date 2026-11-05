/**
 * Fork: translation and feedback behave alike wherever they run — this computer's engines, a phone, an iPad, another
 * Kotomimi. An audit (2026-11-05) found fixes made on one path only: another Kotomimi answered Traditional Chinese
 * in Simplified, told a detected leg the wrong language, translated each sentence without the one before, and was
 * not warmed; feedback here had no length cap where every device had one. The request each path words is held
 * alike by the tests beside each (`nativeShare.test.ts`, `lan.test.ts`, `localaiKotomimi.test.ts`); this test holds
 * what crosses into the devices' own code:
 *
 * - every option this computer sends a model is read by each device's door (`Chat.kt`; the iPad's `Lending.swift`
 *   where the branch that has it is checked out);
 * - no path lets an answer run longer than the devices do;
 * - every text stage on another device is given its time, and loaded as the run starts.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SessionContext } from '../../lib/contract/adapter';
import { LAN_PIPELINE } from '../../lib/lan/protocol';
import { buildLocalAI, LOCALAI_DEFAULTS, type LocalAIConfig, type LocalAISettings } from './localai';
import type { LocalAIModel } from './localaiModels';
import { NATIVE_COACH_EXTRA } from './nativeCoaches';
import { NATIVE_TRANSLATORS, translatorRequest } from './nativeTranslators';
import type { TextStage } from './pipeline';
import { SHARED } from './testing';

const ROOT = resolve(__dirname, '../../..');
const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8');
const PHONE = 'android/app/src/main/kotlin/io/github/rizumu85/kotomimi/node/Chat.kt';
const IPAD = 'ios/KotomimiNode/Door/Lending.swift';

/** Every request option this computer sends a native model, translation and feedback. */
const extras = [
  ...NATIVE_TRANSLATORS.flatMap((m) => [translatorRequest(m, 'ja', 'zh-TW').extra, translatorRequest(m, 'auto', 'en').extra]),
  NATIVE_COACH_EXTRA,
];
const keys = [...new Set(extras.flatMap((extra) => Object.keys(extra)))];

describe('what this computer asks a model', () => {
  it('is read whole by the phone\'s door', () => {
    const door = read(PHONE);
    for (const key of keys) expect(door, `Chat.kt reads no "${key}"`).toContain(`"${key}"`);
  });

  it.skipIf(!existsSync(resolve(ROOT, IPAD)))('is read whole by the iPad\'s door', () => {
    const door = read(IPAD);
    for (const key of keys) expect(door, `Lending.swift reads no "${key}"`).toContain(`json["${key}"]`);
  });

  it('never lets an answer run longer than a device lets it', () => {
    const caps = [
      Number(/MOST_TOKENS = (\d+)/.exec(read('src/lib/lan/coach.ts'))?.[1]),
      Number(/MOST_TOKENS = (\d+)/.exec(read(PHONE))?.[1]),
    ];
    if (existsSync(resolve(ROOT, IPAD))) caps.push(Number(/min\(max\(most \?\? (\d+)/.exec(read(IPAD))?.[1]));
    for (const cap of caps) expect(cap).toBeGreaterThan(0);
    for (const extra of extras) {
      expect(extra.max_tokens, 'every native request names its length').toBeTypeOf('number');
      for (const cap of caps) expect(extra.max_tokens as number).toBeLessThanOrEqual(cap);
    }
  });
});

describe('a text stage on another device', () => {
  const SPEAKER: SessionContext = { direction: { source: 'zh-CN', target: 'ja' }, speech: false, turns: 'auto' };
  const KOTOMIMI: LocalAIModel[] = [{ id: LAN_PIPELINE, kind: 'pipeline', host: 'kotomimi' }, { id: 'qwen3-asr-1.7b-q8', kind: 'asr', host: 'kotomimi', languages: ['zh', 'ja'] }];
  const build = (patch: Partial<LocalAISettings>, models: LocalAIModel[] = []): LocalAIConfig => {
    const config = buildLocalAI(SPEAKER, { ...LOCALAI_DEFAULTS, model: '', ...patch }, { ...SHARED, reversed: () => false, models });
    if ('refused' in config) throw new Error(config.refused);
    return config;
  };

  it('is given the time a load takes, and loaded as the run starts, on another Kotomimi as on a phone', () => {
    const stagesOf = (c: LocalAIConfig) => [c.stages?.speech, c.stages?.typed, c.stages?.back?.stage, c.stages?.feedback?.stage].filter((x): x is TextStage => !!x);
    const translates = build({ asrVia: 'server' }, KOTOMIMI);
    const coaches = build({ asrVia: 'server', coach: true, coachAt: 'server', coachServerModel: 'gemma-4-e2b', model: LAN_PIPELINE }, KOTOMIMI);
    for (const stage of [...stagesOf(translates), ...stagesOf(coaches)]) expect(stage, `${stage.kind} on another Kotomimi`).toMatchObject({ loads: true });
    expect(stagesOf(coaches).some((stage) => stage.kind === 'coach')).toBe(true);
    // A phone's are warmed before the session (`warmPhones`) and given the same time (`phone`): localaiPhoneText.test.ts.
  });
});
