import { beforeEach, describe, expect, it } from 'vitest';
import type { SessionContext } from '../../lib/contract/adapter';
import type { CheckContext } from '../../lib/provider/types';
import { useModelStore } from '../../stores/modelStore';
import { buildLocalAI, createLocalAICheck, LOCALAI_DEFAULTS, localaiCredentials, localaiProvider, type LocalAISettings } from './localai';
import { PLACES } from './localaiDevice';
import { SHARED } from './testing';

/**
 * The card under the stages says "ready" from the check alone, and a start
 * builds each leg afterwards: a combination the check passes and a build
 * refuses is a "ready" the start then contradicts.
 */

const settings = (patch: Partial<LocalAISettings> = {}): LocalAISettings => ({ ...LOCALAI_DEFAULTS, ...patch });
const PAIR = { source: 'zh-CN', target: 'en' };
const DIRECTION = { speaker: PAIR, participant: { source: 'en', target: 'zh-CN' } };
const shared = { ...SHARED, reversed: (d: SessionContext['direction']) => d.source === 'en' };

/** Three kinds of other device: another Kotomimi (recognizers and translation models, no chat model), a LocalAI, and a server that says nothing of its models. */
const SERVERS = {
  kotomimi: {
    models: { data: [{ id: 'kotomimi', owned_by: 'kotomimi' }, { id: 'sensevoice-int8', owned_by: 'kotomimi' }, { id: 'opus-mt-zh-en', owned_by: 'kotomimi' }] },
    capabilities: { data: [{ id: 'kotomimi', capabilities: null }, { id: 'sensevoice-int8', capabilities: ['transcript'] }, { id: 'opus-mt-zh-en', capabilities: ['translate'] }] },
  },
  localai: {
    models: { data: [{ id: 'gpt-realtime' }, { id: 'whisper' }, { id: 'qwen3' }] },
    capabilities: { data: [{ id: 'gpt-realtime', capabilities: [] }, { id: 'whisper', capabilities: ['transcript'] }, { id: 'qwen3', capabilities: ['chat'] }] },
  },
  plain: { models: { data: [{ id: 'some-model' }] }, capabilities: null },
} as const;

function serverFetch(kind: keyof typeof SERVERS): typeof fetch {
  return (async (url: RequestInfo | URL) => {
    const text = String(url);
    if (text.startsWith('http://192.168.1.10:8790/v1/models')) {
      const { models, capabilities } = SERVERS[kind];
      if (!text.endsWith('/capabilities')) return new Response(JSON.stringify(models), { status: 200 });
      return capabilities ? new Response(JSON.stringify(capabilities), { status: 200 }) : new Response('', { status: 404 });
    }
    // Every API lists one chat model.
    return new Response(JSON.stringify({ data: [{ id: 'gpt-4o' }] }), { status: 200 });
  }) as typeof fetch;
}

beforeEach(() => {
  useModelStore.setState({
    initialized: true, webgpuAvailable: true, deviceFeatures: [],
    modelStatuses: { 'sensevoice-int8': 'downloaded', 'opus-mt-zh-en': 'downloaded', 'opus-mt-en-zh': 'downloaded', 'qwen3-0.6b-translation': 'downloaded' },
  });
});

describe('the check says ready only to what a start can build', () => {
  it('for every place of every stage, filled in or left blank, on every kind of other device', async () => {
    const contradictions: string[] = [];
    for (const server of Object.keys(SERVERS) as Array<keyof typeof SERVERS>) {
      // What the other device lists, as a start that got past the check would have it.
      const everyStageThere = await createLocalAICheck({ fetch: serverFetch(server) })({ apiKey: '', endpoint: 'ws://192.168.1.10:8790/v1/realtime' }, settings(), { pair: PAIR, legs: ['speaker'], signal: new AbortController().signal });
      const listed = everyStageThere.ok ? everyStageThere.models ?? [] : [];
      for (const asrVia of PLACES) for (const translateAt of PLACES) for (const coachAt of [null, ...PLACES]) for (const filled of [false, true]) {
        const s = settings({
          asrVia, translateAt, coach: coachAt !== null, coachAt: coachAt ?? 'server',
          asrApiBaseUrl: filled ? 'https://api.example.com/v1' : '', asrApiModel: filled ? 'whisper-1' : '',
          translateBaseUrl: filled ? 'https://api.example.com/v1' : '', translateModel: filled ? 'gpt-4o' : '',
          coachBaseUrl: filled ? 'https://api.example.com/v1' : '', coachModel: filled ? 'gpt-4o' : '',
        });
        const values = Object.fromEntries(localaiCredentials.fields(s).map((f) => [f.key, f.key === 'endpoint' ? '192.168.1.10:8790' : 'k']));
        const credentials = localaiCredentials.read(values, { signedIn: false, getToken: async () => null });
        if ('missing' in credentials) throw new Error(credentials.missing);
        for (const legs of [['speaker'], ['speaker', 'participant']] as const) {
          const ctx: CheckContext = { pair: PAIR, legs, signal: new AbortController().signal };
          const checked = await createLocalAICheck({ fetch: serverFetch(server) })(credentials, s, ctx);
          // A start builds the legs in order, and stops at the first refusal.
          const refused = legs
            .map((leg) => buildLocalAI({ direction: DIRECTION[leg], speech: false, turns: 'auto' }, s, { ...shared, models: checked.ok ? checked.models ?? [] : listed }))
            .find((built) => 'refused' in built);
          const where = `${server}: hears ${asrVia}, translates ${translateAt}, feedback ${coachAt ?? 'off'}, ${filled ? 'filled' : 'blank'}, ${legs.join('+')}`;
          if (!refused || !('refused' in refused)) continue;
          if (checked.ok) contradictions.push(`${where}: ready, then "${refused.refused}"`);
          // A refusal is the start's own, in its words: the card shows what a start would.
          else if (checked.code === refused.code && checked.reason !== refused.refused) contradictions.push(`${where}: "${checked.reason}" for "${refused.refused}"`);
        }
      }
    }
    expect(contradictions).toEqual([]);
  });

  it('keeps what the other device lists in a refusal that a pick from that list would answer', async () => {
    // A server that says nothing of its models' kinds: nothing is translated on a guess, and the model is picked from its list.
    const s = settings({ asrVia: 'device', translateAt: 'server' });
    const checked = await createLocalAICheck({ fetch: serverFetch('plain') })({ apiKey: '', endpoint: 'ws://192.168.1.10:8790/v1/realtime' }, s, { pair: PAIR, legs: ['speaker'], signal: new AbortController().signal });
    expect(checked).toMatchObject({ ok: false, models: [{ id: 'some-model' }] });
  });

  it('is asked again when a model or an address a start needs is edited', () => {
    for (const field of ['model', 'asrApiBaseUrl', 'asrApiModel', 'translateBaseUrl', 'translateModel', 'translateServerModel', 'coachBaseUrl', 'coachModel', 'coachServerModel'] as const) {
      expect(localaiProvider.checkReads).toContain(field);
    }
  });
});
