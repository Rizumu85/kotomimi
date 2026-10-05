/**
 * Fork: the chat models the native feedback engine runs — llama.cpp's server
 * with a small model that checks the grammar of what the speaker says
 * (`electron/native-engine.js`, `COACHES`). It is asked over the OpenAI chat
 * wire, as an API model is, with the prompt and the worked examples of
 * `coachPrompt.ts`.
 *
 * Measured 2026-10-05 on fourteen wrong and fourteen right casual Japanese
 * sentences of a Chinese speaker, all on llama.cpp (RTX 5070 Ti):
 *   Gemma 4 E2B        11 of the wrong caught, 14 of the right passed, 0.14 s
 *   Qwen3-4B Instruct   6 caught, 14 passed, 0.10 s
 *   Qwen3.5-4B          9 caught,  4 passed, 0.28 s
 *   Qwen3.5-2B          8 caught,  5 passed, 0.18 s
 * against a hosted model's 14 and 14 in 0.9 s. So it is Gemma.
 */
export interface NativeCoach {
  id: string;
  name: string;
  bytes: number;
  /** Any language a small multilingual chat model reads. */
  languages: 'any';
}

export const NATIVE_COACHES: readonly NativeCoach[] = [
  { id: 'gemma-4-e2b', name: 'Gemma 4 E2B', bytes: 3106738272, languages: 'any' },
];

export const NATIVE_DEFAULT_COACH = NATIVE_COACHES[0].id;

/**
 * What every request to the engine carries, as the models were measured: no
 * thinking before the answer, and the likeliest words. Left to itself Gemma
 * thinks first — the same sentence took 1.8 s where this takes 0.3 s
 * (2026-10-06), and an answer cut short by its thoughts comes back empty.
 */
export const NATIVE_COACH_EXTRA: Readonly<Record<string, unknown>> = { temperature: 0, chat_template_kwargs: { enable_thinking: false } };

/** The model a setting names; the first for a name the app no longer has. */
export const nativeCoach = (id: string): NativeCoach => NATIVE_COACHES.find((m) => m.id === id) ?? NATIVE_COACHES[0];
