/**
 * Fork: an API's own model list, asked for when the user opens the model
 * field's menu (`ApiModelPicker.tsx`).
 *
 * The check before a session lists the same models (`localai.ts`), but only
 * once every stage is set up, and its list is only as new as the last check.
 * This one is asked for the moment the menu is opened, of the one address the
 * field belongs to, with the key that is in the field: `GET {base}/models`,
 * as every OpenAI-compatible service answers it. The key rides in the
 * `Authorization` header, never the address.
 */
import { preferredModel, type ApiKind, type ApiService } from './apiServices';

/** The models a service lists, or why there is no list: the key was refused, nothing answered, or it lists none. */
export type ApiModelList = { ok: true; ids: readonly string[] } | { ok: false; why: 'key' | 'unreachable' | 'none' };

/** As long as the checks wait. */
export const LIST_TIMEOUT_MS = 15_000;

export interface ApiModelListDeps {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function listApiModels(baseUrl: string, key: string | undefined, deps: ApiModelListDeps = {}): Promise<ApiModelList> {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (!base) return { ok: false, why: 'unreachable' };
  // Read at call time, so a test's stubbed global is seen.
  const doFetch = deps.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), deps.timeoutMs ?? LIST_TIMEOUT_MS);
  const give = () => stop.abort();
  deps.signal?.addEventListener('abort', give, { once: true });
  if (deps.signal?.aborted) stop.abort();
  const token = key?.trim();
  try {
    const answer = await doFetch(`${base}/models`, { method: 'GET', ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}), signal: stop.signal });
    if (answer.status === 401 || answer.status === 403) return { ok: false, why: 'key' };
    if (answer.status === 400) {
      // Google answers a key it does not know with 400 and says so in words; any other 400 is a service that lists nothing.
      const said = await answer.text().catch(() => '');
      return { ok: false, why: /api[ _-]?key/i.test(said) ? 'key' : 'none' };
    }
    if (!answer.ok) return { ok: false, why: 'none' };
    const body = (await answer.json().catch(() => null)) as { data?: Array<{ id?: unknown }> } | null;
    const ids = [...new Set((body?.data ?? []).flatMap((m) => (typeof m.id === 'string' && m.id ? [m.id] : [])))];
    return ids.length > 0 ? { ok: true, ids } : { ok: false, why: 'none' };
  } catch {
    return { ok: false, why: 'unreachable' };
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener('abort', give);
  }
}

/** A query or a name as it is compared: full-width letters as plain ones, no case, and none of the marks an input method puts between syllables. */
const plain = (text: string): string => text.normalize('NFKC').toLowerCase().replace(/['’`]/g, '');
/** And without the marks a model's name is cut with, so that "gpt5" finds "gpt-5". */
const bare = (text: string): string => text.replace(/[-_./: ]/g, '');

/**
 * How well a name answers one word of a search, 0 for not at all: the word
 * as it stands in the name (best at its start, or at the start of one of its
 * parts), the word with the name's marks left out, or - for a word of three
 * letters or more - its letters in order with little between them.
 */
function wordScore(name: string, word: string): number {
  const at = name.indexOf(word);
  if (at >= 0) return 100 - Math.min(at, 40) + (at === 0 || /[-_./: ]/.test(name[at - 1]) ? 20 : 0);
  const loose = bare(word);
  if (loose && bare(name).includes(loose)) return 50;
  if (loose.length < 3) return 0;
  // The letters in order: from each place the first letter stands, the shortest stretch that holds them all.
  let best = 0;
  for (let from = name.indexOf(loose[0]); from >= 0; from = name.indexOf(loose[0], from + 1)) {
    let cursor = from;
    let found = true;
    for (let k = 1; k < loose.length; k += 1) {
      cursor = name.indexOf(loose[k], cursor + 1);
      if (cursor < 0) { found = false; break; }
    }
    if (!found) break;
    const span = cursor - from + 1;
    if (span <= loose.length * 2) best = Math.max(best, 40 - (span - loose.length));
  }
  return best;
}

/**
 * The names a search finds, best first: every word of it has to be found
 * (`wordScore`), in any order; names found equally well stay in the order
 * they were given. A search of no words finds them all.
 */
export function searchModels(ids: readonly string[], query: string | null): string[] {
  const words = plain(query ?? '').split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...ids];
  const found: Array<{ id: string; score: number; at: number }> = [];
  ids.forEach((id, at) => {
    const name = plain(id);
    let score = 0;
    for (const word of words) {
      const one = wordScore(name, word);
      if (one === 0) return;
      score += one;
    }
    found.push({ id, score, at });
  });
  return found.sort((a, b) => b.score - a.score || a.at - b.at).map((f) => f.id);
}

/**
 * The list as the menu shows it: the model that suits the stage first
 * (`preferredModel`), the rest as the service lists them - or, while
 * something is searched for, what the search finds, best first.
 */
export function menuOf(ids: readonly string[], query: string | null, service: ApiService | undefined, kind: ApiKind): { ids: string[]; suggested?: string } {
  const suggested = service ? preferredModel(service, kind, ids) : undefined;
  const ordered = suggested ? [suggested, ...ids.filter((id) => id !== suggested)] : [...ids];
  return { ids: searchModels(ordered, query), ...(suggested ? { suggested } : {}) };
}
