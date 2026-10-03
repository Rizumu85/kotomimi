/**
 * Fork: a model's id as a name a person reads. A server names its models as
 * files are named — `qwen3-1.7b-mlx`, `hy-mt2-1.8b` — and a menu of those is
 * a menu of codes. Nothing here knows a particular model: the id is split at
 * its hyphens and each part is written the way that kind of word is written
 * (a size in capitals, a known name in its own casing, anything else with a
 * capital first letter). The id itself stays what is sent.
 */

/** Words with a spelling of their own. */
const WORDS: Readonly<Record<string, string>> = {
  asr: 'ASR', tts: 'TTS', vad: 'VAD', mlx: 'MLX', gguf: 'GGUF', ggml: 'GGML', gpt: 'GPT', llm: 'LLM', mt: 'MT', ai: 'AI', gpu: 'GPU', cpu: 'CPU', onnx: 'ONNX', cpp: 'C++',
  sensevoice: 'SenseVoice', translategemma: 'TranslateGemma', deepseek: 'DeepSeek', openai: 'OpenAI', localai: 'LocalAI', hy: 'Hy', mt2: 'MT2',
};

function word(part: string): string {
  const lower = part.toLowerCase();
  if (WORDS[lower]) return WORDS[lower];
  // A size or a quantization: `1.8b`, `4b`, `q4_k_m`, `v3`, `int8`.
  if (/^\d+(\.\d+)?[bmk]$/.test(lower) || /^q\d/.test(lower) || /^f\d+$/.test(lower)) return part.toUpperCase();
  if (/^v\d/.test(lower)) return `V${part.slice(1)}`;
  return part.charAt(0).toUpperCase() + part.slice(1);
}

export function modelLabel(id: string): string {
  const parts = id.trim().split('-').filter(Boolean);
  if (parts.length === 0) return id;
  // `hy-mt2` is one name, hyphen and all.
  return parts.map(word).join(' ').replace(/\bHy MT/g, 'Hy-MT');
}
