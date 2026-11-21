/**
 * Fork: the voice stage's settings — whether translations are spoken, where the voice is made, and the voice each
 * language is spoken in — and how they become the stage a leg speaks by (`voice.ts`). One object under
 * `settings.localai.voice`, read by the builder, the check, the engines' needs, the stage's card and the line
 * player alike, so that every place a voice can be made states the same things: what it speaks, and in which voices.
 */
import { EDGE_BASE, EDGE_LANGUAGES, edgeVoiceFor } from '../../lib/voice/edgeVoices';
import type { Place } from './localaiDevice';
import { NATIVE_DEFAULT_VOICE, nativeVoice, nativeVoicesFor } from './nativeVoices';
import { serviceOf } from './apiServices';
import type { VoiceStage } from './voice';

export { EDGE_BASE };

export interface VoiceChoice {
  /** The stage is on: any line can be said aloud on demand, and — with `auto` — translations are spoken as they come. */
  on: boolean;
  /** Each translation into the other side's language is spoken when it is whole. Off: lines are said only when asked for. */
  auto: boolean;
  /** Where the voice is made: this computer's engine, or an API (Edge's online voices among them). */
  at: Place;
  /** This computer's voice model (`nativeVoices.ts`). */
  nativeModel: string;
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
  // The API column starts on the service that needs nothing typed.
  apiBaseUrl: EDGE_BASE,
  apiModel: '',
  apiNeedsKey: false,
  voices: {},
};

/** The places a voice can be made today. Another device lends none yet: the card offers these two. */
export const VOICE_PLACES: readonly Place[] = ['device', 'api'];

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
    at: VOICE_PLACES.includes(s.at as Place) ? (s.at as Place) : VOICE_DEFAULTS.at,
    nativeModel: text(s.nativeModel, VOICE_DEFAULTS.nativeModel),
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

/** What the voices chosen are kept under: the model of this computer's engine, Edge, or the API's own address and model. */
export function voiceBook(choice: VoiceChoice): string {
  if (choice.at === 'device') return nativeVoice(choice.nativeModel).id;
  return speaksByEdge(choice) ? 'edge' : `api|${choice.apiBaseUrl.trim().toLowerCase()}|${choice.apiModel.trim()}`;
}

const baseOf = (code: string): string => code.split('-')[0].toLowerCase();

/** The voice a language is spoken in under this choice: the one chosen, else the place's first for it. Undefined: the place's own default. */
export function chosenVoice(choice: VoiceChoice, language: string): string | undefined {
  const chosen = choice.voices[voiceBook(choice)] ?? {};
  const base = baseOf(language);
  if (choice.at === 'device') {
    const offered = nativeVoicesFor(nativeVoice(choice.nativeModel), language);
    const kept = chosen[base];
    return (kept && offered.some((voice) => voice.id === kept) ? kept : undefined) ?? offered[0]?.id;
  }
  if (speaksByEdge(choice)) return chosen[base] || edgeVoiceFor(language);
  // What the field shows while nothing is typed in it: a service that must be named a voice has one to start from.
  return chosen['*'] || serviceOf(choice.apiBaseUrl, 'voice')?.voice || undefined;
}

/** The choice with a voice chosen for a language (`*`: an API's one voice). */
export function withVoice(choice: VoiceChoice, language: string, voice: string): VoiceChoice {
  const book = voiceBook(choice);
  const key = language === '*' ? '*' : baseOf(language);
  return { ...choice, voices: { ...choice.voices, [book]: { ...(choice.voices[book] ?? {}), [key]: voice } } };
}

/** The languages the choice can speak, by base code. Null: any (an API is not asked what it speaks). */
export function voiceLanguages(choice: VoiceChoice): readonly string[] | null {
  if (choice.at === 'device') return nativeVoice(choice.nativeModel).languages;
  return speaksByEdge(choice) ? EDGE_LANGUAGES : null;
}

/** Whether the choice can speak a language. */
export function voiceSpeaks(choice: VoiceChoice, language: string): boolean {
  const languages = voiceLanguages(choice);
  return languages === null || languages.includes(baseOf(language));
}

/**
 * The stage that speaks `languages` under this choice, each in its voice. Null: the choice names nothing that can be
 * asked (an API with no address or model).
 */
export function voiceStageOf(choice: VoiceChoice, languages: readonly string[]): VoiceStage | null {
  const voices: Record<string, string> = {};
  for (const language of languages) {
    const voice = chosenVoice(choice, language);
    if (voice) voices[baseOf(language)] = voice;
  }
  const spoken = voiceLanguages(choice);
  const limits = spoken ? { languages: spoken } : {};
  if (choice.at === 'device') return { via: 'speech', baseUrl: '', engine: true, model: nativeVoice(choice.nativeModel).id, voices, ...limits, tellsLanguage: true };
  if (speaksByEdge(choice)) return { via: 'edge', baseUrl: '', model: 'edge', voices, ...limits };
  const baseUrl = choice.apiBaseUrl.trim();
  const model = choice.apiModel.trim();
  if (!baseUrl || !model) return null;
  const one = chosenVoice(choice, languages[0] ?? 'en');
  return { via: 'speech', baseUrl, model, ...(choice.apiNeedsKey ? { key: 'speakKey' as const } : {}), voices: one ? { '*': one } : {} };
}
