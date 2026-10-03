import { beforeEach, describe, expect, it } from 'vitest';
import {
  CUSTOM_MODELS_KEY, CustomModelError, customModelId, hubRepo, isCustomModel, saveCustomModels, storedCustomModels, whisperFromHub,
} from './customModels';

/** A repository's file list, as the Hub's tree endpoint gives it: small files by `size`, large ones by `lfs.size`. */
const tree = (files: Record<string, number>, lfs: string[] = []) => Object.entries(files).map(([path, size]) => (lfs.includes(path)
  ? { type: 'file', path, size: 134, lfs: { size } }
  : { type: 'file', path, size }));
const answer = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const KOTOBA = {
  'README.md': 359, 'config.json': 1572, 'generation_config.json': 3927, 'preprocessor_config.json': 340, 'tokenizer.json': 2480617, 'tokenizer_config.json': 282843,
  'normalizer.json': 52666, 'merges.txt': 493869,
  'onnx/encoder_model.onnx': 412412, 'onnx/encoder_model.onnx_data': 2547875840, 'onnx/encoder_model_q4.onnx': 424915933, 'onnx/encoder_model_quantized.onnx': 644795350,
  'onnx/decoder_model_merged.onnx': 477906544, 'onnx/decoder_model_merged_q4.onnx': 300964533, 'onnx/decoder_model_merged_quantized.onnx': 385334539,
};
const LFS = Object.keys(KOTOBA).filter((path) => path.startsWith('onnx/'));

describe('a repository id, as typed', () => {
  it('reads an id, or the repository\'s page address', () => {
    expect(hubRepo(' onnx-community/kotoba-whisper-v2.2-ONNX ')).toBe('onnx-community/kotoba-whisper-v2.2-ONNX');
    expect(hubRepo('https://huggingface.co/Xenova/whisper-small/tree/main')).toBe('Xenova/whisper-small');
    expect(hubRepo('https://huggingface.co/Xenova/whisper-small/')).toBe('Xenova/whisper-small');
  });

  it('refuses what names no repository', () => {
    for (const typed of ['', 'whisper-small', 'a/b/c', '../etc/passwd', 'owner/name?x=1', 'owner /name']) expect(hubRepo(typed), typed).toBeNull();
  });

  it('makes an id that is told from a built-in one', () => {
    expect(customModelId('onnx-community/kotoba-whisper-v2.2-ONNX')).toBe('custom-onnx-community-kotoba-whisper-v2-2-onnx');
    expect(isCustomModel('custom-x')).toBe(true);
    expect(isCustomModel('whisper-tiny')).toBe(false);
  });
});

describe('a Whisper repository as a catalog entry', () => {
  it('takes the q4 pair, the files Whisper needs and the ones it can use, each with its real size', async () => {
    const calls: string[] = [];
    const fetch = async (input: RequestInfo | URL) => { calls.push(String(input)); return answer(tree(KOTOBA, LFS))(); };
    const entry = await whisperFromHub('onnx-community/kotoba-whisper-v2.2-ONNX', 'ja', fetch as typeof globalThis.fetch);
    expect(calls).toEqual(['https://huggingface.co/api/models/onnx-community/kotoba-whisper-v2.2-ONNX/tree/main?recursive=true']);
    expect(entry).toMatchObject({
      id: 'custom-onnx-community-kotoba-whisper-v2-2-onnx', type: 'asr', languages: ['ja'], hfModelId: 'onnx-community/kotoba-whisper-v2.2-ONNX',
      requiredDevice: 'webgpu', asrWorkerType: 'whisper-webgpu',
    });
    expect(entry).not.toHaveProperty('multilingual');
    expect(entry.variants.q4.dtype).toEqual({ encoder_model: 'q4', decoder_model_merged: 'q4' });
    expect(entry.variants.q4.files).toEqual([
      { filename: 'config.json', sizeBytes: 1572 },
      { filename: 'generation_config.json', sizeBytes: 3927 },
      { filename: 'preprocessor_config.json', sizeBytes: 340 },
      { filename: 'tokenizer.json', sizeBytes: 2480617 },
      { filename: 'tokenizer_config.json', sizeBytes: 282843 },
      { filename: 'normalizer.json', sizeBytes: 52666 },
      { filename: 'merges.txt', sizeBytes: 493869 },
      { filename: 'onnx/encoder_model_q4.onnx', sizeBytes: 424915933 },
      { filename: 'onnx/decoder_model_merged_q4.onnx', sizeBytes: 300964533 },
    ]);
  });

  it('hears every language when none is named', async () => {
    const entry = await whisperFromHub('Xenova/whisper-small', '', answer(tree(KOTOBA, LFS)) as typeof globalThis.fetch);
    expect(entry).toMatchObject({ languages: ['multilingual'], multilingual: true });
  });

  it('falls to the 8-bit files, then the full ones with their weights beside them', async () => {
    const { 'onnx/encoder_model_q4.onnx': _e, 'onnx/decoder_model_merged_q4.onnx': _d, ...noQ4 } = KOTOBA;
    const q8 = await whisperFromHub('a/b', '', answer(tree(noQ4, LFS)) as typeof globalThis.fetch);
    expect(Object.keys(q8.variants)).toEqual(['q8']);
    const { 'onnx/encoder_model_quantized.onnx': _eq, 'onnx/decoder_model_merged_quantized.onnx': _dq, ...full } = noQ4;
    const fp32 = await whisperFromHub('a/b', '', answer(tree(full, LFS)) as typeof globalThis.fetch);
    expect(fp32.variants.fp32.files.map((f) => f.filename).filter((name) => name.startsWith('onnx/')))
      .toEqual(['onnx/encoder_model.onnx', 'onnx/encoder_model.onnx_data', 'onnx/decoder_model_merged.onnx']);
  });

  it('says what is wrong: no such repository, not a Whisper, no answer', async () => {
    const code = (p: Promise<unknown>) => p.then(() => 'no error', (e) => (e as CustomModelError).code);
    expect(await code(whisperFromHub('not a repo', '', answer([]) as typeof globalThis.fetch))).toBe('bad_repo');
    // The Hub answers 401 for a name that does not exist.
    expect(await code(whisperFromHub('a/b', '', answer({ error: 'Invalid username or password.' }, 401) as typeof globalThis.fetch))).toBe('not_found');
    expect(await code(whisperFromHub('a/b', '', answer(tree({ 'README.md': 1, 'model.safetensors': 9 })) as typeof globalThis.fetch))).toBe('not_whisper');
    expect(await code(whisperFromHub('a/b', '', answer({}, 503) as typeof globalThis.fetch))).toBe('unreachable');
    expect(await code(whisperFromHub('a/b', '', (async () => { throw new TypeError('Failed to fetch'); }) as typeof globalThis.fetch))).toBe('unreachable');
  });
});

describe('what is kept between launches', () => {
  beforeEach(() => localStorage.removeItem(CUSTOM_MODELS_KEY));

  it('gives back the models saved, and only ones this module could have made', async () => {
    const entry = await whisperFromHub('a/b', 'ja', answer(tree(KOTOBA, LFS)) as typeof globalThis.fetch);
    saveCustomModels([entry]);
    expect(storedCustomModels()).toEqual([entry]);
    localStorage.setItem(CUSTOM_MODELS_KEY, JSON.stringify([
      entry,
      { ...entry, id: 'whisper-tiny' },
      { ...entry, id: 'custom-x', type: 'tts' },
      { ...entry, id: 'custom-y', hfModelId: 'https://evil.example/x' },
      { ...entry, id: 'custom-z', variants: {} },
      'junk',
    ]));
    expect(storedCustomModels().map((m) => m.id)).toEqual([entry.id]);
  });

  it('is empty for nothing stored, or for a store that is not a list', () => {
    expect(storedCustomModels()).toEqual([]);
    localStorage.setItem(CUSTOM_MODELS_KEY, '{not json');
    expect(storedCustomModels()).toEqual([]);
    localStorage.setItem(CUSTOM_MODELS_KEY, '{"a":1}');
    expect(storedCustomModels()).toEqual([]);
  });
});
