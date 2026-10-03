/**
 * Fork: models the user adds from Hugging Face, beside the built-in catalog.
 *
 * The catalog (`modelManifest.ts`) lists the models the app's authors chose
 * and measured. A model outside it can still run when it is of a kind an
 * engine already loads: today that is Whisper in the layout Transformers.js
 * reads — an `onnx-community/…` or `Xenova/…` repository, a fine-tune for
 * one language among them. Its files and their sizes are read from the Hub,
 * an entry is made in the catalog's own shape, and from there it is a model
 * like any other: downloaded, picked and deleted through the same screens.
 *
 * What is added is kept in `localStorage` and put back into the catalog when
 * the app loads (`storedCustomModels`, called by the manifest itself, so
 * every reader of the catalog sees it). Types only from the manifest: the
 * manifest imports this module.
 */
import type { ModelFileEntry, ModelManifestEntry } from './modelManifest';

export const CUSTOM_MODELS_KEY = 'kotomimi.customModels';
/** Every id made here begins so: a custom model is told from a built-in one by it. */
export const CUSTOM_PREFIX = 'custom-';

const HUB = 'https://huggingface.co';

/** The files a Whisper repository must have, and the ones taken when present. */
const REQUIRED = ['config.json', 'generation_config.json', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json'];
const OPTIONAL = ['normalizer.json', 'added_tokens.json', 'special_tokens_map.json', 'vocab.json', 'merges.txt'];

/**
 * The quantizations tried, best first, each as the two files it needs and
 * the dtype the worker is told. q4 is what the catalog's own Whisper models
 * run and the only one measured sound across sizes; the 8-bit and the full
 * precision files follow for a repository that has no q4.
 */
const QUANTIZATIONS: ReadonlyArray<{ key: string; suffix: string; dtype: string }> = [
  { key: 'q4', suffix: '_q4', dtype: 'q4' },
  { key: 'q8', suffix: '_quantized', dtype: 'q8' },
  { key: 'fp32', suffix: '', dtype: 'fp32' },
];

export class CustomModelError extends Error {
  constructor(readonly code: 'bad_repo' | 'not_found' | 'unreachable' | 'not_whisper' | 'exists', message: string) {
    super(message);
  }
}

/** `owner/name`, from what was typed: a bare id, or the repository's page address. */
export function hubRepo(typed: string): string | null {
  const text = typed.trim().replace(/^https?:\/\/huggingface\.co\//i, '').replace(/\/(tree|blob|resolve)\/.*$/, '').replace(/\/+$/, '');
  return /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text) ? text : null;
}

/** The id a repository is listed under. */
export function customModelId(repo: string): string {
  return `${CUSTOM_PREFIX}${repo.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
}

export const isCustomModel = (id: string): boolean => id.startsWith(CUSTOM_PREFIX);

interface HubFile { type?: string; path?: string; size?: number; lfs?: { size?: number } }

/**
 * A Whisper repository as a catalog entry. `language` is the one language a
 * fine-tune hears (`ja`), or blank for a model that hears every language
 * Whisper does. Throws a `CustomModelError` the settings put into words.
 */
export async function whisperFromHub(typed: string, language: string, doFetch: typeof fetch = (input, init) => fetch(input, init)): Promise<ModelManifestEntry> {
  const repo = hubRepo(typed);
  if (!repo) throw new CustomModelError('bad_repo', 'Not a Hugging Face repository id.');
  let response: Response;
  try {
    response = await doFetch(`${HUB}/api/models/${repo}/tree/main?recursive=true`);
  } catch (cause) {
    throw new CustomModelError('unreachable', cause instanceof Error ? cause.message : String(cause));
  }
  // The Hub answers 401 for a repository that does not exist, as it does for a private one.
  if (response.status === 401 || response.status === 404) throw new CustomModelError('not_found', `No public repository "${repo}".`);
  if (!response.ok) throw new CustomModelError('unreachable', `Hugging Face answered HTTP ${response.status}.`);
  const listed = (await response.json()) as HubFile[];
  const sizes = new Map<string, number>();
  for (const file of Array.isArray(listed) ? listed : []) {
    if (file.type === 'file' && typeof file.path === 'string') sizes.set(file.path, file.lfs?.size ?? file.size ?? 0);
  }
  const quantization = QUANTIZATIONS.find((q) => sizes.has(`onnx/encoder_model${q.suffix}.onnx`) && sizes.has(`onnx/decoder_model_merged${q.suffix}.onnx`));
  const missing = REQUIRED.filter((name) => !sizes.has(name));
  if (!quantization || missing.length > 0) {
    throw new CustomModelError('not_whisper', missing.length > 0 ? `Missing ${missing.join(', ')}.` : 'No onnx/encoder_model and onnx/decoder_model_merged pair.');
  }
  const names = [
    ...REQUIRED,
    ...OPTIONAL.filter((name) => sizes.has(name)),
    ...[`onnx/encoder_model${quantization.suffix}.onnx`, `onnx/decoder_model_merged${quantization.suffix}.onnx`]
      // A graph too large for one file keeps its weights beside it.
      .flatMap((name) => (sizes.has(`${name}_data`) ? [name, `${name}_data`] : [name])),
  ];
  const files: ModelFileEntry[] = names.map((filename) => ({ filename, sizeBytes: sizes.get(filename) ?? 0 }));
  const base = language.trim().toLowerCase().split(/[-_]/)[0];
  return {
    id: customModelId(repo),
    type: 'asr',
    name: `${repo.split('/')[1]} (Hugging Face)`,
    languages: base ? [base] : ['multilingual'],
    ...(base ? {} : { multilingual: true }),
    hfModelId: repo,
    requiredDevice: 'webgpu',
    asrWorkerType: 'whisper-webgpu',
    // After the built-in models in every list: the app's authors measured those.
    sortOrder: 900,
    variants: { [quantization.key]: { dtype: { encoder_model: quantization.dtype, decoder_model_merged: quantization.dtype }, files } },
  };
}

/** Whatever was stored, as entries: only ones this module could have made, so a tampered store adds nothing strange to the catalog. */
function valid(entry: unknown): entry is ModelManifestEntry {
  const e = entry as Partial<ModelManifestEntry> | null;
  if (!e || typeof e.id !== 'string' || !isCustomModel(e.id) || e.type !== 'asr' || e.asrWorkerType !== 'whisper-webgpu') return false;
  if (typeof e.name !== 'string' || typeof e.hfModelId !== 'string' || hubRepo(e.hfModelId) === null || !Array.isArray(e.languages)) return false;
  const variants = Object.values(e.variants ?? {});
  return variants.length > 0 && variants.every((v) => Array.isArray(v?.files) && v.files.every((f) => typeof f?.filename === 'string' && typeof f?.sizeBytes === 'number'));
}

/** The custom models kept on this computer; none where there is no storage (a worker, a test in Node). */
export function storedCustomModels(): ModelManifestEntry[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const parsed: unknown = JSON.parse(localStorage.getItem(CUSTOM_MODELS_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(valid) : [];
  } catch {
    return [];
  }
}

export function saveCustomModels(entries: readonly ModelManifestEntry[]): void {
  localStorage.setItem(CUSTOM_MODELS_KEY, JSON.stringify(entries.filter((entry) => isCustomModel(entry.id))));
}
