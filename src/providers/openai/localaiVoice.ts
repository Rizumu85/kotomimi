/**
 * Fork: the voice stage's settings — whether translations are spoken, where the voice is made, and the voice each
 * language is spoken in — and how they become the stage a leg speaks by (`voice.ts`). One object under
 * `settings.localai.speak`, read by the builder, the check, the engines' needs, the stage's card and the line
 * player alike, so that every place a voice can be made states the same things: what it speaks, and in which voices.
 */
import { EDGE_BASE, EDGE_LANGUAGES, edgeVoiceFor } from '../../lib/voice/edgeVoices';
import type { Place } from './localaiDevice';
import { KOTOMIMI_HOST, modelsFor, type LocalAIModel } from './localaiModels';
import { NATIVE_DEFAULT_VOICE, NATIVE_VOICES, nativeVoice, nativeVoicesFor, type NativeVoiceModel } from './nativeVoices';
import { serviceOf } from './apiServices';
import type { VoiceStage } from './voice';

export { EDGE_BASE };

export interface VoiceChoice {
  /** The stage is on: any line can be said aloud on demand, and — with `auto` — translations are spoken as they come. */
  on: boolean;
  /** Each translation into a language of the other side's is spoken when it is whole. Off: lines are said only when asked for. */
  auto: boolean;
  /** Where the voice is made: the other device, an API (Edge's online voices among them), or this computer's engine. */
  at: Place;
  /** This computer's voice model (`nativeVoices.ts`). */
  nativeModel: string;
  /** The other device's voice model, of those it lends. Blank: the first it lends (`serverVoiceModel`). */
  serverModel: string;
  /** The API: `EDGE_BASE` for Microsoft Edge's online voices, else an OpenAI-style base URL; its model, and whether it wants a key. */
  apiBaseUrl: string;
  apiModel: string;
  apiNeedsKey: boolean;
  /**
   * The voice chosen for a language, by what speaks (`voiceBook`) and the language's base code. A language with none
   * chosen is spoken in the place's first voice for it; an API's one voice for every language is under `*`.
   */
  voices: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export const VOICE_DEFAULTS: VoiceChoice = {
  on: false,
  auto: true,
  at: 'device',
  nativeModel: NATIVE_DEFAULT_VOICE,
  serverModel: '',
  // The API column starts on the service that needs nothing typed.
  apiBaseUrl: EDGE_BASE,
  apiModel: '',
  apiNeedsKey: false,
  voices: {},
};

const text = (value: unknown, fallback: string): string => (typeof value === 'string' ? value : fallback);

/** The choice as it was stored, held to its shape: anything missing or misshapen reads as the default. */
export function voiceChoice(stored: unknown): VoiceChoice {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return VOICE_DEFAULTS;
  const s = stored as Record<string, unknown>;
  const voices: Record<string, Record<string, string>> = {};
  if (s.voices && typeof s.voices === 'object' && !Array.isArray(s.voices)) {
    for (const [book, chosen] of Object.entries(s.voices as Record<string, unknown>).slice(0, 50)) {
      if (!chosen || typeof chosen !== 'object' || Array.isArray(chosen)) continue;
      const kept = Object.entries(chosen as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '').slice(0, 100);
      if (kept.length > 0) voices[book] = Object.fromEntries(kept);
    }
  }
  return {
    on: s.on === true,
    auto: s.auto !== false,
    at: s.at === 'server' || s.at === 'api' || s.at === 'device' ? s.at : VOICE_DEFAULTS.at,
    nativeModel: text(s.nativeModel, VOICE_DEFAULTS.nativeModel),
    serverModel: text(s.serverModel, ''),
    apiBaseUrl: text(s.apiBaseUrl, VOICE_DEFAULTS.apiBaseUrl),
    apiModel: text(s.apiModel, ''),
    apiNeedsKey: typeof s.apiNeedsKey === 'boolean' ? s.apiNeedsKey : VOICE_DEFAULTS.apiNeedsKey,
    voices,
  };
}

/** Whether the API named is Edge's online voices. */
export const speaksByEdge = (choice: Pick<VoiceChoice, 'at' | 'apiBaseUrl'>): boolean => choice.at === 'api' && choice.apiBaseUrl.trim().toLowerCase() === EDGE_BASE;

/** Whether an API that wants a key speaks: its key field shows. */
export const speaksByKeyedApi = (choice: VoiceChoice): boolean => choice.on && choice.at === 'api' && !speaksByEdge(choice) && choice.apiNeedsKey;

/** Whether this computer's engine speaks. */
export const speaksNatively = (choice: Pick<VoiceChoice, 'on' | 'at'>): boolean => choice.on && choice.at === 'device';

/** Whether a run speaks its translations by itself: the stage on, and set to. */
export const speaksAlong = (choice: Pick<VoiceChoice, 'on' | 'auto'>): boolean => choice.on && choice.auto;

/** Whether the other device speaks: its address is asked for, and its model list read. */
export const speaksAtServer = (choice: Pick<VoiceChoice, 'on' | 'at'>): boolean => choice.on && choice.at === 'server';

/** What the other device lists, as far as the voice asks: the models it lends. */
type Lent = readonly LocalAIModel[];

/** The voice models the other device lends, of what its check listed. */
export const lentVoices = (lent: Lent): LocalAIModel[] => modelsFor(lent, 'voice');

/**
 * The model the other device is asked for: the one chosen, else the first it says is a voice. Blank: none is known —
 * a device that says nothing of what its models are for has every model in the menu, and none is picked for it.
 */
export const serverVoiceModel = (choice: Pick<VoiceChoice, 'serverModel'>, lent: Lent = []): string => choice.serverModel.trim() || lent.find((one) => one.from === undefined && one.kind === 'voice')?.id || '';

/**
 * Whether the other device lends the model it would be asked for. A device that says nothing of what its models are
 * for, or has listed nothing yet, is not refused on a guess: a model named is taken to be there.
 */
export function serverLendsVoice(choice: Pick<VoiceChoice, 'serverModel'>, lent: Lent = []): boolean {
  const model = serverVoiceModel(choice, lent);
  if (!model) return false;
  return !lent.some((one) => one.from === undefined && one.kind !== undefined) || lentVoices(lent).some((one) => one.id === model);
}

/**
 * What the choice's voices are chosen from: a model of the app's own catalog (this computer's, or the same model on
 * the other device), Edge's list, or nothing that is known here — one typed name for every language.
 */
export function voiceSource(choice: VoiceChoice, lent: Lent = []): { by: 'catalog'; model: NativeVoiceModel } | { by: 'edge' } | { by: 'typed' } {
  if (choice.at === 'device') return { by: 'catalog', model: nativeVoice(choice.nativeModel) };
  if (choice.at === 'server') {
    const model = NATIVE_VOICES.find((one) => one.id === serverVoiceModel(choice, lent));
    return model ? { by: 'catalog', model } : { by: 'typed' };
  }
  return speaksByEdge(choice) ? { by: 'edge' } : { by: 'typed' };
}

/** What the voices chosen are kept under: a catalog model's id (wherever it runs), Edge, or the place's own address and model. */
export function voiceBook(choice: VoiceChoice, lent: Lent = []): string {
  const source = voiceSource(choice, lent);
  if (source.by === 'catalog') return source.model.id;
  if (source.by === 'edge') return 'edge';
  return choice.at === 'server' ? `server|${serverVoiceModel(choice, lent)}` : `api|${choice.apiBaseUrl.trim().toLowerCase()}|${choice.apiModel.trim()}`;
}

const baseOf = (code: string): string => code.split('-')[0].toLowerCase();

/** The voice a language is spoken in under this choice: the one chosen, else the place's first for it. Undefined: the place's own default. */
export function chosenVoice(choice: VoiceChoice, language: string, lent: Lent = []): string | undefined {
  const source = voiceSource(choice, lent);
  const chosen = choice.voices[voiceBook(choice, lent)] ?? {};
  const base = baseOf(language);
  if (source.by === 'catalog') {
    // A cloning model speaks in the user's own voices: the one chosen for the language, else the one for every
    // language. Which of them are there is the library's to say (`voiceLibraryStore`), not this choice's.
    if (source.model.clones) return chosen[base] || chosen['*'] || undefined;
    const offered = nativeVoicesFor(source.model, language);
    const kept = chosen[base];
    return (kept && offered.some((voice) => voice.id === kept) ? kept : undefined) ?? offered[0]?.id;
  }
  if (source.by === 'edge') return chosen[base] || edgeVoiceFor(language);
  // What the field shows while nothing is typed in it: a service that must be named a voice has one to start from.
  return chosen['*'] || (choice.at === 'api' ? serviceOf(choice.apiBaseUrl, 'voice')?.voice : undefined) || undefined;
}

/** The choice with a voice chosen for a language (`*`: the one voice of a place whose voices are not known). */
export function withVoice(choice: VoiceChoice, language: string, voice: string, lent: Lent = []): VoiceChoice {
  const book = voiceBook(choice, lent);
  const key = language === '*' ? '*' : baseOf(language);
  return { ...choice, voices: { ...choice.voices, [book]: { ...(choice.voices[book] ?? {}), [key]: voice } } };
}

/**
 * The user's own voices a run of these languages speaks in, where the choice is a cloning model: each once. Null: it
 * is no cloning model. `missing`: a language of them has no voice chosen.
 */
export function clonedVoices(choice: VoiceChoice, languages: readonly string[], lent: Lent = []): { voices: string[]; reads: { voice: string; language: string }[]; missing: boolean } | null {
  const source = voiceSource(choice, lent);
  if (source.by !== 'catalog' || !source.model.clones) return null;
  const spoken = [...new Set(languages.map(baseOf))].filter((language) => source.model.languages.includes(language));
  const chosen = spoken.map((language) => ({ voice: chosenVoice(choice, language, lent), language }));
  const reads = chosen.filter((one): one is { voice: string; language: string } => !!one.voice);
  return { voices: [...new Set(reads.map((one) => one.voice))], reads, missing: chosen.some((one) => !one.voice) };
}

/** The choice with every use of a voice taken out: it was removed from the library. */
export function withoutVoice(choice: VoiceChoice, voice: string): VoiceChoice {
  const voices = Object.fromEntries(Object.entries(choice.voices).map(([book, chosen]) => [book, Object.fromEntries(Object.entries(chosen).filter(([, id]) => id !== voice))]));
  return { ...choice, voices };
}

/** The languages the choice can speak, by base code. Null: any (an API is not asked what it speaks). */
export function voiceLanguages(choice: VoiceChoice, lent: Lent = []): readonly string[] | null {
  const source = voiceSource(choice, lent);
  if (source.by === 'catalog') return source.model.languages;
  if (source.by === 'edge') return EDGE_LANGUAGES;
  // A model the other device lends that this build does not know: the languages it lists for it, where it lists any.
  const listed = choice.at === 'server' ? lentVoices(lent).find((one) => one.id === serverVoiceModel(choice, lent))?.languages : undefined;
  return listed?.length ? listed.map(baseOf) : null;
}

/** Whether the choice can speak a language. */
export function voiceSpeaks(choice: VoiceChoice, language: string, lent: Lent = []): boolean {
  const languages = voiceLanguages(choice, lent);
  return languages === null || languages.includes(baseOf(language));
}

/**
 * The stage that speaks `languages` under this choice, each in its voice. Null: the choice names nothing that can be
 * asked (an API with no address or model, another device that lends no voice model). `lent`: what the other device
 * lists, where it speaks.
 */
export function voiceStageOf(choice: VoiceChoice, languages: readonly string[], lent: Lent = []): VoiceStage | null {
  const source = voiceSource(choice, lent);
  const voices: Record<string, string> = {};
  if (source.by === 'typed') {
    const one = chosenVoice(choice, languages[0] ?? 'en', lent);
    if (one) voices['*'] = one;
  } else {
    for (const language of languages) {
      const voice = chosenVoice(choice, language, lent);
      if (voice) voices[baseOf(language)] = voice;
    }
  }
  const spoken = voiceLanguages(choice, lent);
  const limits = spoken ? { languages: spoken } : {};
  if (choice.at === 'device') return { via: 'speech', baseUrl: '', engine: true, model: nativeVoice(choice.nativeModel).id, voices, ...limits, tellsLanguage: true, ...(nativeVoice(choice.nativeModel).clones ? { patient: true as const } : {}) };
  if (choice.at === 'server') {
    const model = serverVoiceModel(choice, lent);
    if (!model) return null;
    // Another Kotomimi says so of every model it lends; one of the catalog's is a Kotomimi's before anything is listed.
    const listed = lent.find((one) => one.from === undefined && one.id === model);
    const kotomimi = listed ? listed.host === KOTOMIMI_HOST : source.by === 'catalog';
    // Its cloning model speaks in voices of this computer's user: it is handed their recordings (`ownVoices`).
    // Only a Kotomimi's: nothing else is handed a recording of the user's voice, whatever it calls its model.
    const own = kotomimi && source.by === 'catalog' && source.model.clones === true;
    return { via: 'speech', baseUrl: '', server: true, model, key: 'serverKey', voices, ...limits, ...(kotomimi ? { streams: true as const, tellsLanguage: true as const } : {}), ...(own ? { ownVoices: true as const, patient: true as const } : {}) };
  }
  if (source.by === 'edge') return { via: 'edge', baseUrl: '', model: 'edge', voices, ...limits };
  const baseUrl = choice.apiBaseUrl.trim();
  const model = choice.apiModel.trim();
  if (!baseUrl || !model) return null;
  return { via: 'speech', baseUrl, model, ...(choice.apiNeedsKey ? { key: 'speakKey' as const } : {}), voices };
}
