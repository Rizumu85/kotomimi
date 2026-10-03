// @vitest-environment node
/**
 * Fork: the grammar-feedback prompt against real models — for choosing a
 * model, and for checking a prompt change did what it meant to. Skipped
 * unless told where the models are:
 *
 *   COACH_LIVE_BASE=http://192.168.1.10:8080/v1 COACH_LIVE_MODELS=qwen3-4b,translategemma-4b \
 *     npx vitest run --silent=false --reporter=verbose src/providers/openai/coachPrompt.live.test.ts
 *
 * `COACH_LIVE_KEY` is sent as a Bearer token when set. `COACH_LIVE_NATIVE`
 * (default `zh-CN`) and `COACH_LIVE_SPOKEN` (default `ja`) choose the pair;
 * the sentences below are Japanese, so another spoken language needs its
 * own. It asserts only that every model answered; the answers are printed
 * to be read.
 */
import { describe, expect, it } from 'vitest';
import { realClock } from '../../lib/contract/clock';
import { coachPrompt } from './coachPrompt';
import { tidyAnswer } from './pipeline';
import { chatUrl, completeText } from './textModel';

const BASE = process.env.COACH_LIVE_BASE ?? '';
const MODELS = (process.env.COACH_LIVE_MODELS ?? '').split(',').map((m) => m.trim()).filter(Boolean);
const NATIVE = process.env.COACH_LIVE_NATIVE ?? 'zh-CN';
const SPOKEN = process.env.COACH_LIVE_SPOKEN ?? 'ja';

/** What a learner might say: each with whether it is right. None is one of the prompt's own examples. */
const SAID: ReadonlyArray<{ text: string; right: boolean }> = [
  { text: '私は毎日日本語を勉強します。', right: true },
  { text: '昨日はとても寒いです。', right: false },
  { text: '図書館に本を読みます。', right: false },
  { text: 'この料理は美味しいでした。', right: false },
  { text: 'すみません、駅はどこですか。', right: true },
  { text: '明日、友達に会いました。', right: false },
];

describe.skipIf(!BASE || MODELS.length === 0)('the grammar-feedback prompt, live', () => {
  it.each(MODELS)('%s answers every sentence', async (model) => {
    const prompt = coachPrompt(SPOKEN, NATIVE, process.env.COACH_LIVE_PROMPT ?? '');
    let verdictsRight = 0;
    let explainedInNative = 0;
    let corrections = 0;
    const lines: string[] = [];
    for (const said of SAID) {
      const answer = await completeText(
        { url: chatUrl(BASE), model, key: process.env.COACH_LIVE_KEY || undefined, system: prompt.system, shots: prompt.shots, user: said.text },
        { fetch, clock: realClock, signal: new AbortController().signal },
      );
      const shown = tidyAnswer('coach', answer.text);
      const approved = shown === '✓';
      if (approved === said.right) verdictsRight += 1;
      const why = shown.split('\n')[1] ?? '';
      if (!approved) {
        corrections += 1;
        // A Chinese explanation has Han characters and no kana.
        if (NATIVE.startsWith('zh') ? /[一-鿿]/.test(why) && !/[぀-ヿ]/.test(why.replace(/[“”"「」『』][^“”"「」『』]*[“”"「」『』]/g, '')) : why !== '') explainedInNative += 1;
      }
      lines.push(`  ${said.right ? 'right' : 'WRONG'} | ${said.text} → ${JSON.stringify(shown)} (${answer.totalMs} ms)`);
    }
    console.log(`\n[${model}] verdicts right ${verdictsRight}/${SAID.length}; explanations in the native language ${explainedInNative}/${corrections}\n${lines.join('\n')}`);
    expect(lines).toHaveLength(SAID.length);
  }, 600_000);
});
