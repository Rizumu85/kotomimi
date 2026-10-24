/**
 * Fork: whether a phone a run is using is still there. A phone lent to this computer (`android/`) can stop answering
 * mid-run without a word — locked or sent to the background, some makers' systems freeze its app (seen 2026-10-20) —
 * and a recognition or a sentence sent to it then waits out its whole timeout (a minute, two) with nothing on the
 * screen to say why. So while a run lasts, each phone it uses is asked every few seconds for its list of models,
 * which its door answers at once whatever its engine is doing; a few asks unanswered in a row and the user is told.
 *
 * Nothing is done to the run: what was sent waits as it did, and when the phone is opened again it answers.
 */
import type { Clock } from '../../lib/contract/clock';
import { phoneKey } from '../../lib/lan/phoneKeys';

/** How often a phone in use is asked, and how long it has to answer. */
export const PHONE_WATCH_EVERY_MS = 5_000;
export const PHONE_WATCH_WAIT_MS = 3_000;
/** Asks unanswered in a row before the phone is taken to be gone: one can be lost to a busy Wi-Fi. */
export const PHONE_WATCH_MISSES = 2;

export interface PhoneWatch {
  /** Watches the phone at this base URL (`http://192.168.1.23:8792/v1`) too; one already watched is left as it is. */
  add(base: string): void;
  stop(): void;
}

interface Watched {
  misses: number;
  quiet: boolean;
  cancel: () => void;
  asking: AbortController | null;
}

/**
 * The phones said to be quiet, by base URL, and by which watch: both legs of a run may use one phone (each side's
 * translation), and it is said once, not once a leg (seen 2026-10-23: the notice twice in the panel).
 */
const saidQuiet = new Map<string, object>();

export function watchPhones({ fetch: doFetch, clock, onQuiet }: {
  fetch: typeof fetch;
  clock: Clock;
  /** The phone stopped answering: said once until it answers again, whichever watches of a run see it. */
  onQuiet(base: string): void;
}): PhoneWatch {
  const self = {};
  const watched = new Map<string, Watched>();
  let stopped = false;

  const ask = async (base: string, w: Watched) => {
    const asking = new AbortController();
    w.asking = asking;
    const cancelWait = clock.setTimeout(() => asking.abort(new Error('no answer')), PHONE_WATCH_WAIT_MS);
    let answered: boolean;
    try {
      // Any answer is the phone's: a frozen app gives none.
      const key = phoneKey(base);
      await doFetch(`${base}/models`, { signal: asking.signal, ...(key ? { headers: { Authorization: `Bearer ${key}` } } : {}) });
      answered = true;
    } catch {
      answered = false;
    }
    cancelWait();
    w.asking = null;
    if (stopped) return;
    if (answered) {
      w.misses = 0;
      w.quiet = false;
      if (saidQuiet.get(base) === self) saidQuiet.delete(base);
    } else if (++w.misses >= PHONE_WATCH_MISSES && !w.quiet) {
      w.quiet = true;
      if (!saidQuiet.has(base)) {
        saidQuiet.set(base, self);
        onQuiet(base);
      }
    }
    w.cancel = clock.setTimeout(() => void ask(base, w), PHONE_WATCH_EVERY_MS);
  };

  return {
    add(base) {
      const key = base.replace(/\/+$/, '');
      if (stopped || !key || watched.has(key)) return;
      const w: Watched = { misses: 0, quiet: false, cancel: () => {}, asking: null };
      watched.set(key, w);
      w.cancel = clock.setTimeout(() => void ask(key, w), PHONE_WATCH_EVERY_MS);
    },
    stop() {
      stopped = true;
      for (const [base, w] of watched) {
        if (saidQuiet.get(base) === self) saidQuiet.delete(base);
        w.cancel();
        w.asking?.abort(new Error('the run ended'));
      }
      watched.clear();
    },
  };
}
