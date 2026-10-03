/**
 * Fork: LocalAI Realtime — a self-hosted server that speaks OpenAI's GA
 * Realtime protocol (LocalAI's `/v1/realtime`), reached directly over the
 * LAN. It replaces the retired "OpenAI Compatible (Legacy Realtime)"
 * provider and the beta→GA proxy that provider needed. A second provider in
 * this folder, as Kizuna Soniox is in Soniox's: it runs OpenAI Realtime's
 * own adapter, so every fix to that adapter is this provider's too.
 *
 * What differs from OpenAI, each verified against a live LocalAI
 * (2026-10-02, pipeline model `gpt-realtime`):
 *
 * - **The endpoint is the credential.** No key: LocalAI's handshake echoes
 *   no subprotocol, and a browser fails a socket whose offered subprotocols
 *   go unanswered, so none is offered (`wire.ts` `realtimeProtocols`). A
 *   server that does take a key (another Kotomimi) is given it the GA way.
 * - **The model is the user's own word.** The server's model list only
 *   suggests; what is typed is what the socket's `?model=` carries. It is
 *   never swapped for an OpenAI default.
 * - **Text only.** With `output_modalities: ['audio']` the pipeline errors
 *   and never sends `response.done`, which would leave the leg busy.
 * - **No drift anchor** (`anchor: false`). LocalAI answers the out-of-band
 *   `response.create` as a real turn — a model call per anchor.
 * - **A manual commit answers itself** (`commitAnswers`). LocalAI
 *   transcribes a commit and then responds; a `response.create` sent right
 *   after the commit cancels the transcription and gets a reply to nothing.
 * - **The transcription model is the server's**, unless one of its own is
 *   chosen: OpenAI's names (`gpt-4o-mini-transcribe`) load nothing there.
 *   The language still goes up: a backend may refuse to guess it.
 *
 * **Stages chosen apart** (`pipeline.ts`). Something hears — it detects
 * turns and writes the source text: the Realtime server, or this computer's
 * own recognizer (`localaiDevice.ts`). What answers that text is a second
 * choice: the server's own pipeline, inside the same session; a text model
 * anywhere that speaks chat completions — another machine's LocalAI, Ollama
 * or LM Studio on this one, a hosted API; or a translation model this
 * computer runs itself. And a speaker practising the other side's language
 * can have their speech answered with grammar feedback instead of a
 * translation, by a model of its own again. LocalAI ignores
 * `create_response: false` but honours a transcription session
 * (`session.type: 'transcription'`), which is what a leg with a stage of its
 * own opens. With every stage on this computer no server is asked for at
 * all.
 *
 * **Another Kotomimi as the server** (`src/lib/lan`). An app sharing its own
 * models answers the same wire, with three differences it declares in its
 * model list: it only transcribes inside the socket, so its pipeline's name
 * is asked over chat for the translation; its translation models are no chat
 * models and are told the pair; and it takes any of its recognizers in a
 * transcription session.
 */
import type { SessionContext } from '../../lib/contract/adapter';
import { realClock, type Clock } from '../../lib/contract/clock';
import type { LegName } from '../../lib/conversation/types';
import type { Selections } from '../../lib/local-inference/selection/types';
import { buildDefaultLocalPrompt } from '../../lib/local-inference/prompts';
import { boundedFetch } from '../../lib/provider/boundedFetch';
import type { CheckContext, CheckResult, CredentialField, CredentialsMissing, MigrationInputs, Provider, ProviderRefusal, SharedSettings } from '../../lib/provider/types';
import { admitLocalInference, type LocalInferenceConfig } from '../localInference/config';
import { LOCAL_INFERENCE_DEFAULTS } from '../localInference/settings';
import { CHECK_TIMEOUT_MS } from './check';
import { isKotomimiServer, kindOf, KOTOMIMI_HOST, modelsFor, type LocalAIModel, type LocalAIModelKind } from './localaiModels';
import { coachPrompt } from './coachPrompt';
import { buildRealtime } from './config';
import { deviceChoices, deviceLanguage, deviceModelFor, deviceModelsLoaded, deviceNeeds, deviceRecognizer, deviceTranslator, needsServer, ownCoachModel, translateViaOf, usesTranslateModel, watchDeviceModels } from './localaiDevice';
import { LocalAIEngine, LocalAIEngineSummary, LocalAITurnDetectionControls, LocalAITurnDetectionHelp, LocalAITurnDetectionSummary } from './LocalAIEngine';
import { KotomimiIcon } from './LocalAIIcon';
import { LocalAISettingsView } from './LocalAISettings';
import { createPipelineAdapter, type AnswerStage, type DeviceHearing, type PipelineConfig, type PipelineCredentials, type StageKey, type Stages, type TextStage } from './pipeline';
import {
  isRealtimeModelId, migrateRealtimeSettings, REALTIME_DEFAULTS, REALTIME_LANGUAGES, REALTIME_LEGACY_KEYS, realtimeLanguages,
  type RealtimeSettings,
} from './settings';
import { httpBaseOf } from './textModel';
import { normalizeTranscriptionLanguage, type TranscriptionHint } from './transcription';

/** What hears: the Realtime server, or this computer's own recognizer. */
export const ASR_VIAS = ['server', 'device'] as const;
export type AsrVia = (typeof ASR_VIAS)[number];

/** What answers speech in real time: the Realtime server's own pipeline, a text model chosen apart, or a translation model on this computer. */
export const TRANSLATE_VIAS = ['server', 'model', 'device'] as const;
export type TranslateVia = (typeof TRANSLATE_VIAS)[number];

export interface LocalAISettings extends RealtimeSettings {
  asrVia: AsrVia;
  /** The server's own transcription model; blank keeps the one its pipeline names. */
  asrModel: string;
  /** As stored; `translateViaOf` says what runs. */
  translateVia: TranslateVia;
  /** The translation text model's OpenAI-style base URL (`http://localhost:11434/v1`); blank: the Realtime server's own. */
  translateBaseUrl: string;
  /** Answers speech when `translateVia` is `model`, and typed text whenever the speaker is coached. */
  translateModel: string;
  /** The translation endpoint wants an API key: a credential field appears. */
  translateNeedsKey: boolean;
  /** The speaker practises the other side's language: their speech gets grammar feedback, not a translation. */
  coach: boolean;
  coachBaseUrl: string;
  /** Blank: the translation text model gives the feedback too. */
  coachModel: string;
  coachNeedsKey: boolean;
  /** The user's own feedback instructions; blank: chosen by the two languages (`coachPrompt.ts`). `{{SPOKEN}}` and `{{NATIVE}}` are filled in. */
  coachPrompt: string;
  /** The Realtime server wants an access key: a credential field appears. */
  serverNeedsKey: boolean;
  /** This computer's own models, picked per stage of a direction as Local Inference picks them; a blank pick is the best one downloaded. */
  selections: Selections;
  /** This computer's turn detection, when it hears: Local Inference's own knobs, under its own names. */
  vadThreshold: number;
  vadNegativeThreshold: number;
  vadMinSilenceDuration: number;
  vadMinSpeechDuration: number;
  vadMaxSpeechDuration: number;
}

export type LocalAIConfig = PipelineConfig;
export type LocalAICredentials = PipelineCredentials;

/** LocalAI's pipeline model is named by its operator; `gpt-realtime` is the name its docs use. */
export const LOCALAI_DEFAULT_MODEL = 'gpt-realtime';

const VAD_FIELDS = ['vadThreshold', 'vadNegativeThreshold', 'vadMinSilenceDuration', 'vadMinSpeechDuration', 'vadMaxSpeechDuration'] as const;

/** OpenAI Realtime's defaults, but the model, and semantic detection at the eagerness LocalAI's own session starts with; every stage on the server. */
export const LOCALAI_DEFAULTS: LocalAISettings = {
  ...REALTIME_DEFAULTS,
  model: LOCALAI_DEFAULT_MODEL,
  turnDetectionMode: 'Semantic',
  semanticEagerness: 'High',
  asrVia: 'server',
  asrModel: '',
  translateVia: 'server',
  translateBaseUrl: '',
  translateModel: '',
  translateNeedsKey: false,
  coach: false,
  coachBaseUrl: '',
  coachModel: '',
  coachNeedsKey: false,
  coachPrompt: '',
  serverNeedsKey: false,
  selections: {},
  vadThreshold: LOCAL_INFERENCE_DEFAULTS.vadThreshold,
  vadNegativeThreshold: LOCAL_INFERENCE_DEFAULTS.vadNegativeThreshold,
  vadMinSilenceDuration: LOCAL_INFERENCE_DEFAULTS.vadMinSilenceDuration,
  vadMinSpeechDuration: LOCAL_INFERENCE_DEFAULTS.vadMinSpeechDuration,
  vadMaxSpeechDuration: LOCAL_INFERENCE_DEFAULTS.vadMaxSpeechDuration,
};

export function migrateLocalAISettings(stored: Readonly<Record<string, unknown>>, inputs: MigrationInputs): LocalAISettings {
  const text = (k: 'asrModel' | 'translateBaseUrl' | 'translateModel' | 'coachBaseUrl' | 'coachModel' | 'coachPrompt') => (typeof stored[k] === 'string' ? (stored[k] as string) : LOCALAI_DEFAULTS[k]);
  const flag = (k: 'translateNeedsKey' | 'coach' | 'coachNeedsKey' | 'serverNeedsKey') => (typeof stored[k] === 'boolean' ? (stored[k] as boolean) : LOCALAI_DEFAULTS[k]);
  const number = (k: (typeof VAD_FIELDS)[number]) => (typeof stored[k] === 'number' && Number.isFinite(stored[k]) ? (stored[k] as number) : LOCALAI_DEFAULTS[k]);
  const selections = stored.selections;
  return {
    ...migrateRealtimeSettings(stored, inputs),
    asrVia: ASR_VIAS.includes(stored.asrVia as AsrVia) ? (stored.asrVia as AsrVia) : LOCALAI_DEFAULTS.asrVia,
    asrModel: text('asrModel'),
    translateVia: TRANSLATE_VIAS.includes(stored.translateVia as TranslateVia) ? (stored.translateVia as TranslateVia) : LOCALAI_DEFAULTS.translateVia,
    translateBaseUrl: text('translateBaseUrl'),
    translateModel: text('translateModel'),
    translateNeedsKey: flag('translateNeedsKey'),
    coach: flag('coach'),
    coachBaseUrl: text('coachBaseUrl'),
    coachModel: text('coachModel'),
    coachNeedsKey: flag('coachNeedsKey'),
    coachPrompt: text('coachPrompt'),
    serverNeedsKey: flag('serverNeedsKey'),
    selections: selections && typeof selections === 'object' && !Array.isArray(selections) ? (selections as Selections) : {},
    vadThreshold: number('vadThreshold'),
    vadNegativeThreshold: number('vadNegativeThreshold'),
    vadMinSilenceDuration: number('vadMinSilenceDuration'),
    vadMinSpeechDuration: number('vadMinSpeechDuration'),
    vadMaxSpeechDuration: number('vadMaxSpeechDuration'),
  };
}

const WS_SCHEMES: Readonly<Record<string, string>> = { 'http:': 'ws:', 'https:': 'wss:', 'ws:': 'ws:', 'wss:': 'wss:' };

/**
 * What the user typed as the socket's URL, or null when it names no server:
 * `192.168.1.10:8080`, `http://host:8080`, `ws://host:8080/v1` and
 * `ws://host:8080/v1/realtime` all dial `ws://host:8080/v1/realtime`. A path
 * of its own is kept as typed; a query is dropped — the model rides there.
 */
export function localaiEndpoint(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `ws://${text}`);
  } catch {
    return null;
  }
  const scheme = WS_SCHEMES[url.protocol];
  if (!scheme || !url.host) return null;
  const path = url.pathname.replace(/\/+$/, '');
  return `${scheme}//${url.host}${path === '' ? '/v1/realtime' : path.endsWith('/v1') ? `${path}/realtime` : path}`;
}

/** The server's model list, beside its Realtime endpoint: `ws://host/v1/realtime` → `http://host/v1/models`. */
export function localaiModelsUrl(endpoint: string): string {
  return `${httpBaseOf(endpoint)}/models`;
}

export { kindOf, modelsFor, type LocalAIModel, type LocalAIModelKind, type LocalAIModelSlot } from './localaiModels';
export { needsServer, translateViaOf } from './localaiDevice';

/** A leg of this run only transcribes on the server — its answers come from elsewhere — so LocalAI lets no recognizer be chosen (`transcriptionFor`). */
export const hasTranscriptionLeg = (s: Pick<LocalAISettings, 'asrVia' | 'translateVia' | 'coach'>) => s.asrVia === 'server' && (translateViaOf(s) !== 'server' || s.coach);

export const localaiCredentials: Provider<LocalAISettings, LocalAICredentials, never>['credentials'] = {
  keys: ['endpoint', 'serverKey', 'translateKey', 'coachKey'],
  fields: (s): CredentialField[] => [
    ...(needsServer(s) ? [{ key: 'endpoint', labelKey: 'providers.localai.endpoint', secret: false, placeholderKey: 'providers.localai.endpointPlaceholder' }] : []),
    ...(needsServer(s) && s.serverNeedsKey ? [{ key: 'serverKey', labelKey: 'providers.localai.serverKey', secret: true, placeholderKey: 'providers.localai.serverKey' }] : []),
    ...(usesTranslateModel(s) && s.translateNeedsKey ? [{ key: 'translateKey', labelKey: 'providers.localai.translateKey', secret: true, placeholderKey: 'providers.localai.translateKey' }] : []),
    ...(ownCoachModel(s) && s.coachNeedsKey ? [{ key: 'coachKey', labelKey: 'providers.localai.coachKey', secret: true, placeholderKey: 'providers.localai.coachKey' }] : []),
  ],
  // `values` holds exactly the fields shown: the address is in it only while a stage is on the server, a key only when its stage asks for one.
  read: (values): LocalAICredentials | CredentialsMissing => {
    const endpoint = values.endpoint === undefined ? '' : localaiEndpoint(values.endpoint);
    if (endpoint === null) return { missing: 'Enter the address of your LocalAI server.' };
    const serverKey = values.serverKey?.trim();
    const translateKey = values.translateKey?.trim();
    const coachKey = values.coachKey?.trim();
    if (values.serverKey !== undefined && !serverKey) return { missing: 'Enter the access key of the server.' };
    if (values.translateKey !== undefined && !translateKey) return { missing: 'Enter the API key of the translation model.' };
    if (values.coachKey !== undefined && !coachKey) return { missing: 'Enter the API key of the feedback model.' };
    // No Realtime key (see the header) unless the server asks for one: the adapter then offers no subprotocol.
    return { apiKey: serverKey ?? '', endpoint, ...(translateKey ? { translateKey } : {}), ...(coachKey ? { coachKey } : {}) };
  },
  // Where it listens, chosen right above the address: the one choice a user of the simple layout needs, and the one that decides whether an address is asked for at all.
  choice: {
    setting: 'asrVia',
    options: [
      { value: 'server', labelKey: 'providers.localai.choiceServer' },
      { value: 'device', labelKey: 'providers.localai.choiceDevice' },
    ],
  },
};

export interface LocalAICheckDeps {
  fetch?: typeof fetch;
  clock?: Pick<Clock, 'setTimeout'>;
}

interface OtherServer { slot: 'translate' | 'coach'; name: string; base: string; key?: string; inUse: boolean }

/** The servers the text stages name that are not the Realtime server: listed for their models, and — when a run would call them — required to accept the key. */
function otherServers(k: LocalAICredentials, s: LocalAISettings): OtherServer[] {
  const out: OtherServer[] = [];
  const base = (url: string) => url.trim().replace(/\/+$/, '');
  if (translateViaOf(s) !== 'device' && s.translateBaseUrl.trim()) out.push({ slot: 'translate', name: 'translation', base: base(s.translateBaseUrl), key: k.translateKey, inUse: usesTranslateModel(s) });
  if (s.coach && s.coachBaseUrl.trim()) out.push({ slot: 'coach', name: 'feedback', base: base(s.coachBaseUrl), key: k.coachKey, inUse: ownCoachModel(s) });
  return out;
}

interface Listed { id: string; kotomimi: boolean }

/** A model list's entries, each once; another Kotomimi names itself the owner of every model it shares. */
const listed = (body: unknown): Listed[] => {
  const seen = new Map<string, Listed>();
  for (const m of (body as { data?: Array<{ id?: unknown; owned_by?: unknown }> } | null)?.data ?? []) {
    if (typeof m.id === 'string' && m.id && !seen.has(m.id)) seen.set(m.id, { id: m.id, kotomimi: m.owned_by === KOTOMIMI_HOST });
  }
  return [...seen.values()];
};

/** A GET of a model list: the key as a Bearer token when the server has one, and no header at all otherwise. */
const listing = (key: string | undefined, signal: AbortSignal): RequestInit => ({ method: 'GET', ...(key ? { headers: { Authorization: `Bearer ${key}` } } : {}), signal });

/**
 * Readiness: every server a run would call answers, and every model this
 * computer would run is downloaded.
 *
 * The Realtime server, when a stage is on it, answers its model list. What
 * comes back is every model with what it is for, so each slot of the
 * settings offers only the models that fit it (`modelsFor`): the server's
 * own by LocalAI's capability list — asked for, and done without when the
 * server has none — and each text stage's other server's by its own list.
 *
 * A failed fetch or an HTTP error of the Realtime server's throws: it could
 * not be asked, which is not a refusal — except a 401 or 403, which is the
 * key's. Another server refuses only by a 401 or a 403, and only when a run
 * would call it; any other answer passes, since not every API lists its
 * models.
 *
 * This computer's own stages are asked last, of the model store: a leg whose
 * recognizer or translation model is not downloaded is refused in the words
 * Local Inference uses for the same gap.
 */
export function createLocalAICheck(deps: LocalAICheckDeps = {}) {
  const clock = deps.clock ?? realClock;
  return async (k: LocalAICredentials, s: LocalAISettings, ctx: CheckContext): Promise<CheckResult> => {
    const doFetch = deps.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
    const late = `A server did not answer its model list within ${CHECK_TIMEOUT_MS / 1000} s.`;
    const servers = needsServer(s) || otherServers(k, s).length > 0
      ? await boundedFetch({ clock, ms: CHECK_TIMEOUT_MS, signal: ctx.signal, late }, async (signal): Promise<CheckResult> => {
        const models: LocalAIModel[] = [];
        if (needsServer(s)) {
          const response = await doFetch(localaiModelsUrl(k.endpoint), listing(k.apiKey, signal));
          if (response.status === 401 || response.status === 403) return { ok: false, code: 'auth', reason: `The server refused the access key (HTTP ${response.status}).` };
          if (!response.ok) throw new Error(`The server answered its model list with HTTP ${response.status}.`);
          const own = listed(await response.json());
          if (own.length === 0) return { ok: false, reason: 'The server lists no model.' };

          // What each model is for. LocalAI's own endpoint; any other server answers 404, or nothing, and the models stay unsorted.
          const kinds = new Map<string, LocalAIModelKind>();
          try {
            const answer = await doFetch(`${localaiModelsUrl(k.endpoint)}/capabilities`, listing(k.apiKey, signal));
            if (answer.ok) {
              for (const m of ((await answer.json()) as { data?: Array<{ id?: unknown; capabilities?: unknown }> }).data ?? []) {
                if (typeof m.id === 'string') kinds.set(m.id, kindOf(m.capabilities));
              }
            }
          } catch (error) {
            if (signal.aborted) throw error;
          }
          for (const m of own) models.push({ id: m.id, ...(kinds.has(m.id) ? { kind: kinds.get(m.id) } : {}), ...(m.kotomimi ? { host: KOTOMIMI_HOST } : {}) });
        }

        for (const other of otherServers(k, s)) {
          let answer: Response;
          try {
            answer = await doFetch(`${other.base}/models`, listing(other.key, signal));
          } catch (error) {
            if (signal.aborted) throw error;
            if (!other.inUse) continue;
            throw new Error(`The ${other.name} model's server (${other.base}) could not be reached.`);
          }
          if ((answer.status === 401 || answer.status === 403) && other.inUse) return { ok: false, code: 'auth', reason: `The ${other.name} model's server refused the key (HTTP ${answer.status}).` };
          if (!answer.ok) continue;
          const theirs = listed(await answer.json().catch(() => null));
          // Another Kotomimi lists its recognizers too: its pipeline and its translation models are what a text slot can ask.
          let kinds: Map<string, LocalAIModelKind> | null = null;
          if (theirs.some((m) => m.kotomimi)) {
            try {
              const caps = await doFetch(`${other.base}/models/capabilities`, listing(other.key, signal));
              if (caps.ok) {
                kinds = new Map();
                for (const m of ((await caps.json()) as { data?: Array<{ id?: unknown; capabilities?: unknown }> }).data ?? []) {
                  if (typeof m.id === 'string') kinds.set(m.id, kindOf(m.capabilities));
                }
              }
            } catch (error) {
              if (signal.aborted) throw error;
            }
          }
          for (const m of theirs) {
            const kind = kinds?.get(m.id);
            if (kind === 'asr' || kind === 'other') continue;
            models.push({ id: m.id, kind: m.kotomimi ? 'translate' : 'text', from: other.slot, ...(m.kotomimi ? { host: KOTOMIMI_HOST } : {}) });
          }
        }
        return { ok: true, models };
      })
      : ({ ok: true, models: [] } as CheckResult);
    if (!servers.ok) return servers;

    const needs = deviceNeeds(deviceChoices(s), ctx.pair, ctx.legs);
    if (needs.length > 0) {
      await deviceModelsLoaded(ctx.signal);
      for (const need of needs) {
        if (!need.required || deviceModelFor(need, s.selections)) continue;
        return need.stage === 'asr'
          ? { ok: false, reason: `No speech recognition model is downloaded for ${need.source}.`, code: 'no_asr', params: { source: need.source } }
          : { ok: false, reason: `No translation model is downloaded for ${need.source} → ${need.target}.`, code: 'local_models_missing' };
      }
    }
    return servers;
  };
}

export const checkLocalAI = createLocalAICheck();

/**
 * The model a session runs: what the user typed, as typed. Only a blank
 * field falls to the server's pipelines — the first named `gpt-realtime*`,
 * else the first.
 */
export function effectiveLocalAIModel(s: Pick<LocalAISettings, 'model'>, models: readonly LocalAIModel[]): string {
  const typed = s.model.trim();
  if (typed) return typed;
  const pipelines = modelsFor(models, 'pipeline');
  return pipelines.find((m) => isRealtimeModelId(m.id))?.id ?? pipelines[0]?.id ?? '';
}

/**
 * The hint for the server's transcriber: its own model unless one is chosen,
 * and the language this leg hears when it has a code. A leg that only
 * transcribes takes the server's own on a LocalAI: in a transcription
 * session it refuses the whole `session.update` for any other recognizer
 * ("not a valid pipeline model", 2026-10-03), which would fail the start.
 * Another Kotomimi takes any of its recognizers in any session.
 */
function transcriptionFor(s: Pick<LocalAISettings, 'asrModel'>, heard: string, transcribeOnly: boolean, kotomimi: boolean): TranscriptionHint {
  const model = transcribeOnly && !kotomimi ? '' : s.asrModel.trim();
  const language = normalizeTranscriptionLanguage(heard);
  // No `model` keeps the pipeline's own: the hint's type names one because OpenAI requires it.
  return { ...(model ? { model } : {}), ...(language ? { language } : {}) } as TranscriptionHint;
}

/** The key a text stage's server is called with: its own when it asks for one, else the Realtime server's when the stage is on that server and it asks. */
function stageKey(s: LocalAISettings, baseUrl: string, needsKey: boolean, own: 'translateKey' | 'coachKey'): { key?: StageKey } {
  if (needsKey) return { key: own };
  return baseUrl === '' && s.serverNeedsKey ? { key: 'apiKey' } : {};
}

export function buildLocalAI(context: SessionContext, s: LocalAISettings, shared: SharedSettings): LocalAIConfig | ProviderRefusal {
  const models: readonly LocalAIModel[] = shared.models;
  const { source, target } = context.direction;
  const hearsHere = s.asrVia === 'device';
  const via = translateViaOf(s);
  const model = hearsHere ? '' : effectiveLocalAIModel(s, models);
  if (!hearsHere && !model) return { refused: 'No model is named, and the server lists none.', code: 'models_required' };
  const kotomimi = !hearsHere && isKotomimiServer(models);
  // The speaker alone is coached: the participant leg always hears the other side, and translates it.
  const coached = s.coach && !shared.reversed(context.direction);
  // While this computer translates, the translation text model is no part of the run.
  const translateModel = via === 'device' ? '' : s.translateModel.trim();
  if (via === 'model' && !translateModel) return { refused: 'No translation model is named.', code: 'models_required' };
  if (coached && !s.coachModel.trim() && !translateModel) return { refused: 'No feedback model is named.', code: 'models_required' };

  // OpenAI Realtime's builder for the instructions and the detection, with the model pinned so it picks no other.
  const pinned = model || LOCALAI_DEFAULT_MODEL;
  const base = buildRealtime(context, { ...s, model: pinned }, { ...shared, models: [{ id: pinned }] });
  if ('refused' in base) return base;
  const { voice: _voice, reasoningEffort: _reasoning, ...config } = base;

  // What hears is asked first: a run with no recognizer has nothing to translate.
  const heard = coached ? target : source;
  let device: DeviceHearing | undefined;
  if (hearsHere) {
    const recognizer = deviceRecognizer(heard, coached ? source : target, s.selections);
    if (!recognizer) return { refused: `No speech recognition model is downloaded for ${heard}.`, code: 'no_asr', params: { source: heard } };
    device = {
      ...recognizer,
      vad: {
        threshold: s.vadThreshold,
        minSilenceDuration: s.vadMinSilenceDuration,
        minSpeechDuration: s.vadMinSpeechDuration,
        maxSpeechDuration: s.vadMaxSpeechDuration,
        ...(s.vadNegativeThreshold ? { negativeThreshold: s.vadNegativeThreshold } : {}),
      },
    };
  }

  /** A model another Kotomimi shares is told the pair: it runs a translation model, not a chat model. */
  const pairFor = (id: string, baseUrl: string) => (models.some((m) => m.id === id && m.host === KOTOMIMI_HOST && (baseUrl === '' ? m.from === undefined : m.from === 'translate')) ? { pair: { source, target } } : {});

  let translate: AnswerStage | null = null;
  if (via === 'device') {
    const id = deviceTranslator(source, target, s.selections);
    // A coached speaker's translation is for what they type only: the run starts without it.
    if (!id && !coached) return { refused: `No translation model is downloaded for ${source} → ${target}.`, code: 'local_models_missing' };
    if (id) translate = { via: 'device', kind: 'translate', model: id, system: buildDefaultLocalPrompt(deviceLanguage(source), deviceLanguage(target)), wrapTranscript: true };
  } else if (translateModel) {
    const baseUrl = s.translateBaseUrl.trim();
    translate = { kind: 'translate', baseUrl, model: translateModel, ...stageKey(s, baseUrl, s.translateNeedsKey, 'translateKey'), system: base.instructions, ...pairFor(translateModel, baseUrl) };
  } else if (kotomimi) {
    // Another Kotomimi answers nothing inside its socket: its pipeline's name, asked over chat, runs its own best translation model for the pair.
    translate = { kind: 'translate', baseUrl: '', model, ...stageKey(s, '', false, 'translateKey'), system: base.instructions, pair: { source, target } };
  }

  let stages: Stages | undefined;
  if (coached) {
    const own = s.coachModel.trim();
    const baseUrl = own ? s.coachBaseUrl.trim() : s.translateBaseUrl.trim();
    const coach: TextStage = {
      kind: 'coach',
      baseUrl,
      model: own || translateModel,
      ...stageKey(s, baseUrl, own ? s.coachNeedsKey : s.translateNeedsKey, own ? 'coachKey' : 'translateKey'),
      // The speaker practises the target language; their own is the source.
      ...(({ system, shots }) => ({ system, ...(shots.length ? { shots } : {}) }))(coachPrompt(target, source, s.coachPrompt)),
      // Feedback is written in the speaker's own language, around a sentence in the one they practise.
      language: source,
    };
    // The speaker speaks the target language; what they type is still their own, and is translated.
    stages = { speech: coach, typed: translate, heard: target };
  } else if (translate && (hearsHere || via !== 'server' || kotomimi)) {
    stages = { speech: translate, typed: translate };
  }

  return {
    ...config,
    model,
    modalities: ['text'],
    transcription: transcriptionFor(s, heard, Boolean(stages?.speech), kotomimi),
    anchor: false,
    commitAnswers: true,
    ...(stages?.speech && !device ? { transcribeOnly: true as const } : {}),
    ...(stages ? { stages } : {}),
    ...(device ? { device } : {}),
  };
}

/** Two models, as OpenAI Realtime describes them: what answers speech — the stage's, or the server's pipeline — and what writes the source. */
export function describeLocalAI(c: LocalAIConfig): { translationModel: string; asrModel?: string } {
  const asrModel = c.device?.modelId ?? c.transcription.model;
  return { translationModel: c.stages?.speech?.model ?? c.model, ...(asrModel ? { asrModel } : {}) };
}

/**
 * The memory this computer's own models take, over the legs built: Local
 * Inference's own budget, asked of the same models it would count. A run
 * with every stage elsewhere counts nothing.
 */
export function admitLocalAI(configs: Partial<Record<LegName, LocalAIConfig>>): true | ProviderRefusal {
  const counted: Partial<Record<LegName, LocalInferenceConfig>> = {};
  for (const [leg, config] of Object.entries(configs) as Array<[LegName, LocalAIConfig | undefined]>) {
    if (!config) continue;
    const translator = [config.stages?.speech, config.stages?.typed].find((stage) => stage?.via === 'device');
    if (!config.device && !translator) continue;
    counted[leg] = {
      asr: { modelId: config.device?.modelId ?? '', streaming: config.device?.streaming ?? false },
      vad: config.device?.vad ?? { threshold: 0, minSilenceDuration: 0, minSpeechDuration: 0, maxSpeechDuration: 0 },
      translation: translator ? { kind: 'engine', modelId: translator.model, instructions: '', wrapTranscript: true } : { kind: 'none' },
    };
  }
  return Object.keys(counted).length === 0 ? true : admitLocalInference(counted);
}

/** A leg this computer hears is told its language: no recognizer of its own detects one, so "auto-detect" is no source there. */
export const localaiLanguages: Provider<LocalAISettings, never, never>['languages'] = {
  ...realtimeLanguages,
  sources: (s, context) => (s.asrVia === 'device' ? REALTIME_LANGUAGES : realtimeLanguages.sources(s, context)),
};

const adapter = createPipelineAdapter();

export const localaiProvider: Provider<LocalAISettings, LocalAICredentials, LocalAIConfig> & { id: 'localai' } = {
  id: 'localai',
  kind: 'own-key',
  // A plain `ws://` to a LAN host: the extension's and the web app's content security policies allow neither.
  platforms: ['electron'],
  icon: KotomimiIcon,

  settings: { key: 'localai', defaults: LOCALAI_DEFAULTS, legacyKeys: REALTIME_LEGACY_KEYS, migrate: migrateLocalAISettings },
  Settings: LocalAISettingsView,
  // This computer's own models: drawn only while a stage runs here.
  Engine: LocalAIEngine,
  EngineSummary: LocalAIEngineSummary,
  TurnDetection: { Summary: LocalAITurnDetectionSummary, Controls: LocalAITurnDetectionControls, Help: LocalAITurnDetectionHelp },

  credentials: localaiCredentials,
  check: checkLocalAI,
  // What decides the credential fields, the endpoints the check reaches, and the models it asks this computer for.
  checkReads: ['asrVia', 'translateVia', 'translateBaseUrl', 'translateModel', 'translateNeedsKey', 'coach', 'coachBaseUrl', 'coachModel', 'coachNeedsKey', 'serverNeedsKey', 'selections'],
  // This computer's models are per direction, and each leg needs its own.
  checkReadsDirection: true,
  watchReadiness: watchDeviceModels,

  languages: localaiLanguages,

  speech: 'never',
  // A coached speaker's session only transcribes: typed text then needs a translation stage of its own to answer it.
  textInput: (s) => !s.coach || translateViaOf(s) === 'device' || s.translateModel.trim() !== '',
  boundaries: () => 'provider',
  turns: () => ['auto', 'manual'],

  build: buildLocalAI,
  describe: describeLocalAI,
  start: adapter.start,

  session: { admit: admitLocalAI },
};
