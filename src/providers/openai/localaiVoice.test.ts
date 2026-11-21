import { describe, expect, it } from 'vitest';
import en from '../../locales/en/translation.json';
import { EDGE_BASE, VOICE_DEFAULTS, chosenVoice, speaksAlong, speaksByEdge, speaksByKeyedApi, speaksNatively, voiceBook, voiceChoice, voiceLanguages, voiceSpeaks, voiceStageOf, withVoice, type VoiceChoice } from './localaiVoice';
import { NATIVE_VOICES, nativeSpeaks, nativeVoice, nativeVoicesFor } from './nativeVoices';
import { nativeNoteKey } from './NativeEngineCard';
// The main process's own list: what is fetched, and what each model is asked with.
import { VOICES } from '../../../electron/native-engine';

const HERE: VoiceChoice = { ...VOICE_DEFAULTS, on: true, at: 'device' };
const EDGE: VoiceChoice = { ...VOICE_DEFAULTS, on: true, at: 'api', apiBaseUrl: EDGE_BASE };
const API: VoiceChoice = { ...VOICE_DEFAULTS, on: true, at: 'api', apiBaseUrl: 'https://api.openai.com/v1', apiModel: 'tts-1', apiNeedsKey: true };

describe('the voice stage as it was stored', () => {
  it('reads anything missing or misshapen as the default: off, on this computer', () => {
    expect(voiceChoice(undefined)).toEqual(VOICE_DEFAULTS);
    expect(voiceChoice('on')).toEqual(VOICE_DEFAULTS);
    expect(voiceChoice({ on: 'yes', at: 'server', voices: { edge: { ja: 7, zh: 'zh-CN-YunxiNeural' }, bad: 'x' } })).toEqual({ ...VOICE_DEFAULTS, voices: { edge: { zh: 'zh-CN-YunxiNeural' } } });
  });

  it('keeps what was chosen', () => {
    const stored = { on: true, auto: false, at: 'api', nativeModel: 'irodori-tts-v4.1-small-mf-q8', apiBaseUrl: 'https://x/v1', apiModel: 'm', apiNeedsKey: true, voices: { edge: { ja: 'ja-JP-KeitaNeural' } } };
    expect(voiceChoice(stored)).toEqual(stored);
  });

  it('speaks along only while it is on and set to, and shows a key field only for an API that wants one', () => {
    expect(speaksAlong(VOICE_DEFAULTS)).toBe(false);
    expect(speaksAlong(HERE)).toBe(true);
    expect(speaksAlong({ ...HERE, auto: false })).toBe(false);
    expect(speaksNatively(HERE)).toBe(true);
    expect(speaksNatively(EDGE)).toBe(false);
    expect(speaksByEdge(EDGE)).toBe(true);
    expect(speaksByKeyedApi(EDGE)).toBe(false);
    expect(speaksByKeyedApi(API)).toBe(true);
  });
});

describe('the voice a language is spoken in', () => {
  it('is the place\'s first for it until another is chosen, and the one chosen after', () => {
    expect(chosenVoice(HERE, 'ja')).toBe('ono_anna');
    expect(chosenVoice(HERE, 'zh-CN')).toBe('vivian');
    expect(chosenVoice(EDGE, 'ja')).toBe('ja-JP-NanamiNeural');
    // An API is not asked what voices it has: the one its service starts from, and none at an address typed by hand.
    expect(chosenVoice(API, 'ja')).toBe('alloy');
    expect(chosenVoice({ ...API, apiBaseUrl: 'http://192.168.1.5:8880/v1' }, 'ja')).toBeUndefined();
    expect(chosenVoice(withVoice(HERE, 'zh-CN', 'uncle_fu'), 'zh')).toBe('uncle_fu');
    expect(chosenVoice(withVoice(EDGE, 'ja', 'ja-JP-KeitaNeural'), 'ja')).toBe('ja-JP-KeitaNeural');
    expect(chosenVoice(withVoice(API, '*', 'alloy'), 'ko')).toBe('alloy');
  });

  it('is kept apart for each place and model: changing what speaks never carries a voice it has not', () => {
    const chosen = withVoice(HERE, 'ja', 'ryan');
    expect(voiceBook(chosen)).toBe('qwen3-tts-1.7b-customvoice-q8');
    // Irodori has no `ryan`: its own first voice speaks.
    expect(chosenVoice({ ...chosen, nativeModel: 'irodori-tts-v4.1-small-mf-q8' }, 'ja')).toBe('woman');
    expect(chosenVoice({ ...chosen, at: 'api' }, 'ja')).toBe('ja-JP-NanamiNeural');
  });
});

describe('the stage a leg speaks by', () => {
  it('is this computer\'s engine, told the language, with a voice for each language asked for', () => {
    expect(voiceStageOf(HERE, ['ja', 'en'])).toEqual({ via: 'speech', baseUrl: '', engine: true, model: 'qwen3-tts-1.7b-customvoice-q8', voices: { ja: 'ono_anna', en: 'ryan' }, languages: nativeVoice(HERE.nativeModel).languages, tellsLanguage: true });
  });

  it('is Edge, where that is the API named', () => {
    expect(voiceStageOf(EDGE, ['zh-CN'])).toMatchObject({ via: 'edge', voices: { zh: 'zh-CN-XiaoxiaoNeural' } });
  });

  it('is an API with its key and one voice for every language, and nothing while it names no model', () => {
    expect(voiceStageOf(withVoice(API, '*', 'alloy'), ['ja'])).toEqual({ via: 'speech', baseUrl: 'https://api.openai.com/v1', model: 'tts-1', key: 'speakKey', voices: { '*': 'alloy' } });
    expect(voiceStageOf({ ...API, apiModel: ' ' }, ['ja'])).toBeNull();
    // With no voice typed, the request still names the one the field shows.
    expect(voiceStageOf(API, ['ja'])).toMatchObject({ voices: { '*': 'alloy' } });
    expect(voiceStageOf({ ...API, apiBaseUrl: 'http://192.168.1.5:8880/v1' }, ['ja'])).toMatchObject({ voices: {} });
  });

  it('says what it cannot speak: a model\'s own languages, Edge\'s list, anything for an API', () => {
    expect(voiceSpeaks(HERE, 'ko')).toBe(true);
    expect(voiceSpeaks(HERE, 'yue')).toBe(false);
    // A model of one language says so of every other: its card's row for one reads "cannot speak".
    expect(voiceSpeaks({ ...HERE, nativeModel: 'irodori-tts-v4.1-small-mf-q8' }, 'ja')).toBe(true);
    expect(voiceSpeaks({ ...HERE, nativeModel: 'irodori-tts-v4.1-small-mf-q8' }, 'zh-CN')).toBe(false);
    expect(voiceSpeaks(EDGE, 'yue')).toBe(true);
    expect(voiceLanguages(API)).toBeNull();
  });
});

describe('this computer\'s voice models', () => {
  it('are the main process\'s own, by id, size and languages', () => {
    expect(NATIVE_VOICES.map((m) => m.id)).toEqual(Object.keys(VOICES));
    for (const model of NATIVE_VOICES) {
      const fetched = (VOICES as Record<string, { bytes: number; languages: string[]; voice: string }>)[model.id];
      expect(model.bytes).toBe(fetched.bytes);
      expect([...model.languages].sort()).toEqual([...fetched.languages].sort());
      // What speaks where no voice is named is one of the model's own.
      expect([...Object.values(model.voices).flat(), ...model.any].map((voice) => voice.id)).toContain(fetched.voice);
    }
  });

  it('have a voice for every language they speak, and a note on their card', () => {
    const localai = (en as unknown as { providers: { localai: Record<string, string> } }).providers.localai;
    for (const model of NATIVE_VOICES) {
      for (const language of model.languages) {
        expect(nativeSpeaks(model, language)).toBe(true);
        expect(nativeVoicesFor(model, language).length, `${model.id} ${language}`).toBeGreaterThan(0);
      }
      const note = nativeNoteKey(model.id);
      expect(note, model.id).toBeDefined();
      expect(typeof localai[note ?? '']).toBe('string');
    }
  });
});
