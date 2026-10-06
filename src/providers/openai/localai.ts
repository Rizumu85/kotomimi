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
 * **Stages chosen apart** (`pipeline.ts`). Three stages — what hears, what
 * translates, and what gives a speaker grammar feedback on the other side's
 * language — and each runs in one of the same three places: another device
 * on the network, an API anywhere that speaks OpenAI's interfaces, or this
 * computer (`localaiDevice.ts`). What hears detects the turns and writes the
 * source text; each finished source is handed to what answers it. LocalAI
 * ignores `create_response: false` but honours a transcription session
 * (`session.type: 'transcription'`), which is what a leg with a stage of its
 * own opens. Only a leg the other device hears, whose translation is left to
 * that device with no model named, is answered inside its Realtime session,
 * by its own pipeline. With no stage on the other device no address is asked
 * for at all.
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
import { CheckError } from '../../lib/provider/checkError';
import { AUTO } from '../../lib/provider/languages';
import { quickOf } from './apiServices';
import type { CheckContext, CheckResult, CredentialField, CredentialsMissing, MigrationInputs, Provider, ProviderRefusal, SharedSettings } from '../../lib/provider/types';
import { admitLocalInference, type LocalInferenceConfig } from '../localInference/config';
import { LOCAL_INFERENCE_DEFAULTS } from '../localInference/settings';
import { CHECK_TIMEOUT_MS } from './check';
import { SERVER_SILENT, isKotomimiServer, kindOf, KOTOMIMI_HOST, modelsFor, serverDefaultModel, type LocalAIModel, type LocalAIModelKind } from './localaiModels';
import { coachPrompt } from './coachPrompt';
import { buildRealtime } from './config';
import { recognizerAsked } from './serverRecognizers';
import { ASR_HERES, coachIs, coachesNatively, cutsSentencesHere, detectsOther, heardBy, deviceChoices, deviceCoachModel, deviceLanguage, deviceModelFor, deviceModelsLoaded, deviceNeeds, deviceRecognizer, deviceTranslator, hearsByLocalServer, hearsNatively, needsServer, PLACE_FIELDS, PLACES, translatesNatively, watchDeviceModels, type AsrHere, type Place } from './localaiDevice';
import { preferNative } from './localaiNative';
import { NATIVE_DEFAULT_MODEL, coachBaseUrl, coachGap, coachIdle, coachUp, holdNativeForRun, nativeGap, nativeUp, restNative, translatorUp, nativeWaits, nativeIdle, nativePicked, translatorBaseUrl, translatorGap, translatorIdle, watchNativeEngine } from './localaiNative';
import { NATIVE_COACH_EXTRA, NATIVE_DEFAULT_COACH, nativeCoach } from './nativeCoaches';
import { NATIVE_DEFAULT_TRANSLATOR, nativeTranslates, nativeTranslator, translatorRequest } from './nativeTranslators';
import { setLocalPipeline } from '../../lib/lan/localServer';
import { useLocalServerStore } from '../../stores/localServerStore';
import { LocalAITurnDetectionControls, LocalAITurnDetectionHelp, LocalAITurnDetectionSummary } from './LocalAIEngine';
import { KotomimiIcon } from './LocalAIIcon';
import { LocalAISettingsView } from './LocalAISettings';
import { LocalAIAssist } from './LocalAIAssist';
import { createPipelineAdapter, type AnswerStage, type DeviceHearing, type PipelineConfig, type PipelineCredentials, type StageKey, type Stages } from './pipeline';
import {
  isRealtimeModelId, migrateRealtimeSettings, REALTIME_DEFAULTS, REALTIME_LANGUAGES, REALTIME_LEGACY_KEYS, realtimeLanguages,
  type RealtimeSettings,
} from './settings';
import { httpBaseOf } from './textModel';
import { normalizeTranscriptionLanguage, type TranscriptionHint } from './transcription';

/** Where a stage runs (`localaiDevice.ts`): the same three places for what hears, what translates and what gives feedback. */
export const ASR_VIAS = PLACES;
export type AsrVia = Place;

export interface LocalAISettings extends RealtimeSettings {
  /** Where it hears: the other device's Realtime session, an API each sentence is uploaded to (this computer cuts the sentences), or this computer's own recognizer. */
  asrVia: Place;
  /** The other device's own transcription model; blank keeps the one its pipeline names. */
  asrModel: string;
  /** The speech recognition API's OpenAI-style base URL (`https://api.openai.com/v1`), its model, and whether it wants a key. */
  asrApiBaseUrl: string;
  asrApiModel: string;
  asrApiNeedsKey: boolean;
  /**
   * The other side's language is left to be detected: whoever they are, they
   * are heard and translated into the speaker's language, and the speaker's
   * own speech still goes into the pair's target. It takes a recognizer that
   * detects the language (`detectsOther`).
   */
  asrDetectOther: boolean;
  /** Where it translates. */
  translateAt: Place;
  /** On the other device: the model asked over chat. Blank: the device's own — its pipeline, inside the session it hears in; else the first model it lists that translates. */
  translateServerModel: string;
  /** The translation API's OpenAI-style base URL (`http://localhost:11434/v1`), its model, and whether it wants a key. */
  translateBaseUrl: string;
  translateModel: string;
  translateNeedsKey: boolean;
  /** The speaker practises the other side's language: their speech gets grammar feedback, not a translation. */
  coach: boolean;
  /** Where the feedback is written. */
  coachAt: Place;
  /** On the other device: its text model. Blank: the first it lists. */
  coachServerModel: string;
  /** The feedback API's base URL, its model, and whether it wants a key. */
  coachBaseUrl: string;
  coachModel: string;
  coachNeedsKey: boolean;
  /** On this computer: one of the catalog's chat models. Blank: the largest downloaded. */
  coachDeviceModel: string;
  /** The user's own feedback instructions; blank: chosen by the two languages (`coachPrompt.ts`). `{{SPOKEN}}` and `{{NATIVE}}` are filled in. */
  coachPrompt: string;
  /**
   * On this computer, who runs each stage: the app's own models, or the LocalAI installed here — and then which of
   * its models. The recognizer may be blank: the one its pipeline names.
   */
  asrHere: AsrHere;
  asrHereModel: string;
  /** The native engine's model, when it hears. */
  asrNativeModel: string;
  /** The native model chosen for a language, by the language's base code: it is heard by that one whatever is in use (`nativePicked`). */
  asrNativeByLanguage: Record<string, string>;
  translateHere: AsrHere;
  translateHereModel: string;
  /** The native translation engine's model, when it translates. */
  translateNativeModel: string;
  coachHere: AsrHere;
  coachHereModel: string;
  /** The native feedback engine's model, when it gives the feedback. */
  coachNativeModel: string;
  /** That LocalAI's address (`127.0.0.1:8080`) and its Realtime pipeline, as they were when it was chosen. */
  hereAddress: string;
  herePipeline: string;
  /** The other device wants an access key: a credential field appears. */
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

/** The longest turn of this computer's recognizers, unless the user sets another (see `LOCALAI_DEFAULTS`). */
export const LOCALAI_MAX_SPEECH_SECONDS = 15;

const VAD_FIELDS = ['vadThreshold', 'vadNegativeThreshold', 'vadMinSilenceDuration', 'vadMinSpeechDuration', 'vadMaxSpeechDuration'] as const;

/** OpenAI Realtime's defaults, but the model, and semantic detection at the eagerness LocalAI's own session starts with; every stage on the other device. */
export const LOCALAI_DEFAULTS: LocalAISettings = {
  ...REALTIME_DEFAULTS,
  model: LOCALAI_DEFAULT_MODEL,
  turnDetectionMode: 'Semantic',
  semanticEagerness: 'High',
  asrVia: 'server',
  asrModel: '',
  asrApiBaseUrl: '',
  asrApiModel: '',
  // An API usually wants a key: its field shows as soon as the API is chosen.
  asrApiNeedsKey: true,
  asrDetectOther: false,
  translateAt: 'server',
  translateServerModel: '',
  translateBaseUrl: '',
  translateModel: '',
  translateNeedsKey: true,
  coach: false,
  coachAt: 'server',
  coachServerModel: '',
  coachBaseUrl: '',
  coachModel: '',
  coachNeedsKey: true,
  coachDeviceModel: '',
  coachPrompt: '',
  asrHere: 'app',
  asrHereModel: '',
  asrNativeModel: NATIVE_DEFAULT_MODEL,
  asrNativeByLanguage: {},
  translateHere: 'app',
  translateHereModel: '',
  translateNativeModel: NATIVE_DEFAULT_TRANSLATOR,
  coachHere: 'app',
  coachHereModel: '',
  coachNativeModel: NATIVE_DEFAULT_COACH,
  hereAddress: '127.0.0.1:8080',
  herePipeline: '',
  serverNeedsKey: false,
  selections: {},
  vadThreshold: LOCAL_INFERENCE_DEFAULTS.vadThreshold,
  vadNegativeThreshold: LOCAL_INFERENCE_DEFAULTS.vadNegativeThreshold,
  vadMinSilenceDuration: LOCAL_INFERENCE_DEFAULTS.vadMinSilenceDuration,
  vadMinSpeechDuration: LOCAL_INFERENCE_DEFAULTS.vadMinSpeechDuration,
  // Shorter than Local Inference's thirty: a recognizer here says nothing until its turn ends, and where two people
  // talk without a pause a turn ends only at this limit — measured on a real conversation, the first line came after
  // 30 to 37 seconds, and after 15 with this (the other device cuts at about 12). A value the user set is kept: only
  // what was never stored reads the default.
  vadMaxSpeechDuration: LOCALAI_MAX_SPEECH_SECONDS,
};

/**
 * Read with no default, so "never stored" is told from "stored as the
 * default" (`MigrationInputs.legacy`): the two places, and the one field an
 * earlier build kept in their stead.
 */
export const LOCALAI_LEGACY_KEYS: readonly string[] = [...REALTIME_LEGACY_KEYS, 'translateAt', 'coachAt', 'translateVia', 'translateNeedsKey', 'coachNeedsKey'];

const placeOf = (v: unknown): Place | undefined => (PLACES.includes(v as Place) ? (v as Place) : undefined);

/**
 * Where the translation and the feedback run. Stored as such, they are
 * read as stored. An earlier build had other words for them, read here
 * until the places are first written:
 *
 * - `translateVia`: `device`; `model` — a text model, on the other device
 *   while its address was blank, else at that address; or `server` — the
 *   other device's pipeline, which a leg this computer heard could not
 *   reach, so this computer translated instead.
 * - A text model named under the pipeline answered only what a coached
 *   speaker typed, though the page showed it as the translation's: it is
 *   now what it looked like, the model the other device translates with.
 * - A feedback with no model of its own took the translation's text model.
 * - A text model at an address of its own was asked for a key only when its
 *   switch had been turned on: the default said none, where an API's now
 *   says one. Such a model keeps what it had — no key, unless the switch was
 *   stored on.
 */
function migratePlaces(stored: Readonly<Record<string, unknown>>, legacy: Readonly<Record<string, unknown>>): Pick<LocalAISettings, (typeof PLACE_FIELDS)[number]> {
  const text = (k: string) => (typeof stored[k] === 'string' ? (stored[k] as string) : '');
  // A switch as it was stored; where nothing was, as the store filled it in: the default.
  const flag = (k: 'translateNeedsKey' | 'coachNeedsKey') => (typeof legacy[k] === 'boolean' ? (legacy[k] as boolean) : typeof stored[k] === 'boolean' ? (stored[k] as boolean) : LOCALAI_DEFAULTS[k]);
  const asrVia = placeOf(stored.asrVia) ?? LOCALAI_DEFAULTS.asrVia;
  const oldVia = legacy.translateVia;
  const oldModel = text('translateModel').trim();
  const oldBase = text('translateBaseUrl').trim();
  // The text model an earlier build could reach: none while this computer translated.
  const hadTextModel = oldModel !== '' && oldVia !== 'device' && (oldVia === 'model' || asrVia === 'server');

  let translateAt = placeOf(legacy.translateAt);
  let translateServerModel = text('translateServerModel');
  let translateModel = text('translateModel');
  let translateNeedsKey = flag('translateNeedsKey');
  if (!translateAt) {
    if (oldVia === 'device' || (oldVia !== 'model' && asrVia !== 'server')) translateAt = 'device';
    else if (oldVia === 'model' && oldBase) {
      translateAt = 'api';
      translateNeedsKey = legacy.translateNeedsKey === true;
    } else {
      translateAt = 'server';
      if (oldModel && !oldBase) {
        translateServerModel = oldModel;
        translateModel = '';
      }
    }
  }

  let coachAt = placeOf(legacy.coachAt);
  let coachServerModel = text('coachServerModel');
  let coachBaseUrl = text('coachBaseUrl');
  let coachModel = text('coachModel');
  let coachNeedsKey = flag('coachNeedsKey');
  if (!coachAt) {
    if (coachModel.trim()) {
      if (coachBaseUrl.trim()) {
        coachAt = 'api';
        coachNeedsKey = legacy.coachNeedsKey === true;
      } else {
        coachAt = 'server';
        coachServerModel = coachModel.trim();
        coachModel = '';
      }
    } else if (hadTextModel) {
      if (oldBase) {
        coachAt = 'api';
        coachBaseUrl = oldBase;
        coachModel = oldModel;
        coachNeedsKey = legacy.translateNeedsKey === true;
      } else {
        coachAt = 'server';
        coachServerModel = oldModel;
      }
    } else {
      // Nothing was named: beside the translation.
      coachAt = translateAt;
    }
  }
  return { translateAt, translateServerModel, translateModel, translateNeedsKey, coachAt, coachServerModel, coachBaseUrl, coachModel, coachNeedsKey };
}

/** A stored map of language to model, held to its shape. */
const byLanguage = (stored: unknown): Record<string, string> => (stored && typeof stored === 'object' && !Array.isArray(stored)
  ? Object.fromEntries(Object.entries(stored as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== ''))
  : {});

/** A service that is asked in a way of its own (`apiServices.ts`): what goes with the request. */
const quick = (baseUrl: string): { extra?: Readonly<Record<string, unknown>> } => { const extra = quickOf(baseUrl); return extra ? { extra } : {}; };

export function migrateLocalAISettings(stored: Readonly<Record<string, unknown>>, inputs: MigrationInputs): LocalAISettings {
  const text = (k: 'asrModel' | 'asrApiBaseUrl' | 'asrApiModel' | 'translateBaseUrl' | 'coachDeviceModel' | 'coachPrompt' | 'asrHereModel' | 'asrNativeModel' | 'translateHereModel' | 'translateNativeModel' | 'coachHereModel' | 'coachNativeModel' | 'hereAddress' | 'herePipeline') => (typeof stored[k] === 'string' ? (stored[k] as string) : LOCALAI_DEFAULTS[k]);
  const flag = (k: 'asrApiNeedsKey' | 'asrDetectOther' | 'coach' | 'serverNeedsKey') => (typeof stored[k] === 'boolean' ? (stored[k] as boolean) : LOCALAI_DEFAULTS[k]);
  const number = (k: (typeof VAD_FIELDS)[number]) => (typeof stored[k] === 'number' && Number.isFinite(stored[k]) ? (stored[k] as number) : LOCALAI_DEFAULTS[k]);
  const selections = stored.selections;
  return {
    ...migrateRealtimeSettings(stored, inputs),
    asrVia: placeOf(stored.asrVia) ?? LOCALAI_DEFAULTS.asrVia,
    asrModel: text('asrModel'),
    asrApiBaseUrl: text('asrApiBaseUrl'),
    asrApiModel: text('asrApiModel'),
    asrApiNeedsKey: flag('asrApiNeedsKey'),
    asrDetectOther: flag('asrDetectOther'),
    translateBaseUrl: text('translateBaseUrl'),
    coach: flag('coach'),
    coachDeviceModel: text('coachDeviceModel'),
    coachPrompt: text('coachPrompt'),
    asrHere: ASR_HERES.includes(stored.asrHere as AsrHere) ? (stored.asrHere as AsrHere) : LOCALAI_DEFAULTS.asrHere,
    asrHereModel: text('asrHereModel'),
    asrNativeModel: text('asrNativeModel'),
    asrNativeByLanguage: byLanguage(stored.asrNativeByLanguage),
    translateHere: ASR_HERES.includes(stored.translateHere as AsrHere) ? (stored.translateHere as AsrHere) : LOCALAI_DEFAULTS.translateHere,
    translateHereModel: text('translateHereModel'),
    translateNativeModel: text('translateNativeModel'),
    coachHere: ASR_HERES.includes(stored.coachHere as AsrHere) ? (stored.coachHere as AsrHere) : LOCALAI_DEFAULTS.coachHere,
    coachHereModel: text('coachHereModel'),
    coachNativeModel: text('coachNativeModel'),
    hereAddress: text('hereAddress'),
    herePipeline: text('herePipeline'),
    ...migratePlaces(stored, inputs.legacy ?? {}),
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

export { kindOf, modelsFor, serverDefaultModel, type LocalAIModel, type LocalAIModelKind, type LocalAIModelSlot } from './localaiModels';
export { detectsOther, heardBy, needsServer, PLACES, type Place } from './localaiDevice';

/** A leg of this run only transcribes on the other device — its answers come from a stage of its own — so LocalAI lets no recognizer be chosen (`transcriptionFor`). */
export const hasTranscriptionLeg = (s: Pick<LocalAISettings, 'asrVia' | 'translateAt' | 'translateServerModel' | 'coach'>) => s.asrVia === 'server' && (s.translateAt !== 'server' || s.translateServerModel.trim() !== '' || s.coach);

/** This computer's LocalAI: where its models are asked over HTTP, and where its Realtime socket is. */
const hereHost = (s: Pick<LocalAISettings, 'hereAddress'>) => s.hereAddress.trim() || LOCALAI_DEFAULTS.hereAddress;
export const hereBaseUrl = (s: Pick<LocalAISettings, 'hereAddress'>) => `http://${hereHost(s)}/v1`;
const hereSocket = (s: Pick<LocalAISettings, 'hereAddress'>) => `ws://${hereHost(s)}/v1/realtime`;

/**
 * The settings as everything past the stage cards reads them. A text stage
 * this computer's LocalAI runs is a text model at an address — what an API
 * is — with no key: read as one, it is checked, built and run by the code an
 * API's is. (What hears there is no API: a Realtime session, built as such.)
 */
export function settled(s: LocalAISettings): LocalAISettings {
  const translates = s.translateAt === 'device' && s.translateHere === 'localai';
  const coaches = s.coachAt === 'device' && s.coachHere === 'localai';
  if (!translates && !coaches) return s;
  const base = hereBaseUrl(s);
  return {
    ...s,
    ...(translates ? { translateAt: 'api' as const, translateBaseUrl: base, translateModel: s.translateHereModel, translateNeedsKey: false } : {}),
    ...(coaches ? { coachAt: 'api' as const, coachBaseUrl: base, coachModel: s.coachHereModel, coachNeedsKey: false } : {}),
  };
}

/** Every field is drawn by the provider's own view, beside the stage it belongs to (`LocalAIAssist`): the address with the search that finds it, a key with the API it opens. */
const own = (key: string, labelKey: string, secret: boolean, placeholderKey = labelKey): CredentialField => ({ key, labelKey, secret, placeholderKey, drawnByAssist: true });

export const localaiCredentials: Provider<LocalAISettings, LocalAICredentials, never>['credentials'] = {
  keys: ['endpoint', 'serverKey', 'asrKey', 'translateKey', 'coachKey'],
  fields: (s): CredentialField[] => [
    ...(needsServer(s) ? [own('endpoint', 'providers.localai.endpoint', false, 'providers.localai.endpointPlaceholder')] : []),
    ...(needsServer(s) && s.serverNeedsKey ? [own('serverKey', 'providers.localai.serverKey', true)] : []),
    ...(s.asrVia === 'api' && s.asrApiNeedsKey ? [own('asrKey', 'providers.localai.asrKey', true)] : []),
    ...(s.translateAt === 'api' && s.translateNeedsKey ? [own('translateKey', 'providers.localai.translateKey', true)] : []),
    ...(coachIs(s, 'api') && s.coachNeedsKey ? [own('coachKey', 'providers.localai.coachKey', true)] : []),
  ],
  // `values` holds exactly the fields shown: the address is in it only while a stage is on the other device, a key only when its stage asks for one.
  read: (values): LocalAICredentials | CredentialsMissing => {
    const endpoint = values.endpoint === undefined ? '' : localaiEndpoint(values.endpoint);
    // Coded, so they are worded as what they are: a device to choose and its access key, not an API key.
    if (endpoint === null) return { missing: 'Enter the address of your LocalAI server.', code: 'server_address_missing' };
    const serverKey = values.serverKey?.trim();
    const asrKey = values.asrKey?.trim();
    const translateKey = values.translateKey?.trim();
    const coachKey = values.coachKey?.trim();
    if (values.serverKey !== undefined && !serverKey) return { missing: 'Enter the access key of the server.', code: 'server_key_missing' };
    if (values.asrKey !== undefined && !asrKey) return { missing: 'Enter the API key of the speech recognition API.' };
    if (values.translateKey !== undefined && !translateKey) return { missing: 'Enter the API key of the translation model.' };
    if (values.coachKey !== undefined && !coachKey) return { missing: 'Enter the API key of the feedback model.' };
    // No Realtime key (see the header) unless the server asks for one: the adapter then offers no subprotocol.
    return { apiKey: serverKey ?? '', endpoint, ...(asrKey ? { asrKey } : {}), ...(translateKey ? { translateKey } : {}), ...(coachKey ? { coachKey } : {}) };
  },
  // The setup wizard's one question (`StepKotomimi`): everything on another device, or everything on this computer.
  choice: {
    setting: 'asrVia',
    options: [
      { value: 'server', labelKey: 'providers.localai.choiceServer' },
      { value: 'device', labelKey: 'providers.localai.choiceDevice' },
    ],
  },
  // In Settings the stages are drawn here instead, a card each: where it runs and, in the same spot, the model that runs it.
  Assist: LocalAIAssist,
};

/**
 * What a leg leaves unnamed — a stage with no model to run, or an API with no
 * address — in the words its start refuses it with, coded by the stage, whose
 * card is where it is fixed (`noticeText`'s aliases). Asked by the builder, and
 * by the check for every leg, so the card never says "ready" to a run its
 * start would refuse. `coached`: the speaker's own leg, whose speech the
 * feedback answers and whose translation only what is typed needs.
 */
function unnamedStage(s: LocalAISettings, models: readonly LocalAIModel[], coached: boolean): ProviderRefusal | null {
  const hearsHere = s.asrVia !== 'server';
  const pipeline = needsServer(s) ? effectiveLocalAIModel(s, models) : '';
  if (!hearsHere && !pipeline) return { refused: 'No model is named, and the server lists none.', code: 'asr_unnamed' };
  if (s.asrVia === 'api' && (!s.asrApiBaseUrl.trim() || !s.asrApiModel.trim())) return { refused: 'No speech recognition API is named.', code: 'asr_unnamed' };
  if (!coached) {
    if (s.translateAt === 'api' && (!s.translateBaseUrl.trim() || !s.translateModel.trim())) return { refused: 'No translation model is named.', code: 'translate_unnamed' };
    const kotomimi = needsServer(s) && isKotomimiServer(models);
    const serverModel = s.translateServerModel.trim();
    // A model of the other device is asked by name: none is named, and none of its own fits.
    const asksServer = s.translateAt === 'server' && (serverModel !== '' || kotomimi || hearsHere);
    if (asksServer && !(serverModel || (kotomimi && pipeline ? pipeline : serverDefaultModel(models, 'translate')))) return { refused: 'No translation model is named.', code: 'translate_unnamed' };
    return null;
  }
  if (s.coachAt === 'api' && (!s.coachBaseUrl.trim() || !s.coachModel.trim())) return { refused: 'No feedback model is named.', code: 'coach_unnamed' };
  if (s.coachAt === 'server' && !(s.coachServerModel.trim() || serverDefaultModel(models, 'coach'))) return { refused: 'No feedback model is named.', code: 'coach_unnamed' };
  return null;
}

/**
 * A leg whose language is to be detected, where nothing on its way detects
 * one: this computer's translation models are told the pair, and another
 * Kotomimi's recognizers are told the language (`src/lib/lan/transcriber.ts`
 * refuses a session that does not say it). No model downloaded would help,
 * so it is said as what it is. `source`: the language the leg hears; a
 * coached speaker's is never detected, and only what they type is translated.
 * `told`: the other side's leg, whose language the pair names all the same —
 * a translation that has to be told one is told that (a sentence in the
 * reader's own language is not translated at all, `pipeline.ts`), so the
 * leg is not refused for it.
 */
function undetected(s: LocalAISettings, models: readonly LocalAIModel[], source: string, coached: boolean, told?: string): ProviderRefusal | null {
  // The other side's leg is only ever left to be detected where what hears can (`detectsOther`).
  if (source !== AUTO || coached || told !== undefined) return null;
  const kotomimiHears = s.asrVia === 'server' && isKotomimiServer(models);
  // The native translation engine reads what it is given; the app's own translation models are told the pair.
  if ((s.translateAt !== 'device' || translatesNatively(s)) && !kotomimiHears) return null;
  return { refused: 'The language spoken is to be detected, and nothing on the way detects it.', code: 'source_auto' };
}

/**
 * A leg another Kotomimi hears in a language none of its recognizers takes:
 * its socket would refuse the session ("shares no speech recognition model",
 * `src/lib/lan/transcriber.ts`), which a start would show in that device's
 * English. It says which languages each recognizer takes, as it picks among
 * them (`appModels.ts`); one that says none takes any, and so does one it
 * lends from a model server beside it (a LocalAI), whose languages it does
 * not know. `heard`: the language the leg hears.
 */
function unheard(s: LocalAISettings, models: readonly LocalAIModel[], heard: string): ProviderRefusal | null {
  if (s.asrVia !== 'server' || heard === AUTO || !isKotomimiServer(models)) return null;
  const language = deviceLanguage(heard);
  if (modelsFor(models, 'asr').some((m) => m.host !== KOTOMIMI_HOST || !m.languages?.length || m.languages.includes(language))) return null;
  return { refused: `The other device shares no speech recognition model for ${heard}.`, code: 'server_no_asr', params: { source: heard } };
}

export interface LocalAICheckDeps {
  fetch?: typeof fetch;
  clock?: Pick<Clock, 'setTimeout'>;
}

interface OtherServer { slot: 'translate' | 'coach' | 'asr'; name: string; base: string; key?: string }

/** The APIs the stages name: listed for their models, and required to accept the key. */
function otherServers(k: LocalAICredentials, s: LocalAISettings): OtherServer[] {
  const out: OtherServer[] = [];
  const base = (url: string) => url.trim().replace(/\/+$/, '');
  if (s.asrVia === 'api' && s.asrApiBaseUrl.trim()) out.push({ slot: 'asr', name: 'speech recognition', base: base(s.asrApiBaseUrl), key: k.asrKey });
  // This computer's LocalAI, when it hears: reached like any other, so that one that is not running is said before Start.
  if (hearsByLocalServer(s)) out.push({ slot: 'asr', name: 'speech recognition', base: hereBaseUrl(s), key: undefined });
  if (s.translateAt === 'api' && s.translateBaseUrl.trim()) out.push({ slot: 'translate', name: 'translation', base: base(s.translateBaseUrl), key: k.translateKey });
  if (coachIs(s, 'api') && s.coachBaseUrl.trim()) out.push({ slot: 'coach', name: 'feedback', base: base(s.coachBaseUrl), key: k.coachKey });
  return out;
}

/** Where a Realtime endpoint is, as a person reads it: `ws://192.168.1.20:8790/v1/realtime` → `192.168.1.20:8790`. */
function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host || endpoint;
  } catch {
    return endpoint;
  }
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
const NO_COACH_HERE = 'No text model is downloaded for grammar feedback.';

export function createLocalAICheck(deps: LocalAICheckDeps = {}) {
  const clock = deps.clock ?? realClock;
  return async (k: LocalAICredentials, s: LocalAISettings, ctx: CheckContext): Promise<CheckResult> => {
    const doFetch = deps.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
    const late = `A server did not answer its model list within ${CHECK_TIMEOUT_MS / 1000} s.`;
    // The other device's and the APIs' failures are coded (`CheckError`, `providers.localai.*` by `noticeText`): a person reads
    // where to look, not the check's English, which stays the message for the logs. The bound passing is one more.
    const slow = (error: unknown): never => {
      if (!ctx.signal?.aborted && error instanceof Error && error.message === late) throw new CheckError(late, 'check_slow', { seconds: CHECK_TIMEOUT_MS / 1000 });
      throw error;
    };
    const servers = needsServer(s) || otherServers(k, s).length > 0
      ? await boundedFetch({ clock, ms: CHECK_TIMEOUT_MS, signal: ctx.signal, late }, async (signal): Promise<CheckResult> => {
        const models: LocalAIModel[] = [];
        if (needsServer(s)) {
          let response: Response;
          try {
            response = await doFetch(localaiModelsUrl(k.endpoint), listing(k.apiKey, signal));
          } catch (error) {
            if (signal.aborted) throw error;
            // Still a check that could not find out — thrown, the models it listed last are kept — but in words the cards
            // can tell, to offer the same device's Kotomimi (`SERVER_SILENT`).
            throw new CheckError(`${SERVER_SILENT} (${k.endpoint}): ${error instanceof Error ? error.message : String(error)}`, 'server_unreachable', { address: hostOf(k.endpoint) });
          }
          if (response.status === 401 || response.status === 403) {
            // None was sent: the key is asked for. One was: it is not the device's.
            return { ok: false, code: k.apiKey ? 'server_key_refused' : 'server_key_needed', reason: `The server refused the access key (HTTP ${response.status}).` };
          }
          if (!response.ok) throw new CheckError(`The server answered its model list with HTTP ${response.status}.`, 'server_http', { status: response.status });
          const own = listed(await response.json());
          if (own.length === 0) return { ok: false, code: 'server_no_models', reason: 'The server lists no model.' };

          // What each model is for. LocalAI's own endpoint; any other server answers 404, or nothing, and the models stay unsorted.
          const kinds = new Map<string, LocalAIModelKind>();
          // Another Kotomimi says which languages each of its models takes, too.
          const languages = new Map<string, readonly string[]>();
          try {
            const answer = await doFetch(`${localaiModelsUrl(k.endpoint)}/capabilities`, listing(k.apiKey, signal));
            if (answer.ok) {
              for (const m of ((await answer.json()) as { data?: Array<{ id?: unknown; capabilities?: unknown; languages?: unknown }> }).data ?? []) {
                if (typeof m.id !== 'string') continue;
                kinds.set(m.id, kindOf(m.capabilities));
                if (Array.isArray(m.languages)) languages.set(m.id, m.languages.filter((l): l is string => typeof l === 'string'));
              }
            }
          } catch (error) {
            if (signal.aborted) throw error;
          }
          for (const m of own) {
            const taken = m.kotomimi ? languages.get(m.id) : undefined;
            models.push({ id: m.id, ...(kinds.has(m.id) ? { kind: kinds.get(m.id) } : {}), ...(m.kotomimi ? { host: KOTOMIMI_HOST } : {}), ...(taken?.length ? { languages: taken } : {}) });
          }
        }

        for (const other of otherServers(k, s)) {
          let answer: Response;
          try {
            answer = await doFetch(`${other.base}/models`, listing(other.key, signal));
          } catch (error) {
            if (signal.aborted) throw error;
            // This computer's own LocalAI is no address to check, and nothing the internet has to do with: it is not up (yet).
            if (other.base === hereBaseUrl(s)) throw new CheckError(`The LocalAI of this computer (${other.base}) is not running.`, 'localai_here_down');
            throw new CheckError(`The ${other.name} model's server (${other.base}) could not be reached.`, 'api_unreachable', { address: other.base });
          }
          if (answer.status === 401 || answer.status === 403) {
            return { ok: false, code: other.key ? 'api_key_refused' : 'api_key_needed', params: { address: other.base }, reason: `The ${other.name} model's server refused the key (HTTP ${answer.status}).` };
          }
          if (answer.status === 400) {
            // Google answers a key it does not know with 400 and says so in words; any other 400 is a server that lists nothing.
            const said = await answer.text().catch(() => '');
            if (/api[ _-]?key/i.test(said)) return { ok: false, code: other.key ? 'api_key_refused' : 'api_key_needed', params: { address: other.base }, reason: `The ${other.name} model's server refused the key (HTTP 400).` };
            continue;
          }
          if (!answer.ok) continue;
          const theirs = listed(await answer.json().catch(() => null));
          // The speech recognition API's list is offered for its model field as it is: nothing says which of them hear.
          if (other.slot === 'asr') {
            for (const m of theirs) models.push({ id: m.id, kind: 'asr', from: 'asr' });
            continue;
          }
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
      }).catch(slow)
      : ({ ok: true, models: [] } as CheckResult);
    if (!servers.ok) return servers;

    // Only the speaker is coached.
    for (const leg of ctx.legs) {
      const coached = s.coach && leg === 'speaker';
      const found = servers.models ?? [];
      // What the leg hears: the speaker their own language, or — coached — the one they practise; the other side theirs.
      const heard = heardBy(s, ctx.pair, leg, found);
      const gap = unnamedStage(s, found, coached) ?? undetected(s, found, leg === 'speaker' ? ctx.pair.source : heard, coached, leg === 'participant' ? ctx.pair.target : undefined) ?? unheard(s, found, heard);
      // What the servers listed goes with the refusal: a pick from it is often what answers it.
      if (gap) return { ok: false, reason: gap.refused, ...(gap.code ? { code: gap.code } : {}), ...(gap.params ? { params: gap.params } : {}), ...(servers.models?.length ? { models: servers.models } : {}) };
    }

    const needs = deviceNeeds(deviceChoices(s), ctx.pair, ctx.legs);
    // The app's own chat model gives the feedback: not the native feedback engine, which is asked of itself.
    const coachHere = coachIs(s, 'device') && !coachesNatively(s) && ctx.legs.includes('speaker');
    if (needs.length > 0 || coachHere) {
      await deviceModelsLoaded(ctx.signal);
      for (const need of needs) {
        if (!need.required || deviceModelFor(need, s.selections)) continue;
        return need.stage === 'asr'
          ? { ok: false, reason: `No speech recognition model is downloaded for ${need.source}.`, code: 'no_asr', params: { source: need.source } }
          : { ok: false, reason: `No translation model is downloaded for ${need.source} → ${need.target}.`, code: 'local_models_missing' };
      }
      if (coachHere && !deviceCoachModel(s.coachDeviceModel)) return { ok: false, reason: NO_COACH_HERE, code: 'local_models_missing' };
    }
    return servers;
  };
}

export const checkLocalAI = createLocalAICheck();

/** What a run would start of the native engines: the models that hear its legs, its translator, its feedback model. */
interface NativeNeeds {
  hears?: { pick: { model: string; byLanguage: Record<string, string> }; heard: string[] };
  translates?: string;
  coaches?: string;
}

function nativeNeeds(s: LocalAISettings, pair: { source: string; target: string }, legs: readonly ('speaker' | 'participant')[]): NativeNeeds {
  return {
    ...(hearsNatively(s) ? { hears: { pick: { model: s.asrNativeModel, byLanguage: s.asrNativeByLanguage }, heard: legs.map((leg) => heardBy(s, pair, leg)) } } : {}),
    ...(translatesNatively(s) ? { translates: s.translateNativeModel } : {}),
    ...(coachesNatively(s) && legs.includes('speaker') ? { coaches: s.coachNativeModel } : {}),
  };
}

export interface NativeUps { hears: typeof nativeUp; translates: typeof translatorUp; coaches: typeof coachUp; rest: typeof restNative }
const UPS: NativeUps = { hears: nativeUp, translates: translatorUp, coaches: coachUp, rest: restNative };

/** The engines a run needs, brought up side by side and waited for. Rejects with the first that did not come up. */
async function bringUp(needs: NativeNeeds, ups: NativeUps): Promise<boolean> {
  const starts = [
    ...(needs.hears ? [ups.hears(needs.hears.pick, needs.hears.heard)] : []),
    ...(needs.translates ? [ups.translates(needs.translates)] : []),
    ...(needs.coaches ? [ups.coaches(needs.coaches)] : []),
  ];
  if (starts.length === 0) return false;
  // Held while they load: a rest that an earlier run left pending does not stop what this one is waiting for.
  const loading = holdNativeForRun();
  try {
    await Promise.all(starts);
  } finally {
    // Let go here: whoever asked holds them on (a run, until it ends), or they rest a minute from now.
    loading();
    ups.rest();
  }
  return true;
}

/**
 * A run's first step: the native engines it needs are loaded, and waited
 * for. Until now nothing held their models in memory; the translation and
 * the feedback are then built with the addresses the engines answer at.
 */
export async function prepareLocalAI(shape: { pair: { source: string; target: string }; legs: readonly ('speaker' | 'participant')[] }, stored: LocalAISettings, ups: NativeUps = UPS, signal?: AbortSignal): Promise<Record<string, never>> {
  const needs = nativeNeeds(settled(stored), shape.pair, shape.legs);
  // The run holds its engines from here to its end, whatever that end is: a stop, a refusal after this step, a leg
  // that never opened, the page going away — the run's signal is aborted on every one of them. Not only from the
  // moment a leg opens: its source may take a minute to open, and the minute's rest would have stopped them by then.
  if (signal && (needs.hears || needs.translates || needs.coaches)) {
    const done = holdNativeForRun();
    if (signal.aborted) done();
    else signal.addEventListener('abort', done, { once: true });
  }
  await bringUp(needs, ups);
  return {};
}

/**
 * A start in the background, at sign-in (`electron/autostart.js`): what takes
 * long the first time after the computer starts is done once, before anyone
 * waits for it — the engines the settings name are loaded, and let go again a
 * minute later. The check says what they are, whenever it first runs.
 */
/** Until when a prime that was asked for is still wanted: the check that says what to load runs as the app starts, or never (another provider is selected). */
const PRIME_PATIENCE_MS = 3 * 60_000;
let primeUntil = 0;
let primeUps: NativeUps = UPS;
let lastNeeds: NativeNeeds | null = null;
const primeNow = (needs: NativeNeeds, ups: NativeUps = UPS) => { void bringUp(needs, ups).catch(() => undefined); };
export function primeNativeOnce(ups: NativeUps = UPS, now: () => number = () => Date.now()): void {
  if (lastNeeds) {
    primeNow(lastNeeds, ups);
    return;
  }
  primeUps = ups;
  primeUntil = now() + PRIME_PATIENCE_MS;
}

/**
 * The check, with the native engines asked last: a run that hears, translates
 * or gives feedback by one needs its model downloaded. It does not need the
 * engine up, and does not bring it up: that is the run's own first step
 * (`prepareLocalAI`), so that no model holds video memory while nothing
 * listens. What the servers listed goes with its refusal, as with any other.
 */
export async function checkLocalAIWithNative(k: LocalAICredentials, s: LocalAISettings, ctx: CheckContext, check: typeof checkLocalAI = checkLocalAI, native: { gap: typeof nativeGap; idle: typeof nativeIdle; translatorGap?: typeof translatorGap; translatorIdle?: typeof translatorIdle; coachGap?: typeof coachGap; coachIdle?: typeof coachIdle; waits?: typeof nativeWaits } = { gap: nativeGap, idle: nativeIdle }): Promise<CheckResult> {
  // Asked first, beside the servers.
  let hears: ReturnType<typeof nativeGap> | null = null;
  if (hearsNatively(s)) {
    // What each leg hears: the speaker their own language, or — coached — the one they practise; the other side theirs.
    hears = native.gap({ model: s.asrNativeModel, byLanguage: s.asrNativeByLanguage }, ctx.legs.map((leg) => heardBy(s, ctx.pair, leg)));
    hears.catch(() => undefined);
  } else {
    native.idle();
  }
  let translates: ReturnType<typeof translatorGap> | null = null;
  if (translatesNatively(s)) {
    // What each leg translates: the speaker the pair, the other side its reverse. A coached speaker's own speech is not translated, but what they type is.
    translates = (native.translatorGap ?? translatorGap)(s.translateNativeModel, ctx.legs.map((leg) => (leg === 'speaker' ? ctx.pair : { source: ctx.pair.target, target: ctx.pair.source })));
    translates.catch(() => undefined);
  } else {
    (native.translatorIdle ?? translatorIdle)();
  }
  let coaches: ReturnType<typeof coachGap> | null = null;
  if (coachesNatively(s) && ctx.legs.includes('speaker')) {
    coaches = (native.coachGap ?? coachGap)(s.coachNativeModel);
    coaches.catch(() => undefined);
  } else {
    (native.coachIdle ?? coachIdle)();
  }
  // What a run would load, kept for a start in the background to load once (`primeNativeOnce`).
  lastNeeds = nativeNeeds(s, ctx.pair, ctx.legs);
  // And what a device is given of this computer's engines when it names no model: its owner's own choice.
  preferNative({ asr: lastNeeds.hears?.pick ?? null, translation: lastNeeds.translates ?? null });
  if (primeUntil > 0) {
    const wanted = Date.now() <= primeUntil;
    primeUntil = 0;
    // Asked for at sign-in and never answered until much later (another provider was selected then): too late to
    // be the quiet load it was meant as.
    if (wanted) primeNow(lastNeeds, primeUps);
  }
  const servers = await check(k, settled(s), ctx);
  // No model of the app's own hears the language, and one of the engine's is downloaded: it is not chosen, which is
  // another thing to be told than "nothing is downloaded".
  if (!servers.ok && servers.code === 'no_asr' && typeof servers.params?.source === 'string' && (native.waits ?? nativeWaits)(servers.params.source)) {
    return { ...servers, code: 'native_unchosen', reason: `A downloaded speech recognition model is not chosen for ${servers.params.source}.` };
  }
  if (!servers.ok) return servers;
  const refused = (hears ? await hears : null) ?? (translates ? await translates : null) ?? (coaches ? await coaches : null);
  return refused ? { ...refused, ...(servers.models?.length ? { models: servers.models } : {}) } : servers;
}

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
function transcriptionFor(s: Pick<LocalAISettings, 'asrModel'>, heard: string, transcribeOnly: boolean, kotomimi: boolean, models: readonly LocalAIModel[]): TranscriptionHint {
  // A recognizer the device has one of for each language is asked for by the language this leg hears (`serverRecognizers.ts`).
  const model = transcribeOnly && !kotomimi ? '' : recognizerAsked(s.asrModel.trim(), heard, modelsFor(models, 'asr'));
  // Another Kotomimi is told that the language is to be detected, in so many words: it refuses a session that says none.
  const language = heard === AUTO && kotomimi ? AUTO : normalizeTranscriptionLanguage(heard);
  // No `model` keeps the pipeline's own: the hint's type names one because OpenAI requires it.
  return { ...(model ? { model } : {}), ...(language ? { language } : {}) } as TranscriptionHint;
}

/** The key a stage on the other device is called with: the device's own access key, when it asks for one. */
const serverKeyOf = (s: Pick<LocalAISettings, 'serverNeedsKey'>): { key?: StageKey } => (s.serverNeedsKey ? { key: 'apiKey' } : {});

export function buildLocalAI(asked: SessionContext, s: LocalAISettings, shared: SharedSettings): LocalAIConfig | ProviderRefusal {
  const models: readonly LocalAIModel[] = shared.models;
  // The other side's leg, with their language left to be detected: built as a leg whose source is to be detected.
  const detected = detectsOther(s, models) && shared.reversed(asked.direction);
  const context: SessionContext = detected ? { ...asked, direction: { source: AUTO, target: asked.direction.target } } : asked;
  const { source, target } = context.direction;
  // What a translation that has to be told a pair is told: the pair's own language, where the leg's is left to be detected.
  const told = detected ? asked.direction.source : source;
  // Heard by this computer's LocalAI: a Realtime session as the other device's is, on its own socket.
  const hearsLocal = hearsByLocalServer(s);
  // Heard without any Realtime session: by this computer's own recognizer, or by an API it uploads each sentence to.
  const hearsHere = cutsSentencesHere(s);
  // The other device's pipeline: what its Realtime socket runs, and — on another Kotomimi — the name its own choice of translation model is asked by.
  const pipeline = needsServer(s) ? effectiveLocalAIModel(s, models) : '';
  const model = hearsLocal ? s.herePipeline.trim() || LOCALAI_DEFAULT_MODEL : hearsHere ? '' : pipeline;
  const kotomimi = needsServer(s) && isKotomimiServer(models);
  // The speaker alone is coached: the participant leg always hears the other side, and translates it.
  const coached = s.coach && !shared.reversed(context.direction);

  // Every stage named, before anything is built: a run with none has nothing to say. A coached speaker's translation
  // is for what they type only: the run starts without it.
  const gap = unnamedStage(s, models, coached) ?? undetected(s, models, source, coached, detected ? told : undefined);
  if (gap) return gap;
  const apiBase = s.translateBaseUrl.trim();
  const apiModel = s.translateModel.trim();
  const serverModel = s.translateServerModel.trim();
  // No session of the device's own pipeline answers this leg's text: one of its models is asked instead.
  const asksServer = s.translateAt === 'server' && (serverModel !== '' || kotomimi || hearsHere || hearsLocal || coached);
  const askedServerModel = serverModel || (kotomimi && pipeline ? pipeline : serverDefaultModel(models, 'translate'));

  // OpenAI Realtime's builder for the instructions and the detection, with the model pinned so it picks no other.
  const pinned = model || LOCALAI_DEFAULT_MODEL;
  const base = buildRealtime(context, { ...s, model: pinned }, { ...shared, models: [{ id: pinned }] });
  if ('refused' in base) return base;
  const { voice: _voice, reasoningEffort: _reasoning, ...config } = base;

  // What hears is asked first: a run with no recognizer has nothing to translate.
  const heard = coached ? target : source;
  let device: DeviceHearing | undefined;
  if (hearsHere) {
    let recognizer: Pick<DeviceHearing, 'modelId' | 'streaming' | 'api' | 'native'> | null;
    if (hearsNatively(s)) {
      const native = nativePicked({ model: s.asrNativeModel, byLanguage: s.asrNativeByLanguage }, heard);
      // The language has no native model chosen: said as that, since downloading one would not help.
      if (!native) return { refused: `No native recognition model is chosen for ${heard}.`, code: 'native_unchosen', params: { source: heard } };
      recognizer = { modelId: native.id, streaming: true, native: { model: native.id, ...(native.limits ? { limits: native.limits } : {}) } };
    } else if (s.asrVia === 'api') {
      const baseUrl = s.asrApiBaseUrl.trim();
      const named = s.asrApiModel.trim();
      recognizer = { modelId: named, streaming: false, api: { baseUrl, model: named, ...(s.asrApiNeedsKey ? { key: 'asrKey' as const } : {}) } };
    } else {
      recognizer = deviceRecognizer(heard, coached ? source : target, s.selections);
    }
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
  const pairFor = (id: string, from: 'translate' | undefined) => (models.some((m) => m.id === id && m.host === KOTOMIMI_HOST && m.from === from) ? { pair: { source: told, target } } : {});

  // Null: the other device's pipeline answers, inside the session it hears in.
  let translate: AnswerStage | null = null;
  if (translatesNatively(s)) {
    // The native translation engine: asked over the chat wire on this computer, in the model's own form of request.
    const native = nativeTranslator(s.translateNativeModel);
    if (!nativeTranslates(native, source, target)) {
      if (!coached) return { refused: `No translation model is downloaded for ${source} → ${target}.`, code: 'local_models_missing' };
    } else {
      translate = { kind: 'translate', engine: 'translator', baseUrl: translatorBaseUrl(), model: native.id, system: '', ...translatorRequest(native, source, target) };
    }
  } else if (s.translateAt === 'device') {
    const id = deviceTranslator(told, target, s.selections);
    if (!id && !coached) return { refused: `No translation model is downloaded for ${told} → ${target}.`, code: 'local_models_missing' };
    if (id) translate = { via: 'device', kind: 'translate', model: id, system: buildDefaultLocalPrompt(deviceLanguage(told), deviceLanguage(target)), wrapTranscript: true };
  } else if (s.translateAt === 'api') {
    if (apiBase && apiModel) translate = { kind: 'translate', baseUrl: apiBase, model: apiModel, ...(s.translateNeedsKey ? { key: 'translateKey' as const } : {}), system: base.instructions, ...pairFor(apiModel, 'translate'), ...quick(apiBase) };
  } else if (asksServer && askedServerModel) {
    // Another Kotomimi answers nothing inside its socket: its pipeline's name, asked over chat, runs its own best translation model for the pair.
    const itsOwn = !serverModel && kotomimi && askedServerModel === pipeline;
    translate = { kind: 'translate', baseUrl: '', model: askedServerModel, ...serverKeyOf(s), system: base.instructions, ...(itsOwn ? { pair: { source: told, target } } : pairFor(askedServerModel, undefined)) };
  }

  let stages: Stages | undefined;
  if (coached) {
    // The speaker practises the target language; their own is the source.
    const prompt = coachPrompt(target, source, s.coachPrompt);
    let coach: AnswerStage;
    if (coachesNatively(s)) {
      // The native feedback engine: a chat model at an address on this computer, asked as an API's is — with the worked examples.
      coach = { kind: 'coach', engine: 'coach', baseUrl: coachBaseUrl(), model: nativeCoach(s.coachNativeModel).id, extra: NATIVE_COACH_EXTRA, system: prompt.system, ...(prompt.shots.length ? { shots: prompt.shots } : {}), language: source };
    } else if (s.coachAt === 'device') {
      const id = deviceCoachModel(s.coachDeviceModel);
      if (!id) return { refused: NO_COACH_HERE, code: 'local_models_missing' };
      // This computer's engines take instructions and one sentence: the worked examples, which go up as earlier turns, stay behind.
      coach = { via: 'device', kind: 'coach', model: id, system: prompt.system, wrapTranscript: false, language: source };
    } else {
      const api = s.coachAt === 'api';
      const baseUrl = api ? s.coachBaseUrl.trim() : '';
      const named = api ? s.coachModel.trim() : s.coachServerModel.trim() || serverDefaultModel(models, 'coach');
      coach = {
        kind: 'coach',
        baseUrl,
        model: named,
        ...(api ? (s.coachNeedsKey ? { key: 'coachKey' as const } : {}) : serverKeyOf(s)),
        system: prompt.system,
        ...(prompt.shots.length ? { shots: prompt.shots } : {}),
        // Feedback is written in the speaker's own language, around a sentence in the one they practise.
        language: source,
        ...(api ? quick(baseUrl) : {}),
      };
    }
    // The speaker speaks the target language; what they type is still their own, and is translated.
    stages = { speech: coach, typed: translate, heard: target };
  } else if (translate) {
    // A detected leg says so to what runs it: the recognizer is told no language, and each sentence is given its own.
    stages = { speech: translate, typed: translate, ...(detected ? { heard: AUTO } : {}) };
  }

  return {
    ...config,
    model,
    modalities: ['text'],
    // This computer's LocalAI is told its recognizer through its pipeline, before the socket opens: the session names none.
    transcription: transcriptionFor(s, heard, Boolean(stages?.speech) || hearsLocal, kotomimi && !hearsLocal, models),
    anchor: false,
    commitAnswers: true,
    ...(stages?.speech && !device ? { transcribeOnly: true as const } : {}),
    ...(stages ? { stages } : {}),
    ...(device ? { device } : {}),
    ...(hearsLocal ? { socket: { endpoint: hereSocket(s) } } : {}),
    ...(hearsLocal && s.asrHereModel.trim() ? { prepare: { pipeline: model, transcription: s.asrHereModel.trim() } } : {}),
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
    // The models a leg's stages load here, each once: the translation's, and the feedback's when it is another.
    const here = [...new Set([config.stages?.speech, config.stages?.typed].flatMap((stage) => (stage?.via === 'device' ? [stage.model] : [])))];
    // An API's recognizer takes none of this computer's memory, and the native engine's is not the app's own to count.
    const hears = config.device && !config.device.api && !config.device.native ? config.device : undefined;
    if (!hears && here.length === 0) continue;
    counted[leg] = {
      asr: { modelId: hears?.modelId ?? '', streaming: hears?.streaming ?? false },
      vad: config.device?.vad ?? { threshold: 0, minSilenceDuration: 0, minSpeechDuration: 0, maxSpeechDuration: 0 },
      translation: here[0] ? { kind: 'engine', modelId: here[0], instructions: '', wrapTranscript: true } : { kind: 'none' },
      // A second model is counted where Local Inference counts its third: by its id alone.
      ...(here[1] ? { tts: { modelId: here[1] } as LocalInferenceConfig['tts'] } : {}),
    };
  }
  return Object.keys(counted).length === 0 ? true : admitLocalInference(counted);
}

/**
 * The pair is the user's own language and the other side's. Their own is
 * never "detect it": it is what they read, and what their words are
 * translated from. The other side's can be left to be detected, which is
 * chosen with it (`asrDetectOther`), not here.
 */
export const localaiLanguages: Provider<LocalAISettings, never, never>['languages'] = {
  ...realtimeLanguages,
  sources: () => REALTIME_LANGUAGES,
};

const adapter = createPipelineAdapter({ prepare: (pipeline, transcription) => setLocalPipeline(pipeline, { transcription }) });

export const localaiProvider: Provider<LocalAISettings, LocalAICredentials, LocalAIConfig> & { id: 'localai' } = {
  id: 'localai',
  kind: 'own-key',
  // A plain `ws://` to a LAN host: the extension's and the web app's content security policies allow neither.
  platforms: ['electron'],
  icon: KotomimiIcon,
  recommended: true,

  settings: { key: 'localai', defaults: LOCALAI_DEFAULTS, legacyKeys: LOCALAI_LEGACY_KEYS, migrate: migrateLocalAISettings },
  Settings: LocalAISettingsView,
  // This computer's own models are chosen and downloaded in the stage's own card (`LocalAIAssist`): there is no page of them apart.
  TurnDetection: { Summary: LocalAITurnDetectionSummary, Controls: LocalAITurnDetectionControls, Help: LocalAITurnDetectionHelp },

  // A stage this computer's LocalAI runs is read as the text model at an address it is (`settled`): no key is asked for it.
  credentials: { ...localaiCredentials, fields: (s) => localaiCredentials.fields(settled(s)) },
  check: (k, s, ctx) => checkLocalAIWithNative(k, s, ctx),
  // What decides the credential fields, the endpoints the check reaches, and the models it asks this computer for.
  checkReads: [
    'asrVia', 'asrApiBaseUrl', 'asrApiModel', 'asrApiNeedsKey', 'asrDetectOther', 'translateAt', 'translateBaseUrl', 'translateNeedsKey', 'coach', 'coachAt', 'coachBaseUrl', 'coachNeedsKey', 'coachDeviceModel', 'serverNeedsKey', 'selections',
    // The models a start needs named (`unnamedStage`).
    'model', 'translateModel', 'translateServerModel', 'coachModel', 'coachServerModel',
    // On this computer: by the app's own models, or by the LocalAI installed here, and then which of its models.
    'asrHere', 'translateHere', 'translateHereModel', 'coachHere', 'coachHereModel', 'hereAddress',
    // Or by the native engine, and then with which of its models.
    'asrNativeModel', 'asrNativeByLanguage', 'translateNativeModel', 'coachNativeModel',
  ],
  // This computer's models are per direction, and each leg needs its own.
  checkReadsDirection: true,
  // This computer's models as they are downloaded, and its LocalAI as it comes up or goes: a stage it runs is ready when it is.
  watchReadiness: (onChange) => {
    const stops = [watchDeviceModels(onChange), useLocalServerStore.subscribe((state) => state.status.state, () => onChange()), watchNativeEngine(onChange)];
    return () => { for (const stop of stops) stop(); };
  },

  languages: localaiLanguages,

  speech: 'never',
  // A coached speaker's session only transcribes: typed text is answered by the translation stage, which an API with no model named cannot be.
  textInput: (stored) => { const s = settled(stored); return !s.coach || s.translateAt !== 'api' || (s.translateBaseUrl.trim() !== '' && s.translateModel.trim() !== ''); },
  boundaries: () => 'provider',
  turns: () => ['auto', 'manual'],

  build: (context, s, shared) => buildLocalAI(context, settled(s), shared),
  describe: describeLocalAI,
  // A run holds the native engines up for as long as a leg of it is open, and a minute more.
  start: async (request, events) => {
    const done = holdNativeForRun();
    try {
      const session = await adapter.start(request, events);
      const stop = session.stop.bind(session);
      session.stop = async () => {
        try {
          await stop();
        } finally {
          done();
        }
      };
      return session;
    } catch (error) {
      done();
      throw error;
    }
  },

  session: { admit: admitLocalAI, prepare: (shape, s, signal) => prepareLocalAI(shape, s, UPS, signal) },
};
