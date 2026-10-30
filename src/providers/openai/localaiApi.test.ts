/**
 * Fork: speech recognition by an API — the third place the stage can run.
 * This computer cuts the sentences and uploads each one (`apiAsr.ts`, tested
 * beside it); here, what the provider makes of the choice.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SessionContext } from '../../lib/contract/adapter';
import type { CheckContext } from '../../lib/provider/types';
import { buildLocalAI, createLocalAICheck, LOCALAI_DEFAULTS, localaiCredentials, type LocalAIConfig, type LocalAISettings } from './localai';
import { needsServer } from './localaiDevice';
import type { LocalAIModel } from './localaiModels';
import { SHARED } from './testing';

const SPEAKER: SessionContext = { direction: { source: 'zh-CN', target: 'ja' }, speech: false, turns: 'auto' };
const shared = { ...SHARED, reversed: (d: SessionContext['direction']) => d.source === 'ja', models: [] as LocalAIModel[] };
const API: Partial<LocalAISettings> = { asrVia: 'api', asrApiBaseUrl: 'https://api.example.com/v1/', asrApiModel: 'whisper-large-v3', translateAt: 'api', translateModel: 'gpt-x', translateBaseUrl: 'https://api.example.com/v1', translateNeedsKey: false };
const settings = (patch: Partial<LocalAISettings> = {}): LocalAISettings => ({ ...LOCALAI_DEFAULTS, ...patch });
const noAuth = { session: null } as never;

function configFor(context: SessionContext, patch: Partial<LocalAISettings>): LocalAIConfig {
  const config = buildLocalAI(context, settings(patch), shared);
  if ('refused' in config) throw new Error(config.refused);
  return config;
}

describe('recognition by an API: where the stages then run', () => {
  it('needs the other device for nothing while no stage is placed on it', () => {
    expect(needsServer(settings(API))).toBe(false);
    // A translation left on the other device still does.
    expect(needsServer(settings({ ...API, translateAt: 'server' }))).toBe(true);
  });

  it('asks for the API\'s key while it wants one, and for no address of another device', () => {
    expect(localaiCredentials.fields(settings(API)).map((f) => [f.key, f.secret])).toEqual([['asrKey', true]]);
    expect(localaiCredentials.fields(settings({ ...API, asrApiNeedsKey: false }))).toEqual([]);
    expect(localaiCredentials.read({ asrKey: ' k-1 ' }, noAuth)).toEqual({ apiKey: '', endpoint: '', asrKey: 'k-1' });
    expect(localaiCredentials.read({ asrKey: '  ' }, noAuth)).toHaveProperty('missing');
  });
});

describe('recognition by an API: the run it builds', () => {
  it('hears on this computer\'s side of the wire — its own turn detection — with the API as the recognizer', () => {
    const c = configFor(SPEAKER, { ...API, vadMinSilenceDuration: 0.8 });
    expect(c.device).toMatchObject({
      modelId: 'whisper-large-v3',
      streaming: false,
      api: { baseUrl: 'https://api.example.com/v1/', model: 'whisper-large-v3', key: 'asrKey' },
      vad: { minSilenceDuration: 0.8 },
    });
    // No Realtime model, and the text model answers what is heard.
    expect(c.model).toBe('');
    expect(c.stages?.speech).toMatchObject({ kind: 'translate', model: 'gpt-x' });
    expect(configFor(SPEAKER, { ...API, asrApiNeedsKey: false }).device?.api).toEqual({ baseUrl: 'https://api.example.com/v1/', model: 'whisper-large-v3' });
  });

  it('takes a language to detect, which this computer\'s own recognizers do not', () => {
    const c = configFor({ ...SPEAKER, direction: { source: 'auto', target: 'ja' } }, API);
    expect(c.device?.api?.model).toBe('whisper-large-v3');
  });

  it('translates either spoken language and adds feedback only to the target language', () => {
    const patch = { ...API, speakBoth: true, coach: true, coachAt: 'api' as const, coachBaseUrl: 'https://feedback.example.com/v1', coachModel: 'feedback-model' };
    const config = configFor(SPEAKER, patch);
    expect(config.device?.api?.model).toBe('whisper-large-v3');
    expect(config.stages).toMatchObject({
      heard: 'auto',
      speech: { kind: 'translate', model: 'gpt-x' },
      typed: { kind: 'translate', model: 'gpt-x' },
      back: { language: 'ja', own: 'zh-CN', stage: { kind: 'translate', language: 'zh-CN' } },
      feedback: { language: 'ja', stage: { kind: 'coach', model: 'feedback-model', language: 'zh-CN' } },
    });
    expect(config.stages?.typed).toBe(config.stages?.speech);
    expect(config.stages).not.toHaveProperty('requiresLanguage');
    const participant = configFor({ ...SPEAKER, direction: { source: 'ja', target: 'zh-CN' } }, patch);
    expect(participant.stages?.speech?.kind).toBe('translate');
    expect(participant.stages).not.toHaveProperty('feedback');
  });

  it('requires both the translator and feedback model when bilingual speech is enabled', async () => {
    const patch = { ...API, speakBoth: true, coach: true, coachAt: 'api' as const, coachBaseUrl: 'https://feedback.example.com/v1', coachModel: 'feedback-model' };
    const check = createLocalAICheck({ fetch: async () => new Response('{}', { status: 404 }) });
    const context: CheckContext = { pair: SPEAKER.direction, legs: ['speaker'] };
    for (const [missing, code] of [
      [{ translateModel: '' }, 'translate_unnamed'],
      [{ coachModel: '' }, 'coach_unnamed'],
    ] as const) {
      const s = settings({ ...patch, ...missing });
      expect(buildLocalAI(SPEAKER, s, shared)).toMatchObject({ code });
      expect(await check({ apiKey: '', endpoint: '' }, s, context)).toMatchObject({ ok: false, code });
    }
    expect(await check({ apiKey: '', endpoint: '' }, settings(patch), context)).toMatchObject({ ok: true });
    // With bilingual speech off, coaching still accepts a missing translator for typed text.
    expect(configFor(SPEAKER, { ...patch, speakBoth: false, translateModel: '' }).stages).toMatchObject({ speech: { kind: 'coach' }, typed: null, heard: 'ja' });
  });

  it('is refused while the API or its model is not named', () => {
    expect(buildLocalAI(SPEAKER, settings({ ...API, asrApiModel: ' ' }), shared)).toMatchObject({ code: 'asr_unnamed' });
    expect(buildLocalAI(SPEAKER, settings({ ...API, asrApiBaseUrl: '' }), shared)).toMatchObject({ code: 'asr_unnamed' });
  });
});

describe('recognition by an API: the check', () => {
  const ctx: CheckContext = { pair: { source: 'zh-CN', target: 'ja' }, legs: ['speaker'], signal: undefined };
  const K = { apiKey: '', endpoint: '', asrKey: 'k-1' };

  it('asks the API for its models with its key, and offers them for the model field alone', async () => {
    const fetch = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ data: [{ id: 'whisper-large-v3' }, { id: 'gpt-x' }] }), { status: String(url).includes('example') ? 200 : 404 }));
    const result = await createLocalAICheck({ fetch: fetch as unknown as typeof globalThis.fetch })(K, settings({ ...API, translateBaseUrl: 'https://api.example.com/v1', translateNeedsKey: false }), ctx);
    expect(result.ok).toBe(true);
    const asked = fetch.mock.calls.map(([url, init]) => [String(url), (init?.headers as Record<string, string> | undefined)?.Authorization]);
    expect(asked).toContainEqual(['https://api.example.com/v1/models', 'Bearer k-1']);
    const models = (result.ok ? result.models : []) as LocalAIModel[];
    expect(models.filter((m) => m.from === 'asr')).toEqual([{ id: 'whisper-large-v3', kind: 'asr', from: 'asr' }, { id: 'gpt-x', kind: 'asr', from: 'asr' }]);
  });

  it('is refused by the API\'s 401: the key is wrong', async () => {
    const fetch = vi.fn(async () => new Response('{}', { status: 401 }));
    const result = await createLocalAICheck({ fetch: fetch as unknown as typeof globalThis.fetch })(K, settings({ ...API, translateAt: 'device' }), ctx);
    expect(result).toMatchObject({ ok: false, code: 'api_key_refused' });
  });
});
