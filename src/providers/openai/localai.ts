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
import { getManifestEntry } from '../../lib/local-inference/modelManifest';
import { boundedFetch } from '../../lib/provider/boundedFetch';
import { CheckError } from '../../lib/provider/checkError';
import { AUTO } from '../../lib/provider/languages';
import { hearsOf, quickOf } from './apiServices';
import type { CheckContext, CheckResult, CredentialField, CredentialsMissing, LanguageOption, MigrationInputs, Provider, ProviderRefusal, SharedSettings } from '../../lib/provider/types';
import { LOCAL_INFERENCE_DEFAULTS } from '../localInference/settings';
import { CHECK_TIMEOUT_MS } from './check';
import { SERVER_SILENT, isKotomimiServer, kindOf, KOTOMIMI_HOST, fitsPair, modelsFor, serverDefaultModel, translationDefault, type LocalAIModel, type LocalAIModelKind } from './localaiModels';
import { coachPrompt } from './coachPrompt';
import { buildRealtime } from './config';
import { glossaryRecognitionTerms } from '../../lib/glossary/glossary';
import { recognizerAsked, serverBilingual } from './serverRecognizers';
import { phoneBase, plainAddress } from '../../lib/lan/discover';
import { alsoFirst, alsoInto, theirsInto, alsoListed, alsoLit, alsoSpoken, backInto, crossings, myRow, theirRow, theirLitLanguages, theyLitOf, deviceLanguage, canDetectOther, hearingOf, type HearingChoice, shownAsSaid, speaksBoth, coachIs, coachesAtOwnDevice, coachesNatively, cutsSentencesHere, hearingPlace, hearsAtOwnDevice, translatesAtOwnDevice, translatePlace, detectsOther, heardBy, hearsNatively, needsServer, serverDetects, PLACE_FIELDS, PLACES, translatesNatively, type AsrHere, type Place } from './localaiDevice';
import { NATIVE_MODELS, isApple, preferNative, type NativeModel, type NativePick } from './localaiNative';
import { NATIVE_DEFAULT_MODEL, appleExtraGap, downloadedAppleLanguages, coachBaseUrl, coachGap, coachIdle, coachUp, hearingPick, hearsByDownloaded, holdNativeForRun, nativeEither, nativeGap, nativeUp, restNative, translatorUp, nativeIdle, nativePicked, translatorBaseUrl, translatorGap, translatorIdle, watchNativeEngine } from './localaiNative';
import { NATIVE_COACH_EXTRA, NATIVE_COACHES, NATIVE_DEFAULT_COACH, nativeCoach } from './nativeCoaches';
import { VOICE_DEFAULTS, clonedVoices, serverLendsVoice, speaksAlong, speaksAtServer, speaksByKeyedApi, speaksNatively, voiceChoice, voiceSpeaks, voiceStageOf, type VoiceChoice } from './localaiVoice';
import { voiceGap, voiceIdle, voiceUnrecorded, voiceUp, warmCloned } from './localaiNative';
import { defaultPairedModel, namedAmong, pairedLanguages, recognitionLimits, speechDetection, tellingOf, toldLanguage, type Telling } from './hearingPlan';
import { NATIVE_DEFAULT_TRANSLATOR, NATIVE_TRANSLATORS, nativeTranslates, nativeTranslator, translatorRequest } from './nativeTranslators';
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
import { phoneTextBase, phoneTextList, warmPhones, type PhoneWarm } from './phoneText';
import { loadPhoneKeys, phoneKey } from '../../lib/lan/phoneKeys';
import { knownDeviceLabel, markKnownDevice, useKnownDeviceStore } from '../../lib/lan/knownDevices';
import { normalizeTranscriptionLanguage, type TranscriptionHint } from './transcription';

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
   * On "another device", a device of the hearing stage's own (`host:port`) in place of the one the stages share: a
   * phone that lends its recognition engine (`android/`), found by the same search. Blank: the shared device. The
   * model is the one it said it lends when it was chosen; a run asks it again (`remoteEngine.ts`).
   */
  asrOther: string;
  asrOtherModel: string;
  /**
   * Fork: the user's own side heard in a place of its own: where, and by what there (`hearingOf`, `localaiDevice.ts`).
   * Null: the two sides are heard in one place, the fields above. Set, those are the other side's.
   */
  asrMine: HearingChoice | null;
  /** Fork: set by `hearingOf` on the settings one side reads, where the other is heard elsewhere; never stored. */
  asrAlone?: LegName;
  /**
   * The other side's language is left to be detected: whoever they are, they
   * are heard and translated into the speaker's language, and the speaker's
   * own speech still goes into the pair's target. It takes a recognizer that
   * detects the language (`detectsOther`).
   */
  asrDetectOther: boolean;
  /**
   * Fork: the speaker speaks the other side's language too: a sentence of theirs in it is translated into their own,
   * one in their own into the other side's, as ever — so that both sides read it (VRChat's chatbox). Takes a
   * recognizer that detects the language. Grammar feedback can answer their speech in the other side's language too.
   */
  speakBoth: boolean;
  /**
   * Fork: the languages the speaker speaks besides their own ("我也会说"): a sentence of theirs in one of them is
   * translated into their own; with the other side's language followed (`follow.ts`), they are heard in any of them
   * whichever the other side speaks. An older `speakBoth` counts as the pair's target among them (`alsoSpoken`); a
   * pick here writes this list and turns that off.
   */
  speakAlso: readonly string[];
  /**
   * Fork: the languages the other side may speak besides the pair's target ("对方也可能说"), `AUTO` for any, kept to be
   * switched to by hand: the one lit (`theyLit`) is heard. An older build's `asrDetectOther` alone counts as any
   * language here (`theyAlsoSpeak`).
   */
  theyAlso: readonly string[];
  /**
   * Fork: the one of `theyAlso` lit (`theyLitOf`): the other side heard in it beside the pair's target, and the user's
   * speech translated into it too. Written with `asrDetectOther`, which is on exactly while one is lit.
   */
  theyLit: string;
  /**
   * What is heard is translated a sentence at a time, as it is said, where the recognizer writes as it hears
   * (`sentenceCut.ts`). Off: a stretch is translated when the recognizer closes it, as upstream does — later, and by
   * the recognizer's last word on it.
   */
  translateBySentence: boolean;
  /** Where it translates. */
  translateAt: Place;
  /** On the other device: the model asked over chat. Blank: the device's own — its pipeline, inside the session it hears in; else the first model it lists that translates. */
  translateServerModel: string;
  /**
   * On "another device", a device of the translation's own (`host:port`) in place of the one the stages share: a
   * phone that lends its text models (`android/`, 0.8.0 on), found by the same search. Blank: the shared device. The
   * model is one of the desktop's native translators it lends, asked in that model's own form (`translatorRequest`).
   */
  translateOther: string;
  translateOtherModel: string;
  /** The translation API's OpenAI-style base URL (`http://localhost:11434/v1`), its model, and whether it wants a key. */
  translateBaseUrl: string;
  translateModel: string;
  translateNeedsKey: boolean;
  /** The speaker practises the other side's language: their speech in it gets grammar feedback. */
  coach: boolean;
  /** Where the feedback is written. */
  coachAt: Place;
  /** On the other device: its text model. Blank: the first it lists. */
  coachServerModel: string;
  /** The same as `translateOther` of the feedback: a phone that lends the desktop's native feedback model, asked as this computer asks its own. */
  coachOther: string;
  coachOtherModel: string;
  /** The feedback API's base URL, its model, and whether it wants a key. */
  coachBaseUrl: string;
  coachModel: string;
  coachNeedsKey: boolean;
  /** The user's own feedback instructions; blank: chosen by the two languages (`coachPrompt.ts`). `{{SPOKEN}}` and `{{NATIVE}}` are filled in. */
  coachPrompt: string;
  /** Legacy runtime field, normalized to the native engine on load. */
  asrHere: AsrHere;
  /** The native engine's model, when it hears. */
  asrNativeModel: string;
  /** The native model chosen for a language, by the language's base code: it is heard by that one whatever is in use (`nativePicked`). */
  asrNativeByLanguage: Record<string, string>;
  translateHere: AsrHere;
  /** The native translation engine's model, when it translates. */
  translateNativeModel: string;
  coachHere: AsrHere;
  /** The native feedback engine's model, when it gives the feedback. */
  coachNativeModel: string;
  /** The other device wants an access key: a credential field appears. */
  serverNeedsKey: boolean;
  /** Fork: whether translations are spoken, where the voice is made and in which voices (`localaiVoice.ts`). */
  speak: VoiceChoice;
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
  asrOther: '',
  asrOtherModel: '',
  asrMine: null,
  asrDetectOther: false,
  speakBoth: false,
  speakAlso: [],
  theyAlso: [],
  theyLit: '',
  translateBySentence: true,
  translateAt: 'server',
  translateServerModel: '',
  translateOther: '',
  translateOtherModel: '',
  translateBaseUrl: '',
  translateModel: '',
  translateNeedsKey: true,
  coach: false,
  coachAt: 'server',
  coachServerModel: '',
  coachOther: '',
  coachOtherModel: '',
  coachBaseUrl: '',
  coachModel: '',
  coachNeedsKey: true,
  coachPrompt: '',
  asrHere: 'native',
  asrNativeModel: NATIVE_DEFAULT_MODEL,
  asrNativeByLanguage: {},
  translateHere: 'native',
  translateNativeModel: NATIVE_DEFAULT_TRANSLATOR,
  coachHere: 'native',
  coachNativeModel: NATIVE_DEFAULT_COACH,
  serverNeedsKey: false,
  speak: VOICE_DEFAULTS,
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

/**
 * The model the speech recognition API is asked for: the one named, or — at a service with one recognizer of its
 * own (`hearsOf`), where there is none to name — what that goes by.
 */
export const asrApiModelOf = (s: Pick<LocalAISettings, 'asrApiBaseUrl' | 'asrApiModel'>): string => hearsOf(s.asrApiBaseUrl)?.name ?? s.asrApiModel.trim();

/** A side's own hearing as it was stored, held to its shape; null for anything else. */
function hearingChoice(value: unknown): HearingChoice | null {
  if (!value || typeof value !== 'object') return null;
  const stored = value as Record<string, unknown>;
  const asrVia = placeOf(stored.asrVia);
  if (!asrVia) return null;
  const text = (k: 'asrModel' | 'asrApiBaseUrl' | 'asrApiModel' | 'asrOther' | 'asrOtherModel') => (typeof stored[k] === 'string' ? (stored[k] as string) : '');
  return { asrVia, asrModel: text('asrModel'), asrApiBaseUrl: text('asrApiBaseUrl'), asrApiModel: text('asrApiModel'), asrApiNeedsKey: stored.asrApiNeedsKey !== false, asrOther: text('asrOther'), asrOtherModel: text('asrOtherModel') };
}

export function migrateLocalAISettings(stored: Readonly<Record<string, unknown>>, inputs: MigrationInputs): LocalAISettings {
  const text = (k: 'asrModel' | 'asrApiBaseUrl' | 'asrApiModel' | 'asrOther' | 'asrOtherModel' | 'translateOther' | 'translateOtherModel' | 'coachOther' | 'coachOtherModel' | 'translateBaseUrl' | 'coachPrompt' | 'asrNativeModel' | 'translateNativeModel' | 'coachNativeModel') => (typeof stored[k] === 'string' ? (stored[k] as string) : LOCALAI_DEFAULTS[k]);
  const flag = (k: 'asrApiNeedsKey' | 'asrDetectOther' | 'speakBoth' | 'coach' | 'serverNeedsKey' | 'translateBySentence') => (typeof stored[k] === 'boolean' ? (stored[k] as boolean) : LOCALAI_DEFAULTS[k]);
  const number = (k: (typeof VAD_FIELDS)[number]) => (typeof stored[k] === 'number' && Number.isFinite(stored[k]) ? (stored[k] as number) : LOCALAI_DEFAULTS[k]);
  return {
    ...migrateRealtimeSettings(stored, inputs),
    asrVia: placeOf(stored.asrVia) ?? LOCALAI_DEFAULTS.asrVia,
    asrModel: text('asrModel'),
    asrApiBaseUrl: text('asrApiBaseUrl'),
    asrApiModel: text('asrApiModel'),
    asrApiNeedsKey: flag('asrApiNeedsKey'),
    asrOther: text('asrOther'),
    asrOtherModel: text('asrOtherModel'),
    asrMine: hearingChoice(stored.asrMine),
    asrDetectOther: flag('asrDetectOther'),
    speakBoth: flag('speakBoth'),
    speakAlso: Array.isArray(stored.speakAlso) ? (stored.speakAlso as unknown[]).filter((code): code is string => typeof code === 'string' && code.trim() !== '') : [],
    theyAlso: Array.isArray(stored.theyAlso) ? (stored.theyAlso as unknown[]).filter((code): code is string => typeof code === 'string' && code.trim() !== '') : [],
    theyLit: typeof stored.theyLit === 'string' ? stored.theyLit : LOCALAI_DEFAULTS.theyLit,
    translateBySentence: flag('translateBySentence'),
    translateOther: text('translateOther'),
    translateOtherModel: text('translateOtherModel'),
    coachOther: text('coachOther'),
    coachOtherModel: text('coachOtherModel'),
    translateBaseUrl: text('translateBaseUrl'),
    coach: flag('coach'),
    coachPrompt: text('coachPrompt'),
    asrHere: 'native',
    asrNativeModel: text('asrNativeModel'),
    asrNativeByLanguage: byLanguage(stored.asrNativeByLanguage),
    translateHere: 'native',
    translateNativeModel: text('translateNativeModel'),
    coachHere: 'native',
    coachNativeModel: text('coachNativeModel'),
    ...migratePlaces(stored, inputs.legacy ?? {}),
    serverNeedsKey: flag('serverNeedsKey'),
    speak: voiceChoice(stored.speak),
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

export { kindOf, modelsFor, serverDefaultModel, translationDefault, type LocalAIModel, type LocalAIModelKind, type LocalAIModelSlot } from './localaiModels';
export { detectsOther, heardBy, needsServer, PLACES, type Place } from './localaiDevice';

/**
 * The settings as everything past the stage cards reads them: a hearing stage
 * on a device of its own is the API it is asked as, with no key, so it is
 * checked, built and run by the code an API's is.
 */
export function settled(stored: LocalAISettings): LocalAISettings {
  // A phone that lends its recognizer: its address and the model it lends, asked as an API's are. The run finds out
  // what it is and reads it live (`pipeline.ts`, `remoteEngine.ts`).
  const asApi = <C extends HearingChoice>(c: C): C => (hearsAtOwnDevice(c)
    ? { ...c, asrVia: 'api', asrApiBaseUrl: phoneBase({ address: plainAddress(c.asrOther) }), asrApiModel: c.asrOtherModel, asrApiNeedsKey: false }
    : c);
  // Each side's own, where the user's is heard apart (`hearingOf`).
  const s: LocalAISettings = { ...asApi(stored), asrMine: stored.asrMine ? asApi(stored.asrMine) : null };
  // LocalAI is retired: a setting kept from it falls to the native engine of this computer.
  return {
    ...s,
    asrHere: 'native',
    translateHere: 'native',
    coachHere: 'native',
  };
}

const SIDES: readonly LegName[] = ['speaker', 'participant'];
/** A stage of either side's run is on the shared device (`needsServer`, of each side's own hearing), or the voice is. */
const needsServerEither = (s: LocalAISettings): boolean => SIDES.some((leg) => needsServer(hearingOf(s, leg))) || speaksAtServer(s.speak);

/** Every field is drawn by the provider's own view, beside the stage it belongs to (`LocalAIAssist`): the address with the search that finds it, a key with the API it opens. */
const own = (key: string, labelKey: string, secret: boolean, placeholderKey = labelKey): CredentialField => ({ key, labelKey, secret, placeholderKey, drawnByAssist: true });

export const localaiCredentials: Provider<LocalAISettings, LocalAICredentials, never>['credentials'] = {
  keys: ['endpoint', 'serverKey', 'asrKey', 'translateKey', 'coachKey', 'speakKey'],
  fields: (s): CredentialField[] => [
    ...(needsServerEither(s) ? [own('endpoint', 'providers.localai.endpoint', false, 'providers.localai.endpointPlaceholder')] : []),
    ...(needsServerEither(s) && s.serverNeedsKey ? [own('serverKey', 'providers.localai.serverKey', true)] : []),
    // One key for the recognition API, whichever side it hears: two services for the two sides would need two.
    ...(SIDES.some((leg) => { const one = hearingOf(s, leg); return one.asrVia === 'api' && one.asrApiNeedsKey; }) ? [own('asrKey', 'providers.localai.asrKey', true)] : []),
    ...(s.translateAt === 'api' && s.translateNeedsKey ? [own('translateKey', 'providers.localai.translateKey', true)] : []),
    ...(coachIs(s, 'api') && s.coachNeedsKey ? [own('coachKey', 'providers.localai.coachKey', true)] : []),
    ...(speaksByKeyedApi(s.speak) ? [own('speakKey', 'providers.localai.speakKey', true)] : []),
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
    const speakKey = values.speakKey?.trim();
    if (values.serverKey !== undefined && !serverKey) return { missing: 'Enter the access key of the server.', code: 'server_key_missing' };
    if (values.asrKey !== undefined && !asrKey) return { missing: 'Enter the API key of the speech recognition API.' };
    if (values.translateKey !== undefined && !translateKey) return { missing: 'Enter the API key of the translation model.' };
    if (values.coachKey !== undefined && !coachKey) return { missing: 'Enter the API key of the feedback model.' };
    // No Realtime key (see the header) unless the server asks for one: the adapter then offers no subprotocol.
    return { apiKey: serverKey ?? '', endpoint, ...(asrKey ? { asrKey } : {}), ...(translateKey ? { translateKey } : {}), ...(coachKey ? { coachKey } : {}), ...(speakKey ? { speakKey } : {}) };
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
 * card is where it is fixed (`noticeText`'s parameters). Asked by the builder, and
 * by the check for every leg, so the card never says "ready" to a run its
 * start would refuse. `coached`: the speaker's own leg, whose speech the
 * feedback answers. Without bilingual speech, only typed text needs translation.
 */
function unnamedStage(s: LocalAISettings, models: readonly LocalAIModel[], coached: boolean, asIs = false, both = false): ProviderRefusal | null {
  const hearsHere = s.asrVia !== 'server';
  const pipeline = needsServer(s) ? effectiveLocalAIModel(s, models) : '';
  if (!hearsHere && !pipeline) return { refused: 'No model is named, and the server lists none.', code: 'asr_unnamed' };
  if (s.asrVia === 'api' && (!s.asrApiBaseUrl.trim() || !asrApiModelOf(s))) return { refused: 'No speech recognition API is named.', code: 'asr_unnamed' };
  // Fork: a leg shown as said (`shownAsSaid`) has nothing that answers it.
  if (asIs) return null;
  if (!coached || both) {
    if (s.translateAt === 'api' && (!s.translateBaseUrl.trim() || !s.translateModel.trim())) return { refused: 'No translation model is named.', code: 'translate_unnamed' };
    // A phone of the translation's own lends a model, chosen with it.
    if (translatesAtOwnDevice(s) && !s.translateOtherModel.trim()) return { refused: 'No translation model is named.', code: 'translate_unnamed' };
    const kotomimi = needsServer(s) && isKotomimiServer(models);
    const serverModel = s.translateServerModel.trim();
    // A model of the other device is asked by name: none is named, and none of its own fits.
    const asksServer = translatePlace(s) === 'server' && (serverModel !== '' || kotomimi || hearsHere || both);
    if (asksServer && !(serverModel || (kotomimi && pipeline ? pipeline : translationDefault(models)))) return { refused: 'No translation model is named.', code: 'translate_unnamed' };
  }
  if (!coached) return null;
  if (s.coachAt === 'api' && (!s.coachBaseUrl.trim() || !s.coachModel.trim())) return { refused: 'No feedback model is named.', code: 'coach_unnamed' };
  if (coachesAtOwnDevice(s)) return s.coachOtherModel.trim() ? null : { refused: 'No feedback model is named.', code: 'coach_unnamed' };
  if (s.coachAt === 'server' && !(s.coachServerModel.trim() || serverDefaultModel(models))) return { refused: 'No feedback model is named.', code: 'coach_unnamed' };
  return null;
}

/**
 * A translation model named for the other device that cannot take a leg's direction. Only what the device says of
 * its models can answer this (a Kotomimi lists a model's languages, and a directional model's pair); a server that
 * says nothing of them is left alone. A model named is never answered by another in its place (`src/lib/lan/`), so
 * the card refuses before the run rather than a sentence failing — or being translated by a model nobody chose.
 */
function serverTranslatorUnfit(
  s: LocalAISettings, models: readonly LocalAIModel[], pair: { source: string; target: string }, leg: LegName, heard: string, spoken: string[] = [],
): ProviderRefusal | null {
  const named = s.translateServerModel.trim();
  if (!named || translatePlace(s) !== 'server' || translatesAtOwnDevice(s)) return null;
  const model = models.find((m) => m.id === named);
  if (!model) return null;
  // A speaker who speaks other languages has each translated back (`Stages.back`); a named model must take every direction.
  const directions: Array<[string, string]> = leg === 'speaker'
    ? [
      [pair.source, pair.target],
      ...spoken.map((also) => [also, pair.source] as [string, string]),
      ...crossings(s, pair, spoken).map((c) => [c.source, c.target] as [string, string]),
      ...((into) => (into ? [[pair.source, into] as [string, string]] : []))(alsoInto(s, pair)),
    ]
    : [[heard, pair.source]];
  for (const [source, target] of directions) {
    // A leg whose language is left to be detected has no source the model could be measured against.
    if (!source || source === AUTO || fitsPair(model, source, target)) continue;
    return {
      refused: `${named} does not translate ${source} → ${target}.`,
      code: 'server_translator_unfit',
      params: { name: getManifestEntry(named)?.name ?? nativeTextName(named) },
    };
  }
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
 * A leg another Kotomimi hears in a language none of its recognizers takes (a language to detect, where none it lists
 * detects, is the leg's own source: what the session is told, `serverHeard`):
 * its socket would refuse the session ("shares no speech recognition model",
 * `src/lib/lan/transcriber.ts`), which a start would show in that device's
 * English. It says which languages each recognizer takes, as it picks among
 * them (`appModels.ts`); one that says none takes any, and so does one it
 * lends from a model server beside it (a LocalAI), whose languages it does
 * not know. `heard`: the language the leg hears.
 */
function unheard(s: LocalAISettings, models: readonly LocalAIModel[], heard: string, family?: readonly string[] | null): ProviderRefusal | null {
  if (s.asrVia !== 'server' || heard === AUTO || !isKotomimiServer(models)) return null;
  const language = deviceLanguage(heard);
  if (family ? family.includes(language) : modelsFor(models, 'asr').some((m) => m.host !== KOTOMIMI_HOST || !m.languages?.length || m.languages.includes(language))) return null;
  return { refused: `The other device shares no speech recognition model for ${heard}.`, code: 'server_no_asr', params: { source: heard } };
}

/**
 * A device lent to hear (a phone, the iPad) whose recognizer is known not to take a language the leg asks of it: its
 * main language, or one the user also speaks. Refused here, at the start and at a switch alike, rather than every
 * stretch being refused there once it runs. A recognizer whose languages are not known is left to answer for itself.
 */
function phoneUnheard(s: LocalAISettings, pair: { source: string; target: string }, leg: LegName, heard: string, hearer: ReturnType<typeof hearerOf>): ProviderRefusal | null {
  const address = s.asrOther?.trim() ?? '';
  if (!address || s.asrVia !== 'api' || s.asrApiBaseUrl.trim().replace(/\/+$/, '') !== phoneTextBase(address)) return null;
  const languages = hearer?.languages?.filter((code) => code !== AUTO) ?? [];
  if (!hearer?.languages || (!languages.length && hearer.telling.by !== 'pairing')) return null;
  const asked = hearer.telling.by === 'pairing' ? [toldLanguage(heard, leg === 'speaker' ? pair.source : pair.target, false)]
    : leg === 'speaker' ? [heard === AUTO ? pair.source : heard, ...(s.coach ? [] : alsoSpoken(s, pair))] : heard !== AUTO ? [heard] : [];
  const missing = asked.find((code) => !languages.some((has) => deviceLanguage(has) === deviceLanguage(code)));
  if (!missing) return null;
  return {
    refused: `The phone (${plainAddress(address)}) hears no ${missing} with ${hearer.name}.`,
    code: 'phone_no_language',
    params: { address: plainAddress(address), name: hearer.name, source: missing },
  };
}

/** An explicitly selected paired recognizer or bilingual mode must not silently become single-language. */
function pairingFor(s: LocalAISettings, models: readonly LocalAIModel[], pair: { source: string; target: string }, leg: LegName, heard: string, hearer: ReturnType<typeof hearerOf>) {
  if (hearer?.telling.by !== 'pairing') return undefined;
  const primary = toldLanguage(heard, leg === 'speaker' ? pair.source : pair.target, false);
  const lit = theirLitLanguages(s, pair);
  const required = heard !== AUTO ? [] : leg === 'speaker' ? alsoSpoken(s, pair, models, hearer.telling) : lit.slice(1);
  const has = (code: string) => !hearer.languages || hearer.languages.some((one) => deviceLanguage(one) === deviceLanguage(code));
  const place = hearingPlace(s);
  const extras = place === 'api' && heard !== AUTO ? [] : pairedLanguages({
    leg, told: primary, pair, most: hearer.telling.most, theirLit: lit, alsoSpoken: required, has,
  });
  const remote = place === 'server' && extras.length ? serverBilingual(s.asrModel, { source: primary, target: extras[0] }, models, extras[1]) : null;
  const paired = place === 'server' ? remote?.languages.slice(1) ?? [] : extras;
  if (hearer.native) {
    const absent = has(primary) ? appleExtraGap(hearer.native, required) : null;
    const gap: ProviderRefusal | undefined = absent ? { refused: absent.reason, code: absent.code, params: absent.params } : undefined;
    return { required, paired, remote, gap };
  }
  const missing = has(primary) && required.find((code) => !paired.includes(deviceLanguage(code)));
  let gap: ProviderRefusal | undefined;
  if (missing) {
    if (place === 'api') {
      const address = plainAddress(s.asrOther || s.asrApiBaseUrl);
      gap = { refused: `The phone (${address}) hears no ${missing} with ${hearer.name}.`, code: 'phone_no_language', params: { address, name: hearer.name, source: missing } };
    } else {
      const source = deviceLanguage(primary);
      const target = deviceLanguage(missing);
      gap = { refused: `The other device cannot recognize both ${source} and ${target} with the selected model.`, code: 'server_no_bilingual', params: { source, target } };
    }
  }
  return { required, paired, remote, gap };
}

export interface LocalAICheckDeps {
  fetch?: typeof fetch;
  clock?: Pick<Clock, 'setTimeout'>;
}

/** `phone`: the address of the phone that is the stage's own device, where it is one (`settled` made it an API). */
interface OtherServer { slot: 'translate' | 'coach' | 'asr'; name: string; base: string; key?: string; phone?: string }

/** The APIs the stages name: listed for their models, and required to accept the key. */
function otherServers(k: LocalAICredentials, s: LocalAISettings): OtherServer[] {
  const out: OtherServer[] = [];
  const base = (url: string) => url.trim().replace(/\/+$/, '');
  for (const leg of SIDES) {
    const one = hearingOf(s, leg);
    if (one.asrVia !== 'api' || !one.asrApiBaseUrl.trim() || out.some((had) => had.slot === 'asr' && had.base === base(one.asrApiBaseUrl))) continue;
    const phone = one.asrOther.trim() && base(one.asrApiBaseUrl) === phoneTextBase(one.asrOther) ? plainAddress(one.asrOther) : '';
    // A phone that asks for its access key is asked with the one given for it (`phoneKeys.ts`).
    out.push({ slot: 'asr', name: 'speech recognition', base: base(one.asrApiBaseUrl), key: (one.asrApiNeedsKey ? k.asrKey : undefined) || (phone ? phoneKey(phone) || undefined : undefined), ...(phone ? { phone } : {}) });
  }
  if (s.translateAt === 'api' && s.translateBaseUrl.trim()) out.push({ slot: 'translate', name: 'translation', base: base(s.translateBaseUrl), key: k.translateKey });
  if (coachIs(s, 'api') && s.coachBaseUrl.trim()) out.push({ slot: 'coach', name: 'feedback', base: base(s.coachBaseUrl), key: k.coachKey });
  return out;
}

/** A text stage on a phone of its own, as the check asks it: the phone, and the model chosen there. */
interface PhoneStage { kind: 'translate' | 'coach'; address: string; model: string }

/** The text stages a run of these legs asks a phone: the feedback only where the speaker is heard. */
function phoneStages(s: LocalAISettings, legs: readonly LegName[]): PhoneStage[] {
  return [
    ...(translatesAtOwnDevice(s) ? [{ kind: 'translate' as const, address: plainAddress(s.translateOther), model: s.translateOtherModel.trim() }] : []),
    ...(coachesAtOwnDevice(s) && legs.includes('speaker') ? [{ kind: 'coach' as const, address: plainAddress(s.coachOther), model: s.coachOtherModel.trim() }] : []),
  ];
}

/**
 * A translation on a phone whose model does not translate the leg's pair (Hunyuan MT's thirty-six languages): said
 * as the card says it, by the model's name. A model this computer does not know is asked as an API's, and not judged.
 */
function phoneTranslatorUnfit(s: LocalAISettings, source: string, target: string): ProviderRefusal | null {
  if (!translatesAtOwnDevice(s)) return null;
  const model = NATIVE_TRANSLATORS.find((m) => m.id === s.translateOtherModel.trim());
  if (!model || nativeTranslates(model, source, target)) return null;
  return { refused: `${model.name} does not translate ${source} → ${target}.`, code: 'phone_translator_unfit', params: { name: model.name } };
}

/** A text model of the desktop's own, by the name it has here; its id where it has none. */
const nativeTextName = (id: string): string => NATIVE_TRANSLATORS.find((m) => m.id === id)?.name ?? NATIVE_COACHES.find((m) => m.id === id)?.name ?? id;

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

/** A lent device's recognizers (`hear`, the iPad app's), each with the languages it lists for it: none, where it lists none. */
const hearListing = (body: unknown): Map<string, string[] | undefined> => {
  const out = new Map<string, string[] | undefined>();
  const hear = (body as { hear?: unknown } | null)?.hear;
  if (!Array.isArray(hear)) return out;
  for (const m of hear as Array<{ id?: unknown; languages?: unknown }>) {
    if (typeof m?.id !== 'string' || !m.id || out.has(m.id)) continue;
    const languages = Array.isArray(m.languages) ? m.languages.filter((l): l is string => typeof l === 'string' && /^[a-z]{2,3}([-_][A-Za-z0-9]{2,8})?$/i.test(l)).slice(0, 60) : undefined;
    out.set(m.id.slice(0, 80), languages);
  }
  return out;
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
    void useKnownDeviceStore.getState().hydrate();
    const late = `A server did not answer its model list within ${CHECK_TIMEOUT_MS / 1000} s.`;
    // The other device's and the APIs' failures are coded (`CheckError`, `providers.localai.*` by `noticeText`): a person reads
    // where to look, not the check's English, which stays the message for the logs. The bound passing is one more.
    const slow = (error: unknown): never => {
      if (!ctx.signal?.aborted && error instanceof Error && error.message === late) throw new CheckError(late, 'check_slow', { seconds: CHECK_TIMEOUT_MS / 1000 });
      throw error;
    };
    // The keys of phones that ask for one, read before any is asked (`phoneKeys.ts`).
    await loadPhoneKeys();
    const phones = phoneStages(s, ctx.legs);
    const servers = needsServerEither(s) || otherServers(k, s).length > 0 || phones.length > 0
      ? await boundedFetch({ clock, ms: CHECK_TIMEOUT_MS, signal: ctx.signal, late }, async (signal): Promise<CheckResult> => {
        const models: LocalAIModel[] = [];
        // The shared device's own list, into `models`. A refusal, or null.
        const listServer = async (): Promise<CheckResult | null> => {
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
          // Another Kotomimi says which languages each of its models takes, too — and which direction a pair model translates.
          const languages = new Map<string, readonly string[]>();
          const bilingual = new Set<string>();
          const trilingual = new Set<string>();
          const pairs = new Map<string, readonly string[]>();
          try {
            const answer = await doFetch(`${localaiModelsUrl(k.endpoint)}/capabilities`, listing(k.apiKey, signal));
            if (answer.ok) {
              for (const m of ((await answer.json()) as { data?: Array<{ id?: unknown; capabilities?: unknown; languages?: unknown; pair?: unknown }> }).data ?? []) {
                if (typeof m.id !== 'string') continue;
                kinds.set(m.id, kindOf(m.capabilities));
                if (Array.isArray(m.capabilities) && m.capabilities.includes('bilingual')) bilingual.add(m.id);
                if (Array.isArray(m.capabilities) && m.capabilities.includes('trilingual')) trilingual.add(m.id);
                if (Array.isArray(m.languages)) languages.set(m.id, m.languages.filter((l): l is string => typeof l === 'string'));
                if (Array.isArray(m.pair) && m.pair.length === 2 && m.pair.every((one) => typeof one === 'string')) pairs.set(m.id, m.pair as string[]);
              }
            }
          } catch (error) {
            if (signal.aborted) throw error;
          }
          for (const m of own) {
            const taken = m.kotomimi ? languages.get(m.id) : undefined;
            const pair = m.kotomimi ? pairs.get(m.id) : undefined;
            models.push({
              id: m.id,
              ...(kinds.has(m.id) ? { kind: kinds.get(m.id) } : {}),
              ...(m.kotomimi ? { host: KOTOMIMI_HOST } : {}),
              ...(taken?.length ? { languages: taken } : {}),
              ...(m.kotomimi && bilingual.has(m.id) ? { bilingual: true } : {}),
              ...(m.kotomimi && trilingual.has(m.id) ? { trilingual: true } : {}),
              ...(pair ? { pair } : {}),
            });
          }
          return null;
        };
        if (needsServerEither(s)) {
          // Fork: only the voice is there, and this run does not speak by itself (said on demand alone, or the other
          // side's leg alone): the device is asked for what it lends, and a run does not wait on its answer.
          const unused = !SIDES.some((leg) => needsServer(hearingOf(s, leg))) && !(ctx.legs.includes('speaker') && speaksAlong(s.speak));
          try {
            const refused = await listServer();
            if (refused && !unused) return refused;
          } catch (error) {
            if (signal.aborted || !unused) throw error;
          }
        }

        // Known limit: the lists are merged by model, not by device. Two lent devices, one a side, that name their
        // recognizer alike (two iPads' "apple-speech") are read as one, with the languages of the first.
        for (const other of otherServers(k, s)) {
          let answer: Response;
          try {
            answer = await doFetch(`${other.base}/models`, listing(other.key, signal));
          } catch (error) {
            if (signal.aborted) throw error;
            if (other.phone) markKnownDevice(other.phone, false);
            // A phone the stage was given as its device is said to be one, by the address it was found at.
            if (other.phone) {
              const label = knownDeviceLabel(other.phone);
              throw new CheckError(`The ${label.tablet ? 'tablet' : 'phone'} (${label.address}) could not be reached.`, 'phone_unreachable', { address: label.address, name: label.name, form: label.tablet ? 'tablet' : 'phone' });
            }
            throw new CheckError(`The ${other.name} model's server (${other.base}) could not be reached.`, 'api_unreachable', { address: other.base });
          }
          if (other.phone) markKnownDevice(other.phone, true);
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
          const body: unknown = await answer.json().catch(() => null);
          const theirs = listed(body);
          // The speech recognition API's list is offered for its model field as it is: nothing says which of them hear.
          // A lent device (the iPad) also lists every recognizer it can be asked for by name, with the languages of
          // those it has them for (`hear`): what a side may add, and what a run may ask of it, is read from them.
          if (other.slot === 'asr') {
            const hears = hearListing(body);
            for (const m of theirs) models.push({ id: m.id, kind: 'asr', from: 'asr', ...(hears.get(m.id) ? { languages: hears.get(m.id) } : {}) });
            for (const [id, languages] of hears) {
              if (!theirs.some((m) => m.id === id)) models.push({ id, kind: 'asr', from: 'asr', ...(languages ? { languages } : {}) });
            }
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
            if (kind === 'asr' || kind === 'voice' || kind === 'other') continue;
            models.push({ id: m.id, kind: m.kotomimi ? 'translate' : 'text', from: other.slot, ...(m.kotomimi ? { host: KOTOMIMI_HOST } : {}) });
          }
        }

        // A phone a text stage was given: it answers, and lends the model chosen there now — read from its `text`, never
        // its `data`, which lists its recognizer (a desktop that reads only `data` takes every name there for one).
        for (const phone of phones) {
          // One with no model chosen is refused below, as a stage with none (`unnamedStage`).
          if (!phone.model) continue;
          let lent: Awaited<ReturnType<typeof phoneTextList>>;
          try {
            lent = await phoneTextList(phone.address, doFetch, signal);
          } catch (error) {
            if (signal.aborted) throw error;
            lent = null;
          }
          if (lent === null) {
            const label = knownDeviceLabel(phone.address);
            throw new CheckError(`The ${label.tablet ? 'tablet' : 'phone'} (${label.address}) could not be reached.`, 'phone_unreachable', { address: label.address, name: label.name, form: label.tablet ? 'tablet' : 'phone' });
          }
          const chosen = lent.find((m) => m.id === phone.model && m.kind === phone.kind);
          if (!chosen) {
            const what = phone.kind === 'translate' ? 'translation' : 'feedback';
            return { ok: false, code: 'phone_model_gone', params: { address: phone.address, name: nativeTextName(phone.model) }, reason: `The phone (${phone.address}) lends no ${what} model ${phone.model} now.` };
          }
          // It lends it, and would refuse every sentence for it: it has not the memory now (`phoneRoom`).
          if (chosen.fits === false) {
            return { ok: false, code: 'phone_model_too_big', params: { address: phone.address, name: nativeTextName(phone.model) }, reason: `The phone (${phone.address}) has not the memory for ${phone.model} now.` };
          }
        }
        return { ok: true, models };
      }).catch(slow)
      : ({ ok: true, models: [] } as CheckResult);
    if (!servers.ok) return servers;

    // Only the speaker is coached.
    const whole = s;
    for (const leg of ctx.legs) {
      // Fork: the leg as its own hearing reads the settings (`hearingOf`).
      const s = hearingOf(whole, leg);
      const coached = s.coach && leg === 'speaker';
      const found = servers.models ?? [];
      // What the leg hears: the speaker their own language, or — coached — the one they practise; the other side theirs.
      const heard = heardBy(s, ctx.pair, leg, found);
      // Fork: a leg shown as said needs no translation stage at all.
      const plain = shownAsSaid(s, ctx.pair, leg, found);
      const both = leg === 'speaker' && speaksBoth(s, found, ctx.pair) && ctx.pair.source.toLowerCase() !== ctx.pair.target.toLowerCase();
      // What the leg translates: the speaker the pair and — when it speaks both — its reverse; the other side its reverse.
      const hearer = hearerOf(s, found, ctx.pair, leg);
      const pairing = pairingFor(s, found, ctx.pair, leg, heard, hearer);
      const spoken = both ? pairing?.required ?? alsoSpoken(s, ctx.pair, found) : [];
      const unfitServer = serverTranslatorUnfit(s, found, ctx.pair, leg, heard, spoken);
      const primary = toldLanguage(heard, leg === 'speaker' ? ctx.pair.source : ctx.pair.target, !pairing && serverDetects(found, s.asrModel));
      const gap = (hearsNatively(s) ? null : pairing?.gap) ?? unfitServer ?? unnamedStage(s, found, coached, plain, both) ?? undetected(s, found, leg === 'speaker' ? ctx.pair.source : heard, coached, leg === 'participant' ? ctx.pair.target : undefined) ?? unheard(s, found, primary, pairing ? hearer?.languages : undefined)
        ?? phoneUnheard(s, ctx.pair, leg, heard, hearer)
        ?? ((coached && !both) || plain ? null : phoneTranslatorUnfit(s, leg === 'speaker' ? ctx.pair.source : heard, leg === 'speaker' ? ctx.pair.target : ctx.pair.source))
        ?? spoken.reduce<ProviderRefusal | null>((found, also) => found ?? phoneTranslatorUnfit(s, also, ctx.pair.source), null)
        ?? crossings(s, ctx.pair, spoken).reduce<ProviderRefusal | null>((found, c) => found ?? phoneTranslatorUnfit(s, c.source, c.target), null)
        ?? ((into) => (leg === 'speaker' && into && !(coached && !both) ? phoneTranslatorUnfit(s, ctx.pair.source, into) : null))(alsoInto(s, ctx.pair));
      // Fork: another Kotomimi with nothing for the leg's language is told which, and offers a model to download for it
      // in its own settings. Not waited for: the refusal stands, whatever it answers.
      if (gap?.code === 'server_no_asr' && gap.params?.source && needsServer(s)) {
        const asks = new URLSearchParams({ asks: String(gap.params.source), ...(s.asrModel.trim() ? { model: s.asrModel.trim() } : {}) });
        void doFetch(`${localaiModelsUrl(k.endpoint)}/capabilities?${asks}`, listing(k.apiKey, AbortSignal.timeout(CHECK_TIMEOUT_MS))).catch(() => undefined);
      }
      // What the servers listed goes with the refusal: a pick from it is often what answers it.
      if (gap) return { ok: false, reason: gap.refused, ...(gap.code ? { code: gap.code } : {}), ...(gap.params ? { params: gap.params } : {}), ...(servers.models?.length ? { models: servers.models } : {}) };
    }

    return servers;
  };
}

export const checkLocalAI = createLocalAICheck();

/** What a run would start of the native engines: the models that hear its legs, its translator, its feedback model. */
interface NativeNeeds {
  hears?: { pick: NativePick; heard: string[] };
  translates?: string;
  coaches?: string;
  speaks?: string;
  /** Fork: the user's own voices the run speaks in, each with a language it reads, where its voice model clones them: read by the engine as the run begins. */
  speaksIn?: readonly { voice: string; language: string }[];
}

/** Fork: what this computer's recognizer hears a run's languages with (`hearingPick`), for the run's pair. */
export const runHearing = (s: LocalAISettings, pair: { source: string; target: string }, models: readonly LocalAIModel[] = []): NativePick => {
  const also = alsoFirst(s, pair, models);
  // Fork: of the side this computer hears alone, where the other is elsewhere (`hearingOf`): the other side's
  // detection, or the speaker's two languages, are then no reason to pick a model that tells languages apart.
  const detecting = s.asrAlone !== 'speaker' && detectsOther(s, models);
  const both = s.asrAlone !== 'participant' && speaksBoth(s, models, pair) && pair.source.toLowerCase() !== pair.target.toLowerCase();
  return hearingPick(s, also ? { source: pair.source, target: also } : pair, {
    detecting,
    both,
    bestEffort: both || (s.asrAlone !== 'speaker' && s.asrDetectOther === true),
  });
};

/** Resolve an explicit side choice before auto merges the two legs. */
export function runSideHearing(s: LocalAISettings, pair: { source: string; target: string }, leg: 'speaker' | 'participant', models: readonly LocalAIModel[] = []): NativePick {
  const own = leg === 'speaker' ? pair.source : pair.target;
  const key = leg === 'participant' && s.asrDetectOther ? 'auto' : own.toLowerCase().split(/[-_]/)[0];
  const chosen = s.asrNativeByLanguage[key] ?? (isApple(s.asrNativeModel) ? s.asrNativeModel : undefined);
  if (!chosen || !NATIVE_MODELS.some((m) => m.id === chosen)) return runHearing(s, pair, models);
  const telling = tellingOf('device', chosen);
  const others = leg === 'speaker' ? alsoSpoken(s, pair, models, telling) : theirLitLanguages(s, pair).slice(1);
  // Fork: the user's own side alone on this computer is heard by its own choice whatever it hears (`nativeChoiceRows`).
  const heard = leg === 'speaker' && s.asrAlone === 'speaker' ? heardBy(s, pair, leg, models) : AUTO;
  const pick: NativePick = { model: chosen, byLanguage: { ...s.asrNativeByLanguage, auto: chosen, [own.toLowerCase().split(/[-_]/)[0]]: chosen, ...(heard !== AUTO ? { [heard.toLowerCase().split(/[-_]/)[0]]: chosen } : {}) }, bestEffort: telling.by === 'told' };
  if (telling.by === 'pairing' && others.length) pick.either = { own, others };
  return pick;
}

/** The same picks readiness and startup must load, even when both legs are auto. */
function runHearingNeeds(s: LocalAISettings, pair: { source: string; target: string }, legs: readonly ('speaker' | 'participant')[]): { pick: NativePick; heard: string[] } {
  const pick = runHearing(s, pair);
  const selections = legs.map((leg) => {
    const side = runSideHearing(s, pair, leg);
    const nominal = leg === 'speaker' ? pair.source : pair.target;
    const language = toldLanguage(heardBy(s, pair, leg), nominal, nativePicked(side, nominal)?.detects === true);
    return { pick: side, language };
  });
  if (Object.keys(s.asrNativeByLanguage).length || selections.some((side) => isApple(side.pick.model) || side.pick.either)) pick.selections = selections;
  return { pick, heard: selections.map((side) => side.language) };
}

/** Fork: a recognizer that tells more languages apart than this offers "any language" (SenseVoice's five do not). */
const ANY_PAST = 5;

/** The Mac's recognition as another device's model names it whole (its languages are `apple-speech:<code>`). */
const APPLE_NAME = 'apple-speech';

/**
 * Fork: what hears a leg, as the language section names it (`languages.hearing`): this computer's model by its name and
 * the languages it tells apart; another device's or an API's by the model named, its languages not known here.
 */
function hearerOf(s: LocalAISettings, models: readonly LocalAIModel[], pair: { source: string; target: string }, leg: LegName): { name: string; languages: readonly string[] | null; telling: Telling; native?: NativeModel } | undefined {
  if (hearsNatively(s)) {
    const heard = heardBy(s, pair, leg, models);
    const model = nativePicked(runSideHearing(s, pair, leg, models), toldLanguage(heard, leg === 'speaker' ? pair.source : pair.target, false));
    if (!model) return undefined;
    const telling = tellingOf('device', model.id);
    return { native: model, name: model.name.replace(/ GGUF$/, ''), languages: telling.by === 'pairing' ? downloadedAppleLanguages() : model.languages, telling };
  }
  let named = (s.asrVia === 'api' ? asrApiModelOf(s) : hearsAtOwnDevice(s) ? s.asrOtherModel : s.asrModel).trim();
  const place = hearingPlace(s);
  if (!named && place === 'server') {
    const primary = toldLanguage(heardBy(s, pair, leg, models), leg === 'speaker' ? pair.source : pair.target, false);
    named = defaultPairedModel({ leg, told: primary, pair, theirLit: theirLitLanguages(s, pair), alsoSpoken: alsoLit(s, pair) }, models);
  }
  if (!named) return undefined;
  const telling = tellingOf(place, named, models);
  // The Mac's recognition is named as a whole ("apple-speech") and listed a language at a time ("apple-speech:ja").
  // The iPad names it whole too, and lists the languages downloaded there with it (`hearListing`).
  if (telling.by === 'pairing') {
    const languages = place === 'server' ? models.filter((m) => !m.from && isApple(m.id)).map((m) => m.id.slice(APPLE_NAME.length + 1))
      : models.find((m) => m.id === named)?.languages;
    return { name: 'Apple Speech', languages: languages ?? null, telling };
  }
  const model = models.find((m) => m.id === named);
  const listed = model?.languages?.filter((code) => code !== AUTO);
  // A model of this app's own names, lent by another device: what it is here (its languages, whether it detects).
  const known = NATIVE_MODELS.find((m) => m.id === named);
  const name = known ? known.name.replace(/ GGUF$/, '') : nativeTextName(named);
  const languages = listed?.length ? listed : known?.languages ?? null;
  return { name, languages, telling };
}

/** Fork: the legs this computer's own recognizer hears, and the settings as the first of them reads them (`hearingOf`): where both do, they read alike. */
function nativeHearing(s: LocalAISettings, legs: readonly LegName[]): { s: LocalAISettings; legs: LegName[] } | null {
  const here = legs.filter((leg) => hearsNatively(hearingOf(s, leg)));
  return here.length > 0 ? { s: hearingOf(s, here[0]), legs: here } : null;
}

/**
 * Fork: whether a run speaks by itself: the stage set to, and its voice speaking one of the languages the user's
 * sentences go into (`theirsInto`). The check and the engines' needs ask it of the settings alone: a run that puts
 * nothing into their second language after all (a coached speaker's, one the other device's own session answers)
 * still has a voice that speaks only that one checked and loaded. `lent`: what the other device lists, where it speaks.
 */
function voicesAny(choice: VoiceChoice, into: readonly string[], lent: readonly LocalAIModel[] = []): boolean {
  return speaksAlong(choice) && into.some((language) => voiceSpeaks(choice, language, lent));
}

function nativeNeeds(s: LocalAISettings, pair: { source: string; target: string }, legs: readonly ('speaker' | 'participant')[]): NativeNeeds {
  const here = nativeHearing(s, legs);
  return {
    ...(here ? { hears: runHearingNeeds(here.s, pair, here.legs) } : {}),
    // Not where every leg is shown as said: nothing would ask it.
    ...(translatesNatively(s) && legs.some((leg) => !shownAsSaid(s, pair, leg)) ? { translates: s.translateNativeModel } : {}),
    ...(coachesNatively(s) && legs.includes('speaker') ? { coaches: s.coachNativeModel } : {}),
    // Only the speaker's leg speaks.
    ...(legs.includes('speaker') && voicesAny(s.speak, theirsInto(s, pair)) && speaksNatively(s.speak) ? { speaks: s.speak.nativeModel, ...(clonedVoices(s.speak, theirsInto(s, pair)) ? { speaksIn: clonedVoices(s.speak, theirsInto(s, pair))!.reads } : {}) } : {}),
  };
}

export interface NativeUps { hears: typeof nativeUp; translates: typeof translatorUp; coaches: typeof coachUp; speaks?: typeof voiceUp; /** Fork: the recordings a cloning voice model will speak from, read ahead (`warmCloned`). */ reads?: typeof warmCloned; rest: typeof restNative }
const UPS: NativeUps = { hears: nativeUp, translates: translatorUp, coaches: coachUp, speaks: voiceUp, reads: warmCloned, rest: restNative };

/** The engines a run needs, brought up side by side and waited for. Rejects with the first that did not come up. */
async function bringUp(needs: NativeNeeds, ups: NativeUps): Promise<boolean> {
  const starts = [
    ...(needs.hears ? [ups.hears(needs.hears.pick, needs.hears.heard)] : []),
    ...(needs.translates ? [ups.translates(needs.translates)] : []),
    ...(needs.coaches ? [ups.coaches(needs.coaches)] : []),
    // The engine up, its recordings are read behind the run's back: the first sentence in one would wait for that.
    ...(needs.speaks && ups.speaks ? [ups.speaks(needs.speaks).then(() => { if (needs.speaksIn?.length) ups.reads?.(needs.speaks!, needs.speaksIn); })] : []),
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
 * The models a run will ask of a phone (a text stage's own device), with what goes before the sentence in each request:
 * the feedback's instructions and worked examples, which the phone then reads once, here (`warmPhones`).
 */
export function phoneWarms(s: LocalAISettings, pair: { source: string; target: string }, legs: readonly LegName[]): PhoneWarm[] {
  const out: PhoneWarm[] = [];
  for (const stage of phoneStages(s, legs)) {
    if (!stage.model || out.some((w) => w.address === stage.address && w.model === stage.model)) continue;
    if (stage.kind === 'translate') {
      const native = NATIVE_TRANSLATORS.find((m) => m.id === stage.model);
      out.push({ address: stage.address, model: stage.model, messages: [], ...(native ? { extra: translatorRequest(native, pair.source, pair.target).extra } : {}) });
    } else {
      // The speaker practises the target language; their own is the source (as `buildLocalAI` asks it).
      const prompt = coachPrompt(pair.target, pair.source, s.coachPrompt);
      const messages = [
        { role: 'system' as const, content: prompt.system },
        ...prompt.shots.flatMap((shot) => [{ role: 'user' as const, content: shot.said }, { role: 'assistant' as const, content: shot.answer }]),
      ];
      out.push({ address: stage.address, model: stage.model, messages, ...(NATIVE_COACHES.some((m) => m.id === stage.model) ? { extra: NATIVE_COACH_EXTRA } : {}) });
    }
  }
  return out;
}

/** `fetch` as it is when called, so a test's stubbed global is seen. */
const fetchNow: typeof fetch = (input, init) => fetch(input, init);

/**
 * A run's first step: the native engines it needs are loaded, and waited
 * for. Until now nothing held their models in memory; the translation and
 * the feedback are then built with the addresses the engines answer at.
 */
export async function prepareLocalAI(shape: { pair: { source: string; target: string }; legs: readonly ('speaker' | 'participant')[] }, stored: LocalAISettings, ups: NativeUps = UPS, signal?: AbortSignal, warm: (wanted: readonly PhoneWarm[], signal: AbortSignal) => Promise<void> = (wanted, until) => warmPhones(wanted, fetchNow, until)): Promise<Record<string, never>> {
  // A phone a text stage is given is asked to load its model as the run begins, and not waited for (`warmPhones`):
  // stopped with the run.
  const warms = phoneWarms(stored, shape.pair, shape.legs);
  if (warms.length > 0) void warm(warms, signal ?? new AbortController().signal).catch(() => undefined);
  const needs = nativeNeeds(settled(stored), shape.pair, shape.legs);
  // The run holds its engines from here to its end, whatever that end is: a stop, a refusal after this step, a leg
  // that never opened, the page going away — the run's signal is aborted on every one of them. Not only from the
  // moment a leg opens: its source may take a minute to open, and the minute's rest would have stopped them by then.
  if (signal && (needs.hears || needs.translates || needs.coaches || needs.speaks)) {
    const asrModels = needs.hears ? (needs.hears.pick.selections ?? needs.hears.heard.map((language) => ({ pick: needs.hears!.pick, language }))).flatMap(({ pick, language }) => {
      const model = nativePicked(pick, language);
      return model ? [model.id] : [];
    }) : [];
    const done = holdNativeForRun(undefined, { asr: !!needs.hears && hearsByDownloaded(needs.hears.pick, needs.hears.heard), asrModels, translation: !!needs.translates });
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
export async function checkLocalAIWithNative(k: LocalAICredentials, s: LocalAISettings, ctx: CheckContext, check: typeof checkLocalAI = checkLocalAI, native: { gap: typeof nativeGap; idle: typeof nativeIdle; translatorGap?: typeof translatorGap; translatorIdle?: typeof translatorIdle; coachGap?: typeof coachGap; coachIdle?: typeof coachIdle; voiceGap?: typeof voiceGap; voiceIdle?: typeof voiceIdle; voiceUnrecorded?: typeof voiceUnrecorded } = { gap: nativeGap, idle: nativeIdle }): Promise<CheckResult> {
  // Asked first, beside the servers.
  let hears: ReturnType<typeof nativeGap> | null = null;
  const here = nativeHearing(s, ctx.legs);
  if (here) {
    // What each leg hears: the speaker their own language, or — coached — the one they practise; the other side theirs.
    const needs = runHearingNeeds(here.s, ctx.pair, here.legs);
    hears = native.gap(needs.pick, needs.heard);
    hears.catch(() => undefined);
  } else {
    native.idle();
  }
  const servers = await check(k, settled(s), ctx);
  const models = servers.models ?? [];
  let translates: ReturnType<typeof translatorGap> | null = null;
  if (translatesNatively(s)) {
    // What each leg translates: the speaker the pair, plus its reverse when bilingual; the other side its reverse.
    const reverse = { source: ctx.pair.target, target: ctx.pair.source };
    const mine = settled(hearingOf(s, 'speaker'));
    const telling = hearerOf(mine, models, ctx.pair, 'speaker')?.telling;
    const both = speaksBoth(s, telling?.by === 'pairing' ? models : [], ctx.pair) && ctx.pair.source.toLowerCase() !== ctx.pair.target.toLowerCase();
    const spoken = both ? backInto(s, ctx.pair, models, telling) : [];
    const back = spoken.map((also) => ({ source: also, target: ctx.pair.source }));
    // Fork: a sentence in one of two lit languages of theirs goes into the other; the speech into their second one lit.
    const cross = crossings(s, ctx.pair, spoken);
    const into = alsoInto(s, ctx.pair);
    // As the start builds it (`buildLocalAI`): not for a speaker coached in their own language alone, whose speech nothing translates.
    const forward = [ctx.pair, ...back, ...cross, ...(into && !(s.coach && !both) ? [{ source: ctx.pair.source, target: into }] : [])];
    translates = (native.translatorGap ?? translatorGap)(s.translateNativeModel, ctx.legs.flatMap((leg) => (leg === 'speaker' ? forward : [reverse])));
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
  let speaks: ReturnType<typeof voiceGap> | null = null;
  // Only where a run speaks by itself: a stage kept for lines said on demand loads its model when one is asked for.
  const usesVoice = ctx.legs.includes('speaker') && voicesAny(s.speak, theirsInto(s, ctx.pair), models);
  if (usesVoice && speaksNatively(s.speak)) {
    speaks = (native.voiceGap ?? voiceGap)(s.speak.nativeModel);
    speaks.catch(() => undefined);
  } else {
    (native.voiceIdle ?? voiceIdle)();
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
  if (!servers.ok) return servers;
  // Fork: the other device lends no voice model, or not the one chosen: said by the card it is chosen in.
  if (usesVoice && speaksAtServer(s.speak) && !serverLendsVoice(s.speak, models)) {
    return { ok: false, reason: 'The other device lends no voice model.', code: 'server_no_voice', ...(servers.models?.length ? { models: servers.models } : {}) };
  }
  // Fork: a voice API with no model named: said here, by the card it is named in, before a start would refuse it.
  if (usesVoice && !voiceStageOf(s.speak, [ctx.pair.target], models)) {
    return { ok: false, reason: 'No voice API is named.', code: 'voice_unnamed', ...(servers.models?.length ? { models: servers.models } : {}) };
  }
  if (usesVoice && speaksByKeyedApi(s.speak) && !k.speakKey) {
    return { ok: false, reason: 'Enter the API key of the voice.', ...(servers.models?.length ? { models: servers.models } : {}) };
  }
  // Fork: a cloning voice model reads in the user's own voices: one chosen for each language it reads, and still there.
  // Wherever the cloning model runs: on another Kotomimi it is handed the same recordings.
  const cloned = usesVoice && (speaksNatively(s.speak) || speaksAtServer(s.speak)) ? clonedVoices(s.speak, theirsInto(s, ctx.pair), models) : null;
  const unrecorded = cloned ? (native.voiceUnrecorded ?? voiceUnrecorded)(cloned) : null;
  const refused = (hears ? await hears : null) ?? (translates ? await translates : null) ?? (coaches ? await coaches : null) ?? (speaks ? await speaks : null) ?? unrecorded;
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

export function buildLocalAI(asked: SessionContext, all: LocalAISettings, shared: SharedSettings): LocalAIConfig | ProviderRefusal {
  // Fork: where this leg is heard: the user's own side may have a place of its own (`hearingOf`).
  // By the leg the request names; a caller that names none (a pair of two languages tells them apart) by its direction.
  const s = hearingOf(all, asked.leg ?? (shared.reversed(asked.direction) ? 'participant' : 'speaker'));
  const models: readonly LocalAIModel[] = shared.models;
  // The other side's leg, with their language left to be detected: built as a leg whose source is to be detected.
  const participant = shared.reversed(asked.direction);
  const leg = participant ? 'participant' : 'speaker';
  const runPair = participant ? { source: asked.direction.target, target: asked.direction.source } : asked.direction;
  const hearer = hearerOf(s, models, runPair, leg);
  const requested = heardBy(s, runPair, leg, models);
  const pairing = pairingFor(s, models, runPair, leg, requested, hearer);
  if (pairing) {
    const gap = pairing.gap ?? unheard(s, models, toldLanguage(requested, asked.direction.source, false), hearer?.languages)
      ?? phoneUnheard(s, runPair, leg, requested, hearer);
    if (gap) return gap;
  }
  const detected = detectsOther(s, models) && participant && (!pairing || pairing.paired.length > 0);
  const context: SessionContext = detected ? { ...asked, direction: { source: AUTO, target: asked.direction.target } } : asked;
  const { source, target } = context.direction;
  // What a translation that has to be told a pair is told: the pair's own language, where the leg's is left to be detected.
  const told = detected ? asked.direction.source : source;
  // Heard without any Realtime session: by this computer's own recognizer, or by an API it uploads each sentence to.
  const hearsHere = cutsSentencesHere(s);
  // The other device's pipeline: what its Realtime socket runs, and — on another Kotomimi — the name its own choice of translation model is asked by.
  const pipeline = needsServer(s) ? effectiveLocalAIModel(s, models) : '';
  const model = hearsHere ? '' : pipeline;
  const kotomimi = needsServer(s) && isKotomimiServer(models);
  // The speaker alone is coached: the participant leg always hears the other side, and translates it. Asked of the
  // direction the leg was given: with its source rewritten to be detected it is no longer the pair's reverse, and
  // the other side's leg was taken for the speaker's — heard in the user's language and answered with feedback, no
  // translation at all (feedback on, detection on; found 2026-10-06, in every build since detection was a choice).
  const coached = s.coach && !shared.reversed(asked.direction);
  // Fork: heard in the language it is shown in (Chinese to Chinese): shown as said, nothing translates it.
  const plain = !coached && !detected && source.toLowerCase() === target.toLowerCase();
  // Fork: the speaker heard in either language, each sentence translated into the other (`speakBoth`).
  const both = source.toLowerCase() !== target.toLowerCase() && !shared.reversed(asked.direction) && speaksBoth(s, models, asked.direction);
  const soloCoach = coached && !both;
  /**
   * Fork: the languages they speak besides their own that are in use (those the other side has lit): each heard, and
   * translated back (`Stages.back`) and across into the other lit one (`Stages.cross`); the first, what pairs with theirs.
   */
  const also = both ? pairing?.required ?? alsoSpoken(s, asked.direction, models) : [];
  const crossed = both ? crossings(s, asked.direction, also) : [];
  const alsoMain = both ? alsoFirst(s, asked.direction, models) ?? target : target;

  // Every stage named, before anything is built: a run with none has nothing to say. A coached speaker's translation
  // is for what they type only: the run starts without it. A leg shown as said has none.
  const gap = unnamedStage(s, models, coached, plain, both) ?? undetected(s, models, source, coached, detected ? told : undefined);
  if (gap) return gap;
  const apiBase = s.translateBaseUrl.trim();
  const apiModel = s.translateModel.trim();
  const serverModel = s.translateServerModel.trim();
  // No session of the device's own pipeline answers this leg's text: one of its models is asked instead.
  const asksServer = translatePlace(s) === 'server' && (serverModel !== '' || kotomimi || hearsHere || coached || both);
  const askedServerModel = serverModel || (kotomimi && pipeline ? pipeline : translationDefault(models));

  // OpenAI Realtime's builder for the instructions and the detection, with the model pinned so it picks no other.
  const pinned = model || LOCALAI_DEFAULT_MODEL;
  const base = buildRealtime(context, { ...s, model: pinned }, { ...shared, models: [{ id: pinned }] });
  if ('refused' in base) return base;
  const { voice: _voice, reasoningEffort: _reasoning, ...config } = base;

  const hints = shared.glossary ? glossaryRecognitionTerms(shared.glossary) : [];
  // What hears is asked first: a run with no recognizer has nothing to translate.
  const heard = both ? AUTO : coached ? target : source;
  // A model that cannot name a language is still told the leg's own source; `identify.ts` names each sentence.
  const modelHeard = toldLanguage(heard, asked.direction.source, false);
  // A speaker who speaks more than one: a stretch named outside them is read again (`namedAmong`).
  const among = namedAmong(heard, source, also);
  const remotePair = pairing?.remote;
  let device: DeviceHearing | undefined;
  /** A native model that names the language, where one is downloaded: the leg is asked for `auto` through it. */
  let detector: ReturnType<typeof nativePicked> = null;
  /** A service's own recognizer (`hearsOf`): it detects the language, takes none, and names none. */
  let untold = false;
  if (hearsHere) {
    let recognizer: Pick<DeviceHearing, 'modelId' | 'streaming' | 'api' | 'native'> | null;
    if (hearsNatively(s)) {
      const native = hearer?.native;
      detector = native?.detects ? native : null;
      // The language has no native model chosen: said as that, since downloading one would not help.
      if (!native) return { refused: `No native recognition model is chosen for ${modelHeard}.`, code: 'native_unchosen', params: { source: modelHeard } };
      // Fork: the Mac's recognition hears the pair's other language beside the leg's own, where it has both: the
      // speaker in either (`speakBoth`), told their own; else any leg, told its own — a sentence in the other is then
      // known for what it is, not guessed from its writing.
      recognizer = { modelId: native.id, streaming: true, native: { model: native.id, ...(native.limits ? { limits: native.limits } : {}), ...(pairing?.paired.length ? { either: { first: modelHeard, also: pairing.paired } } : {}), ...(native.takesHints !== false && hints.length ? { hints } : {}) } };
    } else if (s.asrVia === 'api') {
      const baseUrl = s.asrApiBaseUrl.trim();
      const named = asrApiModelOf(s);
      // A model of this app's own names: what a Kotomimi phone lends is read by its engine the way it is read here.
      const known = NATIVE_MODELS.find((m) => m.id === named);
      const limits = recognitionLimits(named);
      // A model that names the language (Qwen3-ASR, on a lent device) is asked for "auto" as it is here: told the
      // leg's nominal language it heard everything as that.
      detector = known?.detects ? known : null;
      untold = hearsOf(baseUrl) !== undefined;
      recognizer = { modelId: named, streaming: false, api: { baseUrl, model: named, ...(s.asrApiNeedsKey ? { key: 'asrKey' as const } : {}), ...(limits ? { limits } : {}), ...(hints.length ? { hints } : {}) } };
    } else {
      recognizer = null;
    }
    if (!recognizer) return { refused: `No speech recognition model is downloaded for ${modelHeard}.`, code: 'no_asr', params: { source: modelHeard } };
    device = {
      ...recognizer,
      ...(pairing?.paired.length ? { pairedWith: pairing.paired } : {}),
      // Only a soft leg needs the model told a language of its own; a detector is asked for "auto".
      ...(heard === AUTO && !detector ? { language: toldLanguage(heard, modelHeard, false) } : {}),
      // One that cannot be told another language is not asked again: what it writes outside them is not written.
      ...((detector || untold) && among.length ? { among } : {}),
      vad: speechDetection(s).vad,
    };
  }

  /**
   * What translates `from` → `to` (`instructions` for a chat model; `from` is `auto` for a leg left to be detected,
   * and another Kotomimi is told so, as this computer's and a phone's translators are): null where the other device's pipeline answers, inside the session it hears in, or where a
   * coached speaker has none (what they type then goes untranslated). Fork: asked twice for a speaker who speaks both.
   */
  const translatorFor = (from: string, to: string, instructions: string): AnswerStage | null | ProviderRefusal => {
    /** A model another Kotomimi shares is told the pair: it runs a translation model, not a chat model. */
    const pairFor = (id: string, kind: 'translate' | undefined) => (models.some((m) => m.id === id && m.host === KOTOMIMI_HOST && m.from === kind) ? { pair: { source: from, target: to } } : {});
    if (translatesAtOwnDevice(s)) {
      // A phone that lends the translation: one of this computer's native translators, asked as this computer asks its
      // own — in the model's own form of request — at the phone's address. With no `engine`: that would ask this
      // computer's own engine where it answers, and send the request there.
      const id = s.translateOtherModel.trim();
      const native = NATIVE_TRANSLATORS.find((m) => m.id === id);
      const unfit = phoneTranslatorUnfit(s, from, to);
      if (unfit) return soloCoach ? null : unfit;
      // A model this computer does not know (a later phone's) is asked as an API's is.
      return { kind: 'translate', baseUrl: phoneTextBase(s.translateOther), model: id, phone: true, ...(native ? { system: '', ...translatorRequest(native, from, to) } : { system: instructions }) };
    }
    if (translatesNatively(s)) {
      // The native translation engine: asked over the chat wire on this computer, in the model's own form of request.
      const native = nativeTranslator(s.translateNativeModel);
      if (!nativeTranslates(native, from, to)) return soloCoach ? null : { refused: `No translation model is downloaded for ${from} → ${to}.`, code: 'local_models_missing' };
      return { kind: 'translate', engine: 'translator', baseUrl: translatorBaseUrl(), model: native.id, system: '', ...translatorRequest(native, from, to) };
    }
    if (s.translateAt === 'api') {
      return apiBase && apiModel ? { kind: 'translate', baseUrl: apiBase, model: apiModel, ...(s.translateNeedsKey ? { key: 'translateKey' as const } : {}), system: instructions, ...pairFor(apiModel, 'translate'), ...quick(apiBase) } : null;
    }
    if (asksServer && askedServerModel) {
      // Another Kotomimi answers nothing inside its socket: its pipeline's name, asked over chat, runs its own best translation model for the pair.
      const itsOwn = !serverModel && kotomimi && askedServerModel === pipeline;
      return { kind: 'translate', baseUrl: '', model: askedServerModel, ...serverKeyOf(s), ...(kotomimi ? { loads: true as const } : {}), system: instructions, ...(itsOwn ? { pair: { source: from, target: to } } : pairFor(askedServerModel, undefined)) };
    }
    return null;
  };

  // Null: the other device's pipeline answers, inside the session it hears in. A leg shown as said has nothing.
  let translate: AnswerStage | null = null;
  if (!plain) {
    const chosen = translatorFor(source, target, base.instructions);
    if (chosen && 'refused' in chosen) return chosen;
    translate = chosen;
  }
  // Fork: a speaker who speaks both is answered in their own language when they speak the other side's.
  // A coached speaker is too, beside the feedback, when they speak the one they practise — where the translation
  // they have takes that direction (asked of a named model as the other side's leg asks it); a run starts without.
  let back: AnswerStage | undefined;
  const practised = soloCoach && !serverTranslatorUnfit(s, models, { source, target }, 'participant', target) ? [target] : [];
  const backFrom = both ? also : practised;
  if (translate && backFrom.length > 0) {
    // Out of the one language they speak besides their own, or — where they speak more — whichever it was.
    const from = backFrom.length === 1 ? backFrom[0] : AUTO;
    const reversed = buildRealtime({ ...context, direction: { source: from, target: told } }, { ...s, model: pinned }, { ...shared, models: [{ id: pinned }] });
    const chosen = translatorFor(from, told, 'refused' in reversed ? base.instructions : reversed.instructions);
    if (chosen && 'refused' in chosen) return chosen;
    // Its answers are in the speaker's own language; this computer's engine is loaded for that direction.
    if (chosen) back = { ...chosen, language: told };
  }
  // Fork: a sentence in one of two lit languages of theirs, which the speaker speaks too, goes into the other one.
  const cross: Array<{ language: string; stage: AnswerStage }> = [];
  if (both && translate) {
    for (const c of crossed) {
      const across = buildRealtime({ ...context, direction: { source: c.source, target: c.target } }, { ...s, model: pinned }, { ...shared, models: [{ id: pinned }] });
      const chosen = translatorFor(c.source, c.target, 'refused' in across ? base.instructions : across.instructions);
      if (chosen && 'refused' in chosen) return chosen;
      if (chosen) cross.push({ language: c.source, stage: { ...chosen, language: c.target } });
    }
  }
  // Fork: the other side's second language, lit by hand (`alsoInto`): the speaker's sentences go into it as well, a
  // second answer beside the first (the VRChat chatbox shows both). Not into "any language", which is no language.
  let into: AnswerStage | undefined;
  const lit = shared.reversed(asked.direction) || soloCoach ? undefined : alsoInto(s, asked.direction);
  if (translate && lit) {
    const forward = buildRealtime({ ...context, direction: { source, target: lit } }, { ...s, model: pinned }, { ...shared, models: [{ id: pinned }] });
    const chosen = translatorFor(source, lit, 'refused' in forward ? base.instructions : forward.instructions);
    if (chosen && 'refused' in chosen) return chosen;
    if (chosen) into = { ...chosen, language: lit };
  }

  let coaching: AnswerStage | undefined;
  if (coached) {
    // The speaker practises the target language; their own is the source.
    const prompt = coachPrompt(target, source, s.coachPrompt);
    let coach: AnswerStage;
    if (coachesAtOwnDevice(s)) {
      // A phone that lends the feedback model: asked as this computer asks its own native one, at the phone's address.
      const id = s.coachOtherModel.trim();
      const known = NATIVE_COACHES.some((m) => m.id === id);
      coach = { kind: 'coach', baseUrl: phoneTextBase(s.coachOther), model: id, phone: true, ...(known ? { extra: NATIVE_COACH_EXTRA } : {}), system: prompt.system, ...(prompt.shots.length ? { shots: prompt.shots } : {}), language: source };
    } else if (coachesNatively(s)) {
      // The native feedback engine: a chat model at an address on this computer, asked as an API's is — with the worked examples.
      coach = { kind: 'coach', engine: 'coach', baseUrl: coachBaseUrl(), model: nativeCoach(s.coachNativeModel).id, extra: NATIVE_COACH_EXTRA, system: prompt.system, ...(prompt.shots.length ? { shots: prompt.shots } : {}), language: source };
    } else {
      const api = s.coachAt === 'api';
      const baseUrl = api ? s.coachBaseUrl.trim() : '';
      const named = api ? s.coachModel.trim() : s.coachServerModel.trim() || serverDefaultModel(models);
      coach = {
        kind: 'coach',
        baseUrl,
        model: named,
        ...(api ? (s.coachNeedsKey ? { key: 'coachKey' as const } : {}) : serverKeyOf(s)),
        ...(!api && kotomimi ? { loads: true as const } : {}),
        system: prompt.system,
        ...(prompt.shots.length ? { shots: prompt.shots } : {}),
        // Feedback is written in the speaker's own language, around a sentence in the one they practise.
        language: source,
        ...(api ? quick(baseUrl) : {}),
      };
    }
    coaching = coach;
  }

  let stages: Stages | undefined;
  if (plain) {
    stages = { speech: null, typed: null, asIs: true };
  } else if (soloCoach && coaching) {
    // The speaker speaks the target language; what they type is still their own, and is translated. Fork: what they
    // say in it is translated back for them as well (`back`), the feedback beside it.
    stages = { speech: coaching, typed: translate, heard: target, ...(back ? { back: { stage: back, language: target, own: told }, feedback: { stage: coaching, language: target } } : {}) };
  } else if (translate) {
    // A detected leg says so to what runs it: the recognizer is told no language, and each sentence is given its own.
    stages = {
      speech: translate,
      typed: translate,
      ...(detected || both ? { heard: AUTO } : {}),
      // The pair's two languages, each answered by the stage that translates out of it.
      ...(back || cross.length ? { back: { ...(back ? { stage: back } : {}), language: alsoMain, own: told, languages: also } } : {}),
      ...(cross.length ? { cross } : {}),
      ...(coaching ? { feedback: { stage: coaching, language: target } } : {}),
      ...(into ? { into } : {}),
      ...(s.translateBySentence ? {} : { whole: true }),
    };
  }

  // A paired recognizer identifies the language at finalization. Show tentative words immediately, but do not
  // translate or classify them by their script before that decision (English and French share one, for example).
  if (stages && pairing) stages = { ...stages, named: 'recognizer', ...(pairing.paired.length ? { requiresLanguage: true } : {}) };
  // The speaker's microphone: the other side's sound, come back through loudspeakers, is told from their own voice by
  // the other leg hearing it at the same moment (`leakCheck` in pipeline.ts). The other side's leg is that sound.
  if (stages && !shared.reversed(asked.direction)) stages = { ...stages, leakCheck: true };
  // Fork: the speaker's leg speaks its translations into the other side's languages (their main one, and the second
  // lit beside it), and what they type in a language of the other side's, where the voice stage is on (`context.speech`, by `speaks`). A leg the other device's own
  // session answers has no stage of its own: it is given the voice alone, and its session's translations are spoken.
  if (asked.speech && (asked.leg ? asked.leg === 'speaker' : !participant) && voicesAny(s.speak, lit ? [target, lit] : [target], models)) {
    const voice = voiceStageOf(s.speak, [target, ...(lit ? [lit] : []), ...also], models);
    if (!voice) return speaksAtServer(s.speak) ? { refused: 'The other device lends no voice model.', code: 'server_no_voice' } : { refused: 'No voice API is named.', code: 'voice_unnamed' };
    stages = { ...(stages ?? { speech: null, typed: null }), voice };
  }

  // Another Kotomimi whose recognizer does not name the language is told this leg's own source; `identify.ts` names the rest.
  const serverHeard = toldLanguage(heard, asked.direction.source, hearingPlace(s) !== 'server' || serverDetects(models, s.asrModel));

  // Another Kotomimi that hears for this one cuts its sentences with this one's own speech detection, as this
  // computer's engine would: its threshold and pause, where Realtime's semantic default became a 0.8 s pause there.
  const ownDetection = kotomimi && !device && config.turnDetection ? { turnDetection: speechDetection(s).turnDetection } : {};
  // Another Kotomimi that detects the language hears the speaker's languages too, as this computer's engine would (`among`).
  const remoteAmong = kotomimi && !device && !remotePair && serverHeard === AUTO && among.length > 1 ? { among } : {};

  return {
    ...config,
    ...ownDetection,
    // Another Kotomimi hearing for this one takes the quick pace a video in VRChat asks for.
    ...(kotomimi && !device ? { paces: true as const } : {}),
    model,
    modalities: ['text'],
    transcription: { ...(remotePair ? { ...remotePair, language: remotePair.languages[0] } : transcriptionFor(s, serverHeard, Boolean(stages?.speech) || plain, kotomimi, models)), ...remoteAmong, ...(kotomimi && hints.length ? { keywords: [...hints] } : {}) },
    anchor: false,
    commitAnswers: true,
    ...((stages?.speech || plain) && !device ? { transcribeOnly: true as const } : {}),
    ...(stages ? { stages } : {}),
    ...(device ? { device } : {}),
    ...(shared.glossary ? { glossary: shared.glossary } : {}),
  };
}

/** Two models, as OpenAI Realtime describes them: what answers speech — the stage's, or the server's pipeline — and what writes the source. */
export function describeLocalAI(c: LocalAIConfig): { translationModel: string; asrModel?: string } {
  const asrModel = c.device?.modelId ?? c.transcription.model;
  return { translationModel: c.stages?.speech?.model ?? c.model, ...(asrModel ? { asrModel } : {}) };
}

/**
 * Fork: the Realtime list and Cantonese, which the on-device recognizers and translators take (Qwen3-ASR,
 * SenseVoice-Small, Apple Speech; Index-Translate, Hunyuan MT 2) and Realtime does not list.
 */
export const LOCAL_LANGUAGES: readonly LanguageOption[] = [...REALTIME_LANGUAGES, { value: 'yue' }];

/**
 * The pair is the user's own language and the other side's. Their own is
 * never "detect it": it is what they read, and what their words are
 * translated from. The other side's can be left to be detected, which is
 * chosen with it (`asrDetectOther`), not here.
 */
export const localaiLanguages: Provider<LocalAISettings, never, never>['languages'] = {
  ...realtimeLanguages,
  sources: () => LOCAL_LANGUAGES,
  targets: () => LOCAL_LANGUAGES,
  // Fork: what each side may speak beside its main language, and what hears it (`MoreLanguages`).
  more: (stored, models, pair) => {
    const s = settled(stored);
    const listed = models as readonly LocalAIModel[];
    /** Pairing limits simultaneous languages. The other side lights one extra at a time. */
    const reach = (hearer: ReturnType<typeof hearerOf>, mine: boolean) => {
      if (hearer?.telling.by === 'naming') return { offered: hearer.languages, most: null, any: (hearer.languages?.length ?? 0) > ANY_PAST };
      if (hearer?.telling.by === 'pairing') return { offered: hearer.languages, most: mine ? hearer.telling.most - 1 : 1, any: false };
      return { offered: hearer?.languages ?? null, most: 0, any: false };
    };
    const mineHearer = hearerOf(hearingOf(s, 'speaker'), listed, pair, 'speaker');
    const theirsHearer = hearerOf(s, listed, pair, 'participant');
    const strip = (h: typeof mineHearer) => (h ? { hearer: { name: h.name, languages: h.languages } } : {});
    const spoken = alsoListed(s, pair);
    const using = alsoSpoken(s, pair, listed, mineHearer?.telling);
    const quiet = alsoLit(s, pair).filter((code) => !using.includes(code));
    return {
      mine: {
        ...strip(mineHearer),
        ...reach(mineHearer, true),
        chosen: spoken,
        // In use: those the other side has lit. The row as shown, their own language among it.
        using,
        ...(quiet.length && mineHearer ? { quiet: { codes: quiet, by: mineHearer.name } } : {}),
        row: myRow(s, pair),
        set: (chosen) => ({ speakAlso: [...chosen], speakBoth: false }),
      },
      theirs: {
        ...strip(theirsHearer),
        ...reach(theirsHearer, false),
        // Their row, their main language among it; the one lit beside it (`theirLanguages.ts` switches them).
        chosen: theirRow(s, pair.target),
        lit: theyLitOf(s, pair.target),
        set: (chosen) => ({ theyAlso: [...chosen], ...(chosen.includes(theyLitOf(s, pair.target)) ? {} : { theyLit: '', asrDetectOther: false }) }),
        light: (code) => ({ theyLit: code, asrDetectOther: code !== '' }),
      },
    };
  },
  detection: (stored, models, pair) => {
    // Detection controls describe the selected recognizer. A downloaded alternative must not change the choice
    // or gate a best-effort run; model readiness is checked separately when the session starts.
    const all = settled(stored);
    // Fork: each side by what hears it (`hearingOf`): the other side's detection is its recognizer's to do, the
    // speaker's two languages their own's.
    const of = (s: LocalAISettings) => {
      const available = canDetectOther(s, models);
      // The speaker in either of the pair's languages: also the Mac's recognition, where it hears theirs and has both.
      const second = alsoFirst(s, pair, models) ?? pair.target;
      const either = (hearsNatively(s) && second !== undefined && nativeEither({ model: s.asrNativeModel, byLanguage: s.asrNativeByLanguage, either: { own: pair.source, others: [second] } }) !== null)
        || (hearingPlace(s) === 'server' && second !== undefined && serverBilingual(s.asrModel, { source: pair.source, target: second }, models as readonly LocalAIModel[]) !== null);
      // A model chosen here that names the language, or a paired Apple one, is exact; everything else is a best effort.
      const selected = hearsNatively(s) ? nativePicked(runHearing(s, pair), AUTO) : null;
      const reliable = selected?.detects || either || (hearingPlace(s) === 'server' && serverDetects(models, s.asrModel));
      return { available, either, bestEffort: available && !reliable };
    };
    const theirs = of(all);
    const mine = of(hearingOf(all, 'speaker'));
    return {
      other: { on: detectsOther(all, models), available: theirs.available, ...(theirs.bestEffort ? { bestEffort: true } : {}), turn: (on) => ({ asrDetectOther: on }) },
      both: { on: speaksBoth(all, models, pair), available: mine.available || mine.either, ...(mine.bestEffort ? { bestEffort: true } : {}), turn: (on) => ({ speakBoth: on }) },
    };
  },
};

const adapter = createPipelineAdapter();

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

  // A hearing stage on a device of its own is read as the API it is asked as (`settled`): no key field is shown for it.
  credentials: { ...localaiCredentials, fields: (s) => localaiCredentials.fields(settled(s)) },
  check: (k, s, ctx) => checkLocalAIWithNative(k, s, ctx),
  // What decides the credential fields, the endpoints the check reaches, and the models it asks this computer for.
  checkReads: [
    'asrVia', 'asrApiBaseUrl', 'asrApiModel', 'asrApiNeedsKey', 'asrOther', 'asrOtherModel', 'asrMine', 'translateOther', 'translateOtherModel', 'coachOther', 'coachOtherModel', 'asrDetectOther', 'speakBoth', 'translateAt', 'translateBaseUrl', 'translateNeedsKey', 'coach', 'coachAt', 'coachBaseUrl', 'coachNeedsKey', 'serverNeedsKey',
    // The models a start needs named (`unnamedStage`).
    'model', 'asrModel', 'speakAlso', 'theyAlso', 'theyLit', 'translateModel', 'translateServerModel', 'coachModel', 'coachServerModel',
    // Legacy runtime fields, normalized to native.
    'asrHere', 'translateHere', 'coachHere',
    // The native engine's own model choices.
    'asrNativeModel', 'asrNativeByLanguage', 'translateNativeModel', 'coachNativeModel',
    // Whether it speaks, and by what.
    'speak',
  ],
  // This computer's models are per direction, and each leg needs its own.
  checkReadsDirection: true,
  // Readiness follows native downloads and engine status.
  watchReadiness: watchNativeEngine,

  languages: localaiLanguages,

  // Fork: it speaks where the voice stage is on (`speaks`), not by the shared text-only switch; the speaker's leg only.
  speech: 'optional',
  speaks: (stored) => speaksAlong(stored.speak),
  // Fork: the voice each language is read in can be changed while a run reads: it goes on in the new one.
  liveReads: (stored) => JSON.stringify(stored.speak.voices),
  participantSpeech: false,
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

  session: { prepare: (shape, s, signal) => prepareLocalAI(shape, s, UPS, signal) },
};
