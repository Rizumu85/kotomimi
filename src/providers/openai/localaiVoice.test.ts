import { describe, expect, it } from 'vitest';
import en from '../../locales/en/translation.json';
import { EDGE_BASE, VOICE_DEFAULTS, chosenVoice, clonedVoices, withoutVoice, lentVoices, serverLendsVoice, serverVoiceModel, speaksAlong, speaksAtServer, speaksByEdge, speaksByKeyedApi, speaksNatively, voiceBook, voiceChoice, voiceLanguages, voiceSource, voiceSpeaks, voiceStageOf, withVoice, type VoiceChoice } from './localaiVoice';
import { kindOf, type LocalAIModel } from './localaiModels';
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
    expect(voiceChoice({ on: 'yes', at: 'elsewhere', serverModel: 7, voices: { edge: { ja: 7, zh: 'zh-CN-YunxiNeural' }, bad: 'x' } })).toEqual({ ...VOICE_DEFAULTS, voices: { edge: { zh: 'zh-CN-YunxiNeural' } } });
  });

  it('keeps what was chosen', () => {
    const stored = { on: true, auto: false, at: 'api', nativeModel: 'irodori-tts-v4.1-small-mf-q8', serverModel: 'qwen3-tts-1.7b-customvoice-q8', apiBaseUrl: 'https://x/v1', apiModel: 'm', apiNeedsKey: true, voices: { edge: { ja: 'ja-JP-KeitaNeural' } } };
    expect(voiceChoice(stored)).toEqual(stored);
    // An older build's choice has no model of the other device's: none is chosen.
    expect(voiceChoice({ ...stored, serverModel: undefined, at: 'server' })).toMatchObject({ at: 'server', serverModel: '' });
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

describe('the voice on the other device', () => {
  const QWEN = 'qwen3-tts-1.7b-customvoice-q8';
  const IRODORI = 'irodori-tts-v4.1-small-mf-q8';
  const THERE: VoiceChoice = { ...VOICE_DEFAULTS, on: true, at: 'server' };
  /** Another Kotomimi: a recognizer, and the voice models it lends with their languages. */
  const KOTOMIMI: LocalAIModel[] = [
    { id: 'kotomimi', kind: 'pipeline', host: 'kotomimi' },
    { id: 'r2t2-q8', kind: 'asr', host: 'kotomimi' },
    { id: IRODORI, kind: 'voice', host: 'kotomimi', languages: ['ja'] },
    { id: QWEN, kind: 'voice', host: 'kotomimi', languages: ['zh', 'en', 'ja'] },
  ];

  it('is told from what the device says its models are for', () => {
    expect(kindOf(['tts'])).toBe('voice');
    expect(lentVoices(KOTOMIMI).map((m) => m.id)).toEqual([IRODORI, QWEN]);
    expect(speaksAtServer(THERE)).toBe(true);
    expect(speaksAtServer({ ...THERE, on: false })).toBe(false);
    expect(speaksAtServer(HERE)).toBe(false);
  });

  it('asks for the model chosen, else the first the device lends', () => {
    expect(serverVoiceModel(THERE, KOTOMIMI)).toBe(IRODORI);
    expect(serverVoiceModel({ ...THERE, serverModel: QWEN }, KOTOMIMI)).toBe(QWEN);
    expect(serverVoiceModel(THERE)).toBe('');
    // A server that says nothing of what its models are for has none picked for it: the first listed may be a chat model.
    expect(serverVoiceModel(THERE, [{ id: 'gpt-realtime' }, { id: 'tts-1' }])).toBe('');
    expect(lentVoices([{ id: 'gpt-realtime' }, { id: 'tts-1' }]).map((m) => m.id)).toEqual(['gpt-realtime', 'tts-1']);
    expect(serverLendsVoice(THERE, [{ id: 'gpt-realtime' }, { id: 'tts-1' }])).toBe(false);
  });

  it('knows whether the device lends it, and guesses nothing of a device that says nothing of its models', () => {
    expect(serverLendsVoice({ ...THERE, serverModel: QWEN }, KOTOMIMI)).toBe(true);
    expect(serverLendsVoice({ ...THERE, serverModel: QWEN }, KOTOMIMI.filter((m) => m.id !== QWEN))).toBe(false);
    // A phone, an older Kotomimi: models with their kinds, and none that speaks.
    expect(serverLendsVoice(THERE, KOTOMIMI.filter((m) => m.kind !== 'voice'))).toBe(false);
    // Nothing listed yet, or a server that does not say: a model named is taken to be there, and none named is none.
    expect(serverLendsVoice({ ...THERE, serverModel: QWEN })).toBe(true);
    expect(serverLendsVoice({ ...THERE, serverModel: 'tts-1' }, [{ id: 'tts-1' }, { id: 'whisper' }])).toBe(true);
    expect(serverLendsVoice(THERE)).toBe(false);
  });

  it('speaks in the voices this build knows for the same model, kept in the same book as this computer\'s', () => {
    const chosen = { ...THERE, serverModel: QWEN };
    expect(voiceSource(chosen, KOTOMIMI)).toMatchObject({ by: 'catalog', model: { id: QWEN } });
    expect(voiceBook(chosen, KOTOMIMI)).toBe(QWEN);
    expect(chosenVoice(chosen, 'ja', KOTOMIMI)).toBe('ono_anna');
    // A voice chosen while the model ran here is the voice it speaks in there.
    expect(chosenVoice({ ...withVoice(HERE, 'ja', 'ryan'), at: 'server', serverModel: QWEN }, 'ja', KOTOMIMI)).toBe('ryan');
    expect(voiceLanguages(chosen, KOTOMIMI)).toEqual(nativeVoice(QWEN).languages);
    expect(voiceSpeaks({ ...THERE, serverModel: IRODORI }, 'zh-CN', KOTOMIMI)).toBe(false);
  });

  it('is a stage asked at the shared device, with its access key, for the sound as it is made', () => {
    expect(voiceStageOf({ ...THERE, serverModel: QWEN }, ['ja', 'en'], KOTOMIMI)).toEqual({
      via: 'speech', baseUrl: '', server: true, model: QWEN, key: 'serverKey', voices: { ja: 'ono_anna', en: 'ryan' }, languages: nativeVoice(QWEN).languages, streams: true, tellsLanguage: true,
    });
    // Before the device has listed anything, a model of the catalog's is still a Kotomimi's.
    expect(voiceStageOf({ ...THERE, serverModel: QWEN }, ['ja'])).toMatchObject({ server: true, streams: true, tellsLanguage: true });
    // Nothing chosen and nothing lent: there is nothing to ask.
    expect(voiceStageOf(THERE, ['ja'])).toBeNull();
    expect(voiceStageOf(THERE, ['ja'], KOTOMIMI)).toMatchObject({ model: IRODORI, voices: { ja: 'woman' } });
  });

  it('gives a model this build does not know one typed voice, and the languages the device lists for it', () => {
    const newer: LocalAIModel[] = [{ id: 'kotomimi', kind: 'pipeline', host: 'kotomimi' }, { id: 'voice-of-tomorrow', kind: 'voice', host: 'kotomimi', languages: ['ja', 'ko'] }];
    expect(voiceSource(THERE, newer)).toEqual({ by: 'typed' });
    expect(voiceBook(THERE, newer)).toBe('server|voice-of-tomorrow');
    expect(voiceSpeaks(THERE, 'ko', newer)).toBe(true);
    expect(voiceSpeaks(THERE, 'zh', newer)).toBe(false);
    expect(chosenVoice(THERE, 'ja', newer)).toBeUndefined();
    expect(voiceStageOf(withVoice(THERE, '*', 'aoi', newer), ['ja'], newer)).toMatchObject({ server: true, model: 'voice-of-tomorrow', voices: { '*': 'aoi' }, languages: ['ja', 'ko'], streams: true });
    // A server that is no Kotomimi is asked as an API is: a file, and no language field.
    const other = voiceStageOf({ ...THERE, serverModel: 'tts-1' }, ['ja'], [{ id: 'tts-1', kind: 'voice' }]);
    expect(other).toEqual({ via: 'speech', baseUrl: '', server: true, model: 'tts-1', key: 'serverKey', voices: {} });
  });
});

describe('a model that speaks in the user\'s own voice', () => {
  const BASE = 'qwen3-tts-1.7b-base-q8';
  const MINE: VoiceChoice = { ...VOICE_DEFAULTS, on: true, at: 'device', nativeModel: BASE };

  it('speaks in the voice chosen for a language, else the one for every language, and in none where none is chosen', () => {
    expect(chosenVoice(MINE, 'ja')).toBeUndefined();
    const one = withVoice(MINE, '*', 'aaa111');
    expect(chosenVoice(one, 'ja')).toBe('aaa111');
    expect(chosenVoice(withVoice(one, 'ja', 'bbb222'), 'ja-JP')).toBe('bbb222');
    expect(chosenVoice(withVoice(one, 'ja', 'bbb222'), 'en')).toBe('aaa111');
    expect(voiceStageOf(withVoice(one, 'ja', 'bbb222'), ['ja', 'en'])).toMatchObject({ engine: true, model: BASE, voices: { ja: 'bbb222', en: 'aaa111' }, tellsLanguage: true, patient: true });
    // A model with voices of its own answers at once: it is not waited on.
    expect(voiceStageOf(HERE, ['ja'])).not.toHaveProperty('patient');
  });

  it('names the voices a run reads in, each once, and says where a language has none', () => {
    expect(clonedVoices(HERE, ['ja'])).toBeNull();
    expect(clonedVoices(MINE, ['ja', 'en'])).toEqual({ voices: [], reads: [], missing: true });
    // Each voice with each language it reads: a recording is read one way for its own language, another for the rest.
    expect(clonedVoices(withVoice(MINE, '*', 'aaa111'), ['ja', 'en-US', 'en-GB'])).toEqual({ voices: ['aaa111'], reads: [{ voice: 'aaa111', language: 'ja' }, { voice: 'aaa111', language: 'en' }], missing: false });
    expect(clonedVoices(withVoice(withVoice(MINE, '*', 'aaa111'), 'ja', 'bbb222'), ['ja', 'en'])).toMatchObject({ voices: ['bbb222', 'aaa111'], reads: [{ voice: 'bbb222', language: 'ja' }, { voice: 'aaa111', language: 'en' }], missing: false });
    expect(clonedVoices(withVoice(MINE, 'ja', 'bbb222'), ['ja', 'en'])).toMatchObject({ voices: ['bbb222'], missing: true });
    // A language it does not speak is none of what it reads.
    expect(clonedVoices(withVoice(MINE, 'ja', 'bbb222'), ['ja', 'yue'])).toMatchObject({ voices: ['bbb222'], missing: false });
  });

  it('is the same on another Kotomimi that lends the model: the user\'s own voices, handed to it', () => {
    const lent = [{ id: BASE, kind: 'voice' as const, host: 'kotomimi', languages: ['zh', 'ja', 'en'] }];
    const there: VoiceChoice = { ...withVoice(MINE, '*', 'aaa111'), at: 'server', serverModel: BASE };
    expect(voiceStageOf(there, ['ja'], lent)).toMatchObject({ server: true, model: BASE, voices: { ja: 'aaa111' }, streams: true, tellsLanguage: true, ownVoices: true, patient: true });
    expect(clonedVoices(there, ['ja'], lent)).toMatchObject({ voices: ['aaa111'], missing: false });
    // A server that is no Kotomimi is handed no recording, whatever it calls its model.
    expect(voiceStageOf(there, ['ja'], [{ ...lent[0], host: 'localai' }])).not.toHaveProperty('ownVoices');
    // A model with voices of its own is asked by their names, as before.
    expect(voiceStageOf({ ...HERE, at: 'server', serverModel: 'qwen3-tts-1.7b-customvoice-q8' }, ['ja'], [{ ...lent[0], id: 'qwen3-tts-1.7b-customvoice-q8' }])).not.toHaveProperty('ownVoices');
  });

  it('forgets a voice that was removed, wherever it was chosen', () => {
    const both = withVoice(withVoice(MINE, '*', 'aaa111'), 'ja', 'bbb222');
    expect(withoutVoice(both, 'aaa111').voices[BASE]).toEqual({ ja: 'bbb222' });
    expect(chosenVoice(withoutVoice(both, 'bbb222'), 'ja')).toBe('aaa111');
  });
});

describe('this computer\'s voice models', () => {
  it('are the main process\'s own, by id, size and languages', () => {
    expect(NATIVE_VOICES.map((m) => m.id)).toEqual(Object.keys(VOICES));
    for (const model of NATIVE_VOICES) {
      const fetched = (VOICES as unknown as Record<string, { bytes: number; languages: string[]; voice?: string; speech: { clone?: boolean } }>)[model.id];
      expect(model.bytes).toBe(fetched.bytes);
      expect([...model.languages].sort()).toEqual([...fetched.languages].sort());
      // A cloning model is one on both sides, and has no voice of its own on either.
      expect(model.clones === true).toBe(fetched.speech.clone === true);
      if (model.clones) { expect([...Object.values(model.voices).flat(), ...model.any]).toEqual([]); continue; }
      // What speaks where no voice is named is one of the model's own.
      expect([...Object.values(model.voices).flat(), ...model.any].map((voice) => voice.id)).toContain(fetched.voice);
    }
  });

  it('have a voice for every language they speak, and a note on their card', () => {
    const localai = (en as unknown as { providers: { localai: Record<string, string> } }).providers.localai;
    for (const model of NATIVE_VOICES) {
      for (const language of model.languages) {
        expect(nativeSpeaks(model, language)).toBe(true);
        // A cloning model's voices are the user's own, not the catalog's.
        if (!model.clones) expect(nativeVoicesFor(model, language).length, `${model.id} ${language}`).toBeGreaterThan(0);
      }
      const note = nativeNoteKey(model.id);
      expect(note, model.id).toBeDefined();
      expect(typeof localai[note ?? '']).toBe('string');
    }
  });
});
