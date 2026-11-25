/**
 * Fork: this computer's voices — the models the voice engine runs (`VOICES` in `electron/native-engine.js`), as the
 * page reads them: what each speaks, and the packaged voices a language is spoken in. The first voice of a language
 * is the one used until another is chosen; a language with none of its own is spoken in `any`.
 */
import type { NativeCardModel } from './NativeEngineCard';

export interface VoiceOption {
  id: string;
  /** Shown as it is: a voice's own name. */
  name: string;
  /** A voice with no name of its own (one a model is told by a description): the words it goes by, under `fork.voice`. */
  nameKey?: string;
  gender: 'f' | 'm';
}

export interface NativeVoiceModel extends NativeCardModel {
  languages: readonly string[];
  /** The voices made for a language, by its base code, best first. */
  voices: Readonly<Record<string, readonly VoiceOption[]>>;
  /** What speaks a language that has none of its own. */
  any: readonly VoiceOption[];
  /** Runs on the processor alone. */
  usesGpu?: false;
  /**
   * It has no voice of its own: it speaks in the user's, cloned from a recording of theirs (`voiceLibraryStore`,
   * `electron/voice-library.js`). Its voices are the library's, the same for every language.
   */
  clones?: true;
}

/** The voices of a model that is told one by a description (`VOICES[…].speech.voices` in the main process). */
const DESCRIBED: readonly VoiceOption[] = [
  { id: 'woman', name: 'Female', nameKey: 'fork.voice.woman', gender: 'f' },
  { id: 'man', name: 'Male', nameKey: 'fork.voice.man', gender: 'm' },
];

const QWEN_ZH: readonly VoiceOption[] = [
  { id: 'vivian', name: 'Vivian', gender: 'f' },
  { id: 'serena', name: 'Serena', gender: 'f' },
  { id: 'uncle_fu', name: 'Uncle Fu', gender: 'm' },
];
const QWEN_EN: readonly VoiceOption[] = [
  { id: 'ryan', name: 'Ryan', gender: 'm' },
  { id: 'aiden', name: 'Aiden', gender: 'm' },
];
const QWEN_JA: readonly VoiceOption[] = [{ id: 'ono_anna', name: 'Ono Anna', gender: 'f' }];
const QWEN_KO: readonly VoiceOption[] = [{ id: 'sohee', name: 'Sohee', gender: 'f' }];
const QWEN_ALL: readonly VoiceOption[] = [...QWEN_ZH, ...QWEN_EN, ...QWEN_JA, ...QWEN_KO];

export const NATIVE_VOICES: readonly NativeVoiceModel[] = [
  {
    id: 'qwen3-tts-1.7b-customvoice-q8',
    name: 'Qwen3-TTS 1.7B',
    bytes: 2817055200,
    languages: ['zh', 'en', 'ja', 'ko', 'de', 'fr', 'ru', 'pt', 'es', 'it'],
    // Every packaged voice speaks every language; a language is put first in the voice that was recorded in it.
    voices: {
      zh: [...QWEN_ZH, ...QWEN_EN, ...QWEN_JA, ...QWEN_KO],
      en: [...QWEN_EN, ...QWEN_ZH, ...QWEN_JA, ...QWEN_KO],
      ja: [...QWEN_JA, ...QWEN_ZH, ...QWEN_EN, ...QWEN_KO],
      ko: [...QWEN_KO, ...QWEN_ZH, ...QWEN_EN, ...QWEN_JA],
    },
    any: QWEN_ALL,
  },
  {
    id: 'irodori-tts-v4.1-small-mf-q8',
    name: 'Irodori-TTS v4.1 Small',
    bytes: 1368276320,
    languages: ['ja'],
    voices: { ja: DESCRIBED },
    any: [],
  },
  {
    id: 'qwen3-tts-1.7b-base-q8',
    name: 'Qwen3-TTS 1.7B Base',
    bytes: 2695186240,
    languages: ['zh', 'en', 'ja', 'ko', 'de', 'fr', 'ru', 'pt', 'es', 'it'],
    voices: {},
    any: [],
    clones: true,
  },
];

export const NATIVE_DEFAULT_VOICE = NATIVE_VOICES[0].id;

/** The model of this id; the first where none is. */
export const nativeVoice = (id: string): NativeVoiceModel => NATIVE_VOICES.find((m) => m.id === id) ?? NATIVE_VOICES[0];

const baseOf = (code: string): string => code.split('-')[0].toLowerCase();

/** The voices a model offers for a language: its own, else the ones that speak any. */
export function nativeVoicesFor(model: NativeVoiceModel, language: string): readonly VoiceOption[] {
  const own = model.voices[baseOf(language)];
  return own?.length ? own : model.any;
}

/** Whether a model speaks a language. */
export const nativeSpeaks = (model: NativeVoiceModel, language: string): boolean => model.languages.includes(baseOf(language));
