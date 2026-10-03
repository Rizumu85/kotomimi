/**
 * The one Japanese tokenizer of the page: loaded on first need, shared by
 * every row that shows Japanese. A failed load is kept as failed — the rows
 * stay plain — and is not retried on every render.
 */
import { appDictionaryFile } from './japaneseDictionary';
import { buildJapaneseTokenizer, type DictionaryFile } from './japaneseTokenizer';
import type { JapaneseTokenizer } from './types';

type State = { status: 'idle' | 'loading' | 'failed' } | { status: 'ready'; tokenizer: JapaneseTokenizer };

let state: State = { status: 'idle' };
const listeners = new Set<() => void>();

function set(next: State): void {
  state = next;
  for (const listener of listeners) listener();
}

export function subscribeJapanese(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The tokenizer once loaded; undefined before, and after a failed load. */
export function japaneseTokenizer(): JapaneseTokenizer | undefined {
  return state.status === 'ready' ? state.tokenizer : undefined;
}

/** Starts the load unless it has started. `file` is the app's reader by default; a test hands its own. */
export function loadJapanese(file: DictionaryFile = appDictionaryFile): void {
  if (state.status !== 'idle') return;
  set({ status: 'loading' });
  buildJapaneseTokenizer(file).then((tokenizer) => set({ status: 'ready', tokenizer }), () => set({ status: 'failed' }));
}

/** Test only: back to not loaded. */
export function resetJapanese(): void {
  state = { status: 'idle' };
}
