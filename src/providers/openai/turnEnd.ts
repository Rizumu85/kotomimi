/**
 * Fork: whether what a recognizer has written so far reads as a finished turn, so that a short pause may end it
 * (`nativeAsr.ts`, the early end). Its marks do not tell: a partial ends on 。 wherever the speaker breathes
 * (「撞倒摄影师的汽车司机，未必。」 1.2 s before the end, 2026-10-28). The words a spoken sentence closes on do: a
 * speaker who stops in the middle of one has not said them yet.
 *
 * Only words that close a sentence and seldom stand inside one: Japanese's polite forms and closing particles,
 * Korean's endings, Chinese's question and mood particles (not 呢 or 啊, which also hold a sentence open: 然后呢…),
 * and a question mark in any language. A plain statement in Chinese, or most sentences in English, has no such word,
 * and waits for the detector's whole pause as before.
 */
const ENDINGS: readonly RegExp[] = [
  /(?:です|ます|ました|でした|ません|ましょう|でしょう|ください|ですね|ますね|ですよ|ますよ|よね|だよ|だね|かな|かしら|ですか|ますか|のか|わね|のよ)$/,
  /[요다까죠]$/,
  /[吗吧嘛啦呀]$/,
];
/** What may follow the last word: closing marks and quotes, a space. */
const TRAILING = /[\s。．.!！、，,…~～」』"'”’)）]+$/u;
const QUESTION = /[?？]$/;

export function endsTurn(text: string): boolean {
  const said = text.trimEnd();
  if (!/[\p{L}\p{N}]/u.test(said)) return false;
  if (QUESTION.test(said.replace(/[」』"'”’)）]+$/u, ''))) return true;
  const word = said.replace(TRAILING, '');
  return ENDINGS.some((ending) => ending.test(word));
}
