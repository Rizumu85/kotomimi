/**
 * Fork: the ways a leg is heard behave alike. A fix made on one path was missing on another, and nobody noticed for
 * weeks (an audit, 2026-11-05): the phone's door dropped the dictionary's words, a lent model was told a language
 * where this computer's engine was asked to detect it, another Kotomimi cut sentences by another rule. This test
 * holds what can be held from here:
 *
 * - every field this computer puts in a stretch it sends a device (`readWhole`) is read by each device's door
 *   (`Share.kt`; the iPad's `Lending.swift` where the branch that has it is checked out);
 * - the dictionary's words reach every recognizer that takes them, whichever place hears.
 *
 * A field or a path that differs on purpose is named below with its reason.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SessionContext } from '../../lib/contract/adapter';
import { LAN_PIPELINE } from '../../lib/lan/protocol';
import { buildLocalAI, LOCALAI_DEFAULTS, type LocalAIConfig, type LocalAISettings } from './localai';
import type { LocalAIModel } from './localaiModels';
import { SHARED } from './testing';

const ROOT = resolve(__dirname, '../../..');
const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8');

/** The form fields `readWhole` writes: `field('name', …)`. */
function fieldsSent(): string[] {
  const source = read('electron/native-engine.js');
  const body = source.slice(source.indexOf('function readWhole('), source.indexOf('function readWhole(') + 2000);
  return [...body.matchAll(/field\('([a-z_]+)'/g)].map((m) => m[1]);
}

/** Read by a door from its own model, not from the form: the device lends the model it lends. */
const NOT_FORWARDED = new Set(['model']);

describe('what this computer sends a lent device', () => {
  it('is a form whose fields are known here', () => {
    expect(fieldsSent()).toEqual(['model', 'language', 'text']);
  });

  it('is read whole by the phone\'s door', () => {
    const door = read('android/app/src/main/kotlin/io/github/rizumu85/kotomimi/node/Share.kt');
    for (const field of fieldsSent().filter((f) => !NOT_FORWARDED.has(f))) expect(door, `Share.kt reads no "${field}"`).toContain(`form.fields["${field}"]`);
  });

  // The iPad app lives on its own branch: checked where that is checked out.
  const ipad = 'ios/KotomimiNode/Door/Lending.swift';
  it.skipIf(!existsSync(resolve(ROOT, ipad)))('is read whole by the iPad\'s door', () => {
    const door = read(ipad);
    for (const field of fieldsSent().filter((f) => !NOT_FORWARDED.has(f))) expect(door, `Lending.swift reads no "${field}"`).toContain(`form.fields["${field}"]`);
  });
});

describe('the settings that decide how a leg is heard', () => {
  // Read in one place (`hearingPlan.ts`), so that a place that hears cannot take them its own way.
  it('are read by the hearing plan only', () => {
    const dir = resolve(ROOT, 'src/providers/openai');
    const readers = readdirSync(dir)
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && f !== 'hearingPlan.ts')
      .filter((f) => /s\.vad[A-Z]/.test(readFileSync(resolve(dir, f), 'utf8')));
    expect(readers).toEqual([]);
  });

  it('give each model its limits in one place', () => {
    for (const file of ['src/providers/openai/pipeline.ts', 'src/providers/openai/localai.ts']) {
      expect(read(file), `${file} looks a model's limits up itself`).not.toMatch(/NATIVE_MODELS\.find\(.*?\)\??\.limits/);
    }
  });
});

describe('a stretch heard while it is spoken on an iPad', () => {
  const ipad = 'ios/KotomimiNode/Door/Lending.swift';
  const ipadPair = 'ios/KotomimiNode/Hearing/SpeechPairSelection.swift';

  it.skipIf(!existsSync(resolve(ROOT, ipad)))('is told everything this computer sends, by the names it sends them', () => {
    const client = read('electron/remote-engine.js');
    const opened = client.slice(client.indexOf("type: 'open'"), client.indexOf("type: 'open'") + 200);
    const door = read(ipad);
    for (const field of ['language', 'also', 'prefer', 'sampleRate']) {
      expect(opened, `remote-engine.js sends no "${field}"`).toContain(field);
      expect(door, `Lending.swift reads no "${field}"`).toContain(`open["${field}"]`);
    }
  });

  // The Mac and the iPad choose between two languages alike: the same file, copied.
  it.skipIf(!existsSync(resolve(ROOT, ipadPair)))('chooses between two languages as the Mac does', () => {
    expect(read(ipadPair)).toBe(read('native/apple-speech/SpeechPairSelection.swift'));
  });
});

describe('the dictionary\'s words', () => {
  const SPEAKER: SessionContext = { direction: { source: 'zh-CN', target: 'ja' }, speech: false, turns: 'auto' };
  const glossary = { entries: [{ id: 'a', source: '悠米露', aliases: [] }, { id: 'b', source: 'Jackal, ジャカル', aliases: [] }] };
  const WORDS = ['悠米露', 'Jackal', 'ジャカル'];
  const KOTOMIMI: LocalAIModel[] = [{ id: LAN_PIPELINE, kind: 'pipeline', host: 'kotomimi' }, { id: 'qwen3-asr-1.7b-q8', kind: 'asr', host: 'kotomimi', languages: ['zh', 'ja'] }];
  const build = (patch: Partial<LocalAISettings>, models: LocalAIModel[] = []): LocalAIConfig => {
    const config = buildLocalAI(SPEAKER, { ...LOCALAI_DEFAULTS, model: '', ...patch }, { ...SHARED, glossary, reversed: () => false, models });
    if ('refused' in config) throw new Error(config.refused);
    return config;
  };

  it('reach a lent device\'s recognizer', () => {
    const phone = build({ asrVia: 'api', asrApiBaseUrl: 'http://192.168.4.28:8792/v1', asrApiModel: 'qwen3-asr-1.7b-q8', asrApiNeedsKey: false, translateAt: 'api', translateModel: 'x', translateBaseUrl: 'http://192.168.4.28:8792/v1', translateNeedsKey: false });
    expect(phone.device?.api?.hints).toEqual(WORDS);
  });

  it('reach another Kotomimi\'s recognizer', () => {
    const there = build({ asrVia: 'server' }, KOTOMIMI);
    expect(there.transcription).toMatchObject({ keywords: WORDS });
  });
});
