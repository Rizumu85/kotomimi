/**
 * Fork: the services an "API model" usually is, so that a stage is given a
 * name to choose and not an address to know.
 *
 * A service here is three facts — where it is, whether it wants a key, and
 * which of its models suit a stage — and nothing the stage cards did not
 * already take typed: choosing one fills the address, and the model is then
 * picked from what the service itself lists (`preferredModel`). No model's
 * name is written down here. Names age within months; the patterns say what
 * kind of model is meant (a small, quick one for text; a transcriber for
 * speech) and the newest that fits is taken from the live list.
 *
 * Which service a stage uses is not stored: it is read back from the address
 * (`serviceOf`), so settings made by typing an address show the service too,
 * and "custom" is simply an address none of these has.
 */

export type ApiKind = 'asr' | 'text';

export interface ApiService {
  id: string;
  /** A brand's name, shown as it is; `nameKey` words the few that are said in the reader's language. */
  name: string;
  nameKey?: string;
  baseUrl: string;
  needsKey: boolean;
  /** The stages it can serve, each with the models tried for it, best first. A pattern that matches nothing listed is passed over. */
  prefer: Partial<Record<ApiKind, readonly RegExp[]>>;
  /** The built-in provider whose saved key opens this service too (its settings prefix). */
  keyOf?: string;
  /** Wording for the model field where the service lists nothing to pick from. */
  modelHintKey?: string;
}

export const API_SERVICES: readonly ApiService[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    needsKey: true,
    prefer: { asr: [/^gpt-4o-mini-transcribe$/, /^gpt-4o-transcribe$/, /^whisper-1$/], text: [/^gpt-[\d.]+-mini$/, /^gpt-[\d.]+-nano$/] },
    keyOf: 'openai',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    needsKey: true,
    // Its list names models `models/gemini-…`; it takes them asked for either way.
    prefer: { text: [/^(models\/)?gemini-[\d.]+-flash$/, /^(models\/)?gemini-[\d.]+-flash-lite$/] },
    keyOf: 'gemini',
  },
  {
    id: 'ark',
    name: 'Doubao (Volcengine Ark)',
    nameKey: 'providers.localai.apiServiceArk',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    needsKey: true,
    // Asked for by a model's name or an endpoint id (`ep-…`) of the user's own account: nothing to pick for them.
    prefer: { text: [] },
    modelHintKey: 'providers.localai.apiServiceArkModel',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    needsKey: true,
    prefer: { text: [/^deepseek-chat$/, /^deepseek-v[\d.]+-flash$/] },
  },
  {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    needsKey: true,
    prefer: { asr: [/^whisper-large-v3-turbo$/, /^whisper-large-v3$/], text: [/^llama-[\d.]+-70b-versatile$/, /-versatile$/] },
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    nameKey: 'providers.localai.apiServiceSiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    needsKey: true,
    prefer: { asr: [/SenseVoiceSmall$/], text: [] },
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    needsKey: true,
    prefer: { text: [/^google\/gemini-[\d.]+-flash$/, /^openai\/gpt-[\d.]+-mini$/] },
  },
  {
    id: 'ollama',
    name: 'Ollama',
    nameKey: 'providers.localai.apiServiceOllama',
    baseUrl: 'http://localhost:11434/v1',
    needsKey: false,
    // Whatever is installed there: the user put it there to be used.
    prefer: { text: [/./] },
  },
];

const plain = (url: string): string => url.trim().replace(/\/+$/, '').toLowerCase();

/** The services that can serve a stage of this kind. */
export const servicesFor = (kind: ApiKind): readonly ApiService[] => API_SERVICES.filter((s) => s.prefer[kind] !== undefined);

/** The service an address is, or none: an address typed by hand. */
export function serviceOf(baseUrl: string, kind: ApiKind): ApiService | undefined {
  const url = plain(baseUrl);
  return url ? servicesFor(kind).find((s) => plain(s.baseUrl) === url) : undefined;
}

/** A model id's numbers, in order: `gpt-5.4-mini` → [5, 4]. */
const versionOf = (id: string): number[] => (id.match(/\d+/g) ?? []).map(Number);

/** Newer first: the numbers compared one by one, a longer run after an equal shorter one. */
function newerFirst(a: string, b: string): number {
  const x = versionOf(a);
  const y = versionOf(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (y[i] ?? -1) - (x[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * The model of a service a stage is given when none is named: of the first
 * pattern anything listed fits, the newest. Nothing where the service lists
 * nothing that fits — the field then stays to be filled by hand.
 */
export function preferredModel(service: ApiService, kind: ApiKind, listed: readonly string[]): string | undefined {
  for (const pattern of service.prefer[kind] ?? []) {
    const fits = listed.filter((id) => pattern.test(id));
    // A stable sort: of two equally new, the one the service lists first.
    if (fits.length > 0) return [...fits].sort(newerFirst)[0];
  }
  return undefined;
}
