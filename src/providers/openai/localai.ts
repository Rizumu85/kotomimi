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
 *   go unanswered, so none is offered (`wire.ts` `realtimeProtocols`).
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
 * **Stages chosen apart** (`pipeline.ts`). The Realtime server always hears:
 * it detects turns and writes the source text. What answers that text is a
 * choice: the server's own pipeline, inside the same session, or a text
 * model anywhere that speaks chat completions — another machine's LocalAI,
 * Ollama or LM Studio on this one, a hosted API. And a speaker practising
 * the other side's language can have their speech answered with grammar
 * feedback instead of a translation, by a model of its own again. LocalAI
 * ignores `create_response: false` but honours a transcription session
 * (`session.type: 'transcription'`), which is what a leg with a stage of its
 * own opens.
 */
import { OpenAIIcon } from '../../components/Icons/ProviderIcons';
import type { SessionContext } from '../../lib/contract/adapter';
import { realClock, type Clock } from '../../lib/contract/clock';
import { boundedFetch } from '../../lib/provider/boundedFetch';
import type { CheckContext, CheckResult, CredentialField, CredentialsMissing, MigrationInputs, ModelOption, Provider, ProviderRefusal, SharedSettings } from '../../lib/provider/types';
import { CHECK_TIMEOUT_MS } from './check';
import { coachPrompt } from './coachPrompt';
import { buildRealtime } from './config';
import { LocalAISettingsView } from './LocalAISettings';
import { createPipelineAdapter, type PipelineConfig, type PipelineCredentials, type Stages, type TextStage } from './pipeline';
import { RealtimeTurnDetectionControls, RealtimeTurnDetectionHelp, RealtimeTurnDetectionSummary } from './RealtimeTurnDetection';
import {
  isRealtimeModelId, migrateRealtimeSettings, REALTIME_DEFAULTS, REALTIME_LEGACY_KEYS, realtimeLanguages,
  type RealtimeSettings,
} from './settings';
import { httpBaseOf } from './textModel';
import { normalizeTranscriptionLanguage, type TranscriptionHint } from './transcription';

/** What answers speech in real time: the Realtime server's own pipeline, or a text model chosen apart. */
export const TRANSLATE_VIAS = ['server', 'model'] as const;
export type TranslateVia = (typeof TRANSLATE_VIAS)[number];

export interface LocalAISettings extends RealtimeSettings {
  /** The server's own transcription model; blank keeps the one its pipeline names. */
  asrModel: string;
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
}

export type LocalAIConfig = PipelineConfig;
export type LocalAICredentials = PipelineCredentials;

/** LocalAI's pipeline model is named by its operator; `gpt-realtime` is the name its docs use. */
export const LOCALAI_DEFAULT_MODEL = 'gpt-realtime';

/** OpenAI Realtime's defaults, but the model, and semantic detection at the eagerness LocalAI's own session starts with; every stage on the server. */
export const LOCALAI_DEFAULTS: LocalAISettings = {
  ...REALTIME_DEFAULTS,
  model: LOCALAI_DEFAULT_MODEL,
  turnDetectionMode: 'Semantic',
  semanticEagerness: 'High',
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
};

export function migrateLocalAISettings(stored: Readonly<Record<string, unknown>>, inputs: MigrationInputs): LocalAISettings {
  const text = (k: 'asrModel' | 'translateBaseUrl' | 'translateModel' | 'coachBaseUrl' | 'coachModel' | 'coachPrompt') => (typeof stored[k] === 'string' ? (stored[k] as string) : LOCALAI_DEFAULTS[k]);
  const flag = (k: 'translateNeedsKey' | 'coach' | 'coachNeedsKey') => (typeof stored[k] === 'boolean' ? (stored[k] as boolean) : LOCALAI_DEFAULTS[k]);
  return {
    ...migrateRealtimeSettings(stored, inputs),
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

/** The translation text model is in use: it answers speech, or — the speaker coached — typed text and, with no feedback model named, the feedback too. */
const usesTranslateModel = (s: LocalAISettings) => s.translateModel.trim() !== '' && (s.translateVia === 'model' || s.coach);
/** The feedback has a model of its own. */
const ownCoachModel = (s: LocalAISettings) => s.coach && s.coachModel.trim() !== '';

export const localaiCredentials: Provider<LocalAISettings, LocalAICredentials, never>['credentials'] = {
  keys: ['endpoint', 'translateKey', 'coachKey'],
  fields: (s): CredentialField[] => [
    { key: 'endpoint', labelKey: 'providers.localai.endpoint', secret: false, placeholderKey: 'providers.localai.endpointPlaceholder' },
    ...(usesTranslateModel(s) && s.translateNeedsKey ? [{ key: 'translateKey', labelKey: 'providers.localai.translateKey', secret: true, placeholderKey: 'providers.localai.translateKey' }] : []),
    ...(ownCoachModel(s) && s.coachNeedsKey ? [{ key: 'coachKey', labelKey: 'providers.localai.coachKey', secret: true, placeholderKey: 'providers.localai.coachKey' }] : []),
  ],
  // `values` holds exactly the fields shown: a key field is in it only when its stage asks for one.
  read: (values): LocalAICredentials | CredentialsMissing => {
    const endpoint = localaiEndpoint(values.endpoint ?? '');
    if (!endpoint) return { missing: 'Enter the address of your LocalAI server.' };
    const translateKey = values.translateKey?.trim();
    const coachKey = values.coachKey?.trim();
    if (values.translateKey !== undefined && !translateKey) return { missing: 'Enter the API key of the translation model.' };
    if (values.coachKey !== undefined && !coachKey) return { missing: 'Enter the API key of the feedback model.' };
    // No Realtime key (see the header): the adapter then offers no subprotocol.
    return { apiKey: '', endpoint, ...(translateKey ? { translateKey } : {}), ...(coachKey ? { coachKey } : {}) };
  },
};

export interface LocalAICheckDeps {
  fetch?: typeof fetch;
  clock?: Pick<Clock, 'setTimeout'>;
}

/** The text-model endpoints a run would call that are not the Realtime server's own, each with the key it is called with. */
function otherEndpoints(k: LocalAICredentials, s: LocalAISettings): Array<{ name: string; base: string; key?: string }> {
  const out: Array<{ name: string; base: string; key?: string }> = [];
  if (usesTranslateModel(s) && s.translateBaseUrl.trim()) out.push({ name: 'translation', base: s.translateBaseUrl.trim().replace(/\/+$/, ''), key: k.translateKey });
  if (ownCoachModel(s) && s.coachBaseUrl.trim()) out.push({ name: 'feedback', base: s.coachBaseUrl.trim().replace(/\/+$/, ''), key: k.coachKey });
  return out;
}

/**
 * Readiness: the Realtime server answers its model list — every model kept,
 * in the server's order, since LocalAI lists pipelines, transcribers and
 * LLMs alike and says nothing of their kind — and every other endpoint a
 * stage names can be reached with its key. A failed fetch or an HTTP error
 * of the server's throws: it could not be asked, which is not a refusal.
 * Another endpoint refuses only by a 401 or a 403 to its model list; any
 * other answer passes, since not every API lists its models.
 */
export function createLocalAICheck(deps: LocalAICheckDeps = {}) {
  const clock = deps.clock ?? realClock;
  return (k: LocalAICredentials, s: LocalAISettings, ctx: CheckContext): Promise<CheckResult> => {
    const doFetch = deps.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
    const late = `A server did not answer its model list within ${CHECK_TIMEOUT_MS / 1000} s.`;
    return boundedFetch({ clock, ms: CHECK_TIMEOUT_MS, signal: ctx.signal, late }, async (signal): Promise<CheckResult> => {
      const response = await doFetch(localaiModelsUrl(k.endpoint), { method: 'GET', signal });
      if (!response.ok) throw new Error(`The server answered its model list with HTTP ${response.status}.`);
      const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
      const ids = [...new Set((body.data ?? []).flatMap((m) => (typeof m.id === 'string' && m.id ? [m.id] : [])))];
      if (ids.length === 0) return { ok: false, reason: 'The server lists no model.' };
      for (const other of otherEndpoints(k, s)) {
        let answer: Response;
        try {
          answer = await doFetch(`${other.base}/models`, { method: 'GET', headers: other.key ? { Authorization: `Bearer ${other.key}` } : {}, signal });
        } catch (error) {
          if (signal.aborted) throw error;
          throw new Error(`The ${other.name} model's server (${other.base}) could not be reached.`);
        }
        if (answer.status === 401 || answer.status === 403) return { ok: false, code: 'auth', reason: `The ${other.name} model's server refused the key (HTTP ${answer.status}).` };
      }
      return { ok: true, models: ids.map((id) => ({ id })) };
    });
  };
}

export const checkLocalAI = createLocalAICheck();

/**
 * The model a session runs: what the user typed, as typed. Only a blank
 * field falls to the server's list — its first `gpt-realtime*` name, else
 * its first model.
 */
export function effectiveLocalAIModel(s: Pick<LocalAISettings, 'model'>, models: readonly ModelOption[]): string {
  const typed = s.model.trim();
  if (typed) return typed;
  return models.find((m) => isRealtimeModelId(m.id))?.id ?? models[0]?.id ?? '';
}

/** The hint for the server's transcriber: its own model unless one is chosen, and the language this leg hears when it has a code. */
function transcriptionFor(s: Pick<LocalAISettings, 'asrModel'>, heard: string): TranscriptionHint {
  const model = s.asrModel.trim();
  const language = normalizeTranscriptionLanguage(heard);
  // No `model` keeps the pipeline's own: the hint's type names one because OpenAI requires it.
  return { ...(model ? { model } : {}), ...(language ? { language } : {}) } as TranscriptionHint;
}

export function buildLocalAI(context: SessionContext, s: LocalAISettings, shared: SharedSettings): LocalAIConfig | ProviderRefusal {
  const model = effectiveLocalAIModel(s, shared.models);
  if (!model) return { refused: 'No model is named, and the server lists none.', code: 'models_required' };
  const { source, target } = context.direction;
  // The speaker alone is coached: the participant leg always hears the other side, and translates it.
  const coached = s.coach && !shared.reversed(context.direction);
  const translateModel = s.translateModel.trim();
  if (s.translateVia === 'model' && !translateModel) return { refused: 'No translation model is named.', code: 'models_required' };
  if (coached && !s.coachModel.trim() && !translateModel) return { refused: 'No feedback model is named.', code: 'models_required' };

  // OpenAI Realtime's builder for the instructions and the detection, with the model pinned so it picks no other.
  const base = buildRealtime(context, { ...s, model }, { ...shared, models: [{ id: model }] });
  if ('refused' in base) return base;
  const { voice: _voice, reasoningEffort: _reasoning, ...config } = base;

  const translate: TextStage | null = translateModel
    ? { kind: 'translate', baseUrl: s.translateBaseUrl.trim(), model: translateModel, ...(s.translateNeedsKey ? { key: 'translateKey' as const } : {}), system: base.instructions }
    : null;
  let stages: Stages | undefined;
  if (coached) {
    const own = s.coachModel.trim();
    const coach: TextStage = {
      kind: 'coach',
      baseUrl: own ? s.coachBaseUrl.trim() : s.translateBaseUrl.trim(),
      model: own || translateModel,
      ...((own ? s.coachNeedsKey : s.translateNeedsKey) ? { key: own ? ('coachKey' as const) : ('translateKey' as const) } : {}),
      // The speaker practises the target language; their own is the source.
      ...(({ system, shots }) => ({ system, ...(shots.length ? { shots } : {}) }))(coachPrompt(target, source, s.coachPrompt)),
      // Feedback is written in the speaker's own language, around a sentence in the one they practise.
      language: source,
    };
    // The speaker speaks the target language; what they type is still their own, and is translated.
    stages = { speech: coach, typed: translate, heard: target };
  } else if (s.translateVia === 'model') {
    stages = { speech: translate, typed: translate };
  }

  return {
    ...config,
    modalities: ['text'],
    transcription: transcriptionFor(s, coached ? target : source),
    anchor: false,
    commitAnswers: true,
    ...(stages?.speech ? { transcribeOnly: true as const } : {}),
    ...(stages ? { stages } : {}),
  };
}

/** Two models, as OpenAI Realtime describes them: what answers speech — the stage's, or the server's pipeline — and what writes the source. */
export function describeLocalAI(c: LocalAIConfig): { translationModel: string; asrModel?: string } {
  return { translationModel: c.stages?.speech?.model ?? c.model, ...(c.transcription.model ? { asrModel: c.transcription.model } : {}) };
}

const adapter = createPipelineAdapter();

export const localaiProvider: Provider<LocalAISettings, LocalAICredentials, LocalAIConfig> & { id: 'localai' } = {
  id: 'localai',
  kind: 'own-key',
  // A plain `ws://` to a LAN host: the extension's and the web app's content security policies allow neither.
  platforms: ['electron'],
  icon: OpenAIIcon,

  settings: { key: 'localai', defaults: LOCALAI_DEFAULTS, legacyKeys: REALTIME_LEGACY_KEYS, migrate: migrateLocalAISettings },
  Settings: LocalAISettingsView,
  TurnDetection: { Summary: RealtimeTurnDetectionSummary, Controls: RealtimeTurnDetectionControls, Help: RealtimeTurnDetectionHelp },

  credentials: localaiCredentials,
  check: checkLocalAI,
  // What decides the credential fields, and the endpoints the check reaches.
  checkReads: ['translateVia', 'translateBaseUrl', 'translateModel', 'translateNeedsKey', 'coach', 'coachBaseUrl', 'coachModel', 'coachNeedsKey'],

  languages: realtimeLanguages,

  speech: 'never',
  // A coached speaker's session only transcribes: typed text then needs the translation text model to answer it.
  textInput: (s) => !s.coach || s.translateModel.trim() !== '',
  boundaries: () => 'provider',
  turns: () => ['auto', 'manual'],

  build: buildLocalAI,
  describe: describeLocalAI,
  start: adapter.start,
};
