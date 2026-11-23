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
 * delivered participant chunks. What the app itself plays on the user's device
 * is always followed (`appCapture.ts`). Once playout is idle the follower has
 * no say.
 *
 * The echo's level is learned twice. From every pair of chunks, as the upper
 * edge of the quieter half of their differences: right where the echo is far
 * under the voice, and it gives way gently when the user talks through playout
 * for minutes. And from onsets, playout that begins on a quiet microphone,
 * where what the microphone then hears is the echo alone: a laptop's own
 * loudspeakers return playout 11 dB down, as loud as speech, and the first
 * estimate sat 10 dB under that echo's loud chunks, which all passed. The
 * louder estimate counts. Where the echo is as loud as the voice, nothing said
 * while playout sounds can pass: the microphone is then held for as long as it
 * does.
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
/**
 * Playout that reaches this level after this long under it is an onset. Loud enough that an echo at the starting
 * guess would be heard over a quiet room: a murmur just over the played floor began the measurement half a second
 * before the sentence it led into, and the echo it then missed counted against the echo.
 */
const ONSET_LOUD_DB = -35;
const ONSET_GAP_MS = 600;
/** How long from an onset the loudest of the microphone is set against the loudest of the playout. */
const ONSET_WINDOW_MS = 700;
/**
 * How long before an onset the microphone must have been quiet, and what quiet is: within this of the room's floor,
 * or under a level no voice at a microphone is. The second counts after noise suppression, which leaves a floor near
 * -100 dBFS that its own residue is 30 dB over.
 */
const ONSET_BEFORE_MS = 500;
const ONSET_QUIET_DB = 10;
const ONSET_QUIET_UNDER_DB = -50;
/** The microphone rising this far at an onset has heard its echo. */
const ONSET_RISE_DB = 6;
/** Onsets kept, and how many it takes to say anything. Their lower median counts: a user who starts talking at an onset is the rarer case. */
const ONSET_HISTORY = 9;
const ONSET_WARMUP = 3;
/** A microphone that stays under this through an onset is switched off, and says nothing of the room. */
const SILENT_DB = -100;

export interface EchoFollower {
  /** A mono chunk of playout at its captured level: 16-bit, or floats at full scale 1. */
  played(pcm: Int16Array | Float32Array): void;
  /** Whether a chunk of the microphone is louder than that sound come back would be. Null once playout is idle: nothing to compare with. */
  voiced(pcm: Int16Array): boolean | null;
  /** Forgets what played and what was learned of the room. */
  reset(): void;
}

function dbfs(pcm: Int16Array | Float32Array): number {
  let squares = 0;
  for (let i = 0; i < pcm.length; i++) squares += pcm[i] * pcm[i];
  const fullScale = pcm instanceof Float32Array ? 1 : 32768;
  // The trial's power floor gives digital silence a finite level for interpolation.
  return 10 * Math.log10(squares / pcm.length / fullScale ** 2 + 1e-12);
}

function quantile(sorted: number[], fraction: number): number {
  const at = (sorted.length - 1) * fraction;
  const low = Math.floor(at);
  return sorted[low] + (sorted[Math.ceil(at)] - sorted[low]) * (at - low);
}

/** `report`: told each onset as it is settled, for a diagnostic log. */
export function createEchoFollower(now: () => number = () => performance.now(), report?: (line: string) => void): EchoFollower {
  const playout: { at: number; level: number }[] = [];
  const heard: { at: number; level: number }[] = [];
  const levels: number[] = [];
  const ratios: number[] = [];
  const onsets: number[] = [];
  /** The onset being measured: the loudest of each side since it began, and of the microphone just before. */
  let onset: { until: number; before: number; played: number; heard: number } | null = null;
  let lastPlayed = -Infinity;
  let lastLoud = -Infinity;
  let levelCount = 0;
  let ratioCount = 0;
  let onsetCount = 0;
  let floor = INITIAL_FLOOR_DB;
  let coupling = INITIAL_COUPLING_DB;
  let onsetCoupling = -Infinity;

  const settle = (measured: NonNullable<typeof onset>) => {
    const told = (what: string) => report?.(`onset: before ${measured.before.toFixed(0)}, played ${measured.played.toFixed(0)}, heard ${measured.heard.toFixed(0)}, floor ${floor.toFixed(0)}: ${what}; echo ${onsetCoupling.toFixed(1)} or ${coupling.toFixed(1)} under playout`);
    // A user already talking, or a microphone switched off or not delivering, hides the echo.
    if (measured.before > Math.max(floor + ONSET_QUIET_DB, ONSET_QUIET_UNDER_DB) || measured.heard < SILENT_DB) return told('not counted');
    let ratio: number;
    if (measured.heard >= measured.before + ONSET_RISE_DB) ratio = measured.heard - measured.played;
    // Nothing came back of playout whose echo, were it as loud as the starting guess, would have: a vote for "far under".
    else if (measured.played + INITIAL_COUPLING_DB >= measured.before + ONSET_RISE_DB) ratio = -Infinity;
    else return told('not counted');
    onsets[onsetCount++ % ONSET_HISTORY] = ratio;
    if (onsetCount >= ONSET_WARMUP) {
      const sorted = onsets.slice().sort((a, b) => a - b);
      onsetCoupling = sorted[Math.floor((sorted.length - 1) / 2)];
    }
    told(`counted ${ratio.toFixed(1)}`);
  };

  return {
    played(pcm) {
      const level = dbfs(pcm);
      if (level < PLAYED_FLOOR_DB) return;
      const at = now();
      if (level >= ONSET_LOUD_DB) {
        if (at - lastLoud >= ONSET_GAP_MS) {
          let before = -Infinity;
          for (const chunk of heard) if (at - chunk.at < ONSET_BEFORE_MS) before = Math.max(before, chunk.level);
          onset = { until: at + ONSET_WINDOW_MS, before, played: level, heard: -Infinity };
        }
        lastLoud = at;
      }
      if (onset && at < onset.until) onset.played = Math.max(onset.played, level);
      lastPlayed = at;
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
      while (heard.length && at - heard[0].at >= ONSET_BEFORE_MS) heard.shift();
      heard.push({ at, level });
      if (onset) {
        if (at < onset.until) {
          onset.heard = Math.max(onset.heard, level);
        } else {
          settle(onset);
          onset = null;
        }
      }
      // Null, not true: a gate told "voiced" holds itself open, and an echo's first syllable passed in that hold.
      if (at - lastPlayed >= IDLE_MS) return null;
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
        (echoOf < PLAYED_FLOOR_DB || level - echoOf > Math.max(coupling, onsetCoupling) + OVER_ECHO_DB);
    },
    reset() {
      playout.length = heard.length = levels.length = ratios.length = onsets.length = 0;
      onset = null;
      lastPlayed = lastLoud = -Infinity;
      levelCount = ratioCount = onsetCount = 0;
      floor = INITIAL_FLOOR_DB;
      coupling = INITIAL_COUPLING_DB;
      onsetCoupling = -Infinity;
    },
  };
}
