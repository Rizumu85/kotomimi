/**
 * Fork: the text models a phone lends (`android/`, 0.8.0 on) — the desktop's own native translators and feedback
 * model (`nativeTranslators.ts`, `nativeCoaches.ts`), the same files, run by llama.cpp on the phone's processor
 * behind its door on port 8792. A stage placed on such a phone is asked as this computer's native engine is, with
 * the model's own form of request, at the phone's address (`localai.ts` `buildLocalAI`).
 *
 * What differs from this computer's engine is the phone: it loads a model only when it is first asked for it (12 to
 * 17 s on a weak phone, up to 40 s when its memory is short), does one thing at a time — recognition and text in one
 * queue — and says when to come back: 429 while four requests already wait, 503 while it has not the memory now.
 * So a request to it is given longer, is asked again after the wait it names (a few times, never forever), and a
 * run's start asks it to load what it will be asked for (`warmPhones`).
 */
import { phoneBase, phoneRoom, phoneTextModels, plainAddress, type PhoneTextModel } from '../../lib/lan/discover';
import { NATIVE_COACHES } from './nativeCoaches';
import { NATIVE_TRANSLATORS, nativeTranslates } from './nativeTranslators';
import { chatUrl, NO_KEY } from './textModel';

/**
 * How long one answer from a phone may take: the load of its model (up to about 40 s), the requests ahead of it in
 * the phone's one queue, and the answer itself (3 to 10 s a sentence on a weak phone). The phone gives one up after
 * three minutes; this computer's own engines get one minute (`TEXT_TIMEOUT_MS`).
 */
export const PHONE_TEXT_TIMEOUT_MS = 120_000;

/** How many times a busy (429) or out-of-memory (503) answer of a phone is asked again. */
export const PHONE_BUSY_RETRIES = 3;

/** The phone's base URL for an address as stored (`host:port`, or typed with a scheme or a path). */
export const phoneTextBase = (address: string): string => phoneBase({ address: plainAddress(address) });

/** A phone's model list, as far as a text stage asks: what it lends of text models. Null: it could not be read. */
export async function phoneTextList(address: string, fetchIt: typeof fetch, signal: AbortSignal): Promise<PhoneTextModel[] | null> {
  const answer = await fetchIt(`${phoneTextBase(address)}/models`, { method: 'GET', signal });
  if (!answer.ok) return null;
  const body = (await answer.json().catch(() => null)) as { text?: unknown } | null;
  return body ? phoneTextModels(body.text, phoneRoom(body)) : null;
}

/** A model a run will ask of a phone, and the request that loads it: the first messages of the real ones. */
export interface PhoneWarm {
  address: string;
  model: string;
  /** What goes before the sentence in every request: for the feedback, its instructions and worked examples. */
  messages: ReadonlyArray<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  extra?: Readonly<Record<string, unknown>>;
}

/**
 * Asks each phone to load the models a run will ask of it, where its list says one is not loaded: a request of one
 * token, which the phone answers once the model is up. Its engine keeps what it read at the head of its one slot, so
 * the feedback's long instructions are read here, once, not with the first sentence. Not waited for: the start goes
 * on, and the first sentence waits behind this in the phone's queue — the load begins as the run does, not when the
 * first sentence is said. Best done: whatever fails here fails again where it is said, on that sentence.
 */
export function warmPhones(wanted: readonly PhoneWarm[], fetchIt: typeof fetch, signal: AbortSignal): Promise<void> {
  const one = async (warm: PhoneWarm) => {
    const lent = await phoneTextList(warm.address, fetchIt, signal);
    const model = lent?.find((m) => m.id === warm.model);
    if (!model || model.loaded) return;
    const answer = await fetchIt(chatUrl(phoneTextBase(warm.address)), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${NO_KEY}` },
      body: JSON.stringify({ ...(warm.extra ?? {}), model: warm.model, stream: false, max_tokens: 1, messages: [...warm.messages, { role: 'user', content: 'Hello' }] }),
      signal,
    });
    await answer.body?.cancel().catch(() => undefined);
  };
  return Promise.all(wanted.map((warm) => one(warm).catch(() => undefined))).then(() => undefined);
}

/**
 * Which of the models a phone lends a stage asks for when it is given the phone: the one already chosen where the
 * phone lends it, else the best of this computer's own order (`NATIVE_TRANSLATORS`, `NATIVE_COACHES`: best first) —
 * for a translation, one that translates the pair before one that does not, and one the phone has the memory for
 * now before one it has not (`fits`) — else the phone's first.
 */
export function lentChoice(lent: readonly PhoneTextModel[], kind: PhoneTextModel['kind'], pair: { source: string; target: string }, current = ''): string {
  const mine = lent.filter((m) => m.kind === kind);
  if (mine.some((m) => m.id === current)) return current;
  const order: readonly string[] = (kind === 'translate' ? NATIVE_TRANSLATORS : NATIVE_COACHES).map((m) => m.id);
  const rank = (m: PhoneTextModel) => {
    const at = order.indexOf(m.id);
    const fits = kind !== 'translate' || at < 0 || nativeTranslates(NATIVE_TRANSLATORS[at], pair.source, pair.target);
    return (fits ? 0 : 1000) + (m.fits === false ? 500 : 0) + (at < 0 ? 999 : at);
  };
  return [...mine].sort((a, b) => rank(a) - rank(b))[0]?.id ?? '';
}
