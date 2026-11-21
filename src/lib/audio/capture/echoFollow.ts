/**
 * Fork: compares the microphone level with recent system playout to decide
 * whether the user is speaking. In recorded sessions the loudspeaker
 * echo measured about -64 dBFS, roughly 30 dB below the user's voice at -32 dBFS.
 * System-wide echo cancellation also lowered the user's voice while the other
 * side spoke. Gate mode turns off the browser's echo cancellation (it took the
 * user's own voice for echo where the app plays it back: passthrough) and its
 * automatic gain, so the level difference it learns stays stable.
 *
 * A whole-system participant capture supplies its mix even while muted. Windows
 * can also capture playout just for the gate. Without either, the follower uses
 * delivered participant chunks and passes the microphone once playout is idle.
 */
/** Playout quieter than this cannot open a stretch of talk. */
const PLAYED_FLOOR_DB = -55;
/** Covers about 90 ms for the acoustic echo plus 380 ms for browser processing and recorder delivery. */
const ECHO_WINDOW_MS = 1000;
/** A pause this long ends a stretch of talk. */
const IDLE_MS = 1500;
/** How far speech must rise above the room's floor. */
const OVER_FLOOR_DB = 15;
/** How far speech must rise above the expected echo. */
const OVER_ECHO_DB = 8;
/** Number of recent observations kept for each estimate. */
const HISTORY_CHUNKS = 1500;
/** Observations needed before either estimate replaces its starting value. */
const WARMUP_CHUNKS = 100;
/** Microphone chunks between room floor estimates. */
const FLOOR_INTERVAL = 50;
/** Paired microphone and playout chunks between coupling estimates. */
const COUPLING_INTERVAL = 25;
/** Room floor in dBFS before enough microphone chunks have arrived. */
const INITIAL_FLOOR_DB = -60;
/** Echo level relative to playout before enough pairs have arrived. */
const INITIAL_COUPLING_DB = -20;
/** The quiet fifth of microphone levels sets the room floor. */
const FLOOR_QUANTILE = 0.2;
/** The upper edge of the quieter half of level differences represents echo. */
const COUPLING_QUANTILE = 0.9;

export interface EchoFollower {
  /** A mono chunk of playout at its captured level. */
  played(pcm: Int16Array): void;
  /** Whether a chunk of the microphone is louder than that sound come back would be. */
  voiced(pcm: Int16Array): boolean;
  /** Forgets what played and what was learned of the room. */
  reset(): void;
}

function dbfs(pcm: Int16Array): number {
  let squares = 0;
  for (let i = 0; i < pcm.length; i++) squares += pcm[i] * pcm[i];
  // The trial's power floor gives digital silence a finite level for interpolation.
  return 10 * Math.log10(squares / pcm.length / 32768 ** 2 + 1e-12);
}

function quantile(sorted: number[], fraction: number): number {
  const at = (sorted.length - 1) * fraction;
  const low = Math.floor(at);
  return sorted[low] + (sorted[Math.ceil(at)] - sorted[low]) * (at - low);
}

export function createEchoFollower(now: () => number = () => performance.now()): EchoFollower {
  const playout: { at: number; level: number }[] = [];
  const levels: number[] = [];
  const ratios: number[] = [];
  let lastPlayed = -Infinity;
  let levelCount = 0;
  let ratioCount = 0;
  let floor = INITIAL_FLOOR_DB;
  let coupling = INITIAL_COUPLING_DB;

  return {
    played(pcm) {
      const level = dbfs(pcm);
      if (level < PLAYED_FLOOR_DB) return;
      lastPlayed = now();
      while (playout.length && lastPlayed - playout[0].at >= ECHO_WINDOW_MS) playout.shift();
      playout.push({ at: lastPlayed, level });
    },
    voiced(pcm) {
      const level = dbfs(pcm);
      levels[levelCount++ % HISTORY_CHUNKS] = level;
      if (levelCount >= WARMUP_CHUNKS && levelCount % FLOOR_INTERVAL === 0) {
        floor = quantile(levels.slice().sort((a, b) => a - b), FLOOR_QUANTILE);
      }

      const at = now();
      if (at - lastPlayed >= IDLE_MS) return true;
      let echoOf = -Infinity;
      for (let i = playout.length - 1; i >= 0 && at - playout[i].at < ECHO_WINDOW_MS; i--) {
        echoOf = Math.max(echoOf, playout[i].level);
      }
      if (echoOf >= PLAYED_FLOOR_DB) {
        ratios[ratioCount++ % HISTORY_CHUNKS] = level - echoOf;
        if (ratioCount >= WARMUP_CHUNKS && ratioCount % COUPLING_INTERVAL === 0) {
          const low = ratios.slice().sort((a, b) => a - b).slice(0, Math.floor(ratios.length / 2));
          coupling = quantile(low, COUPLING_QUANTILE);
        }
      }
      return level > floor + OVER_FLOOR_DB &&
        (echoOf < PLAYED_FLOOR_DB || level - echoOf > coupling + OVER_ECHO_DB);
    },
    reset() {
      playout.length = levels.length = ratios.length = 0;
      lastPlayed = -Infinity;
      levelCount = ratioCount = 0;
      floor = INITIAL_FLOOR_DB;
      coupling = INITIAL_COUPLING_DB;
    },
  };
}
