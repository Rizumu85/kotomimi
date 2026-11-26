/**
 * Fork: what the engines hold on the graphics card, written to the diagnostic log while a run goes on — a quarter of
 * a minute after it starts, when its models are up, then every minute. Per engine (recognizer, voice, translator,
 * feedback), VRChat's beside them, and the whole card: dedicated memory and the shared memory Windows moves it to
 * when the card is full, where everything runs many times slower (`electron/gpu-memory.js`). Read only while the
 * diagnostic log records: each reading starts a PowerShell.
 */
import type { Clock } from '../lib/contract/clock';
import type { RunState } from '../lib/session/types';
import useLogStore from '../stores/logStore';

const FIRST_MS = 15_000;
const EVERY_MS = 60_000;

type Invoke = (channel: string) => Promise<unknown>;

export function driveGpuMemoryLog(deps: {
  runner: { state: { getState(): RunState; subscribe(listener: () => void): () => void } };
  clock: Clock;
  invoke?: Invoke;
}): () => void {
  const invoke = deps.invoke ?? (window as unknown as { electron?: { invoke: Invoke } }).electron?.invoke;
  if (!invoke) return () => {};
  let timer: (() => void) | null = null;
  /** Counts runs: a reading that comes back after its run ended is not written into the next one. */
  let generation = 0;
  const read = async () => {
    if (!useLogStore.getState().enabled) return;
    const mine = generation;
    const memory = await invoke('gpu-memory:get').catch(() => null);
    if (memory && mine === generation && deps.runner.state.getState().phase === 'running') {
      useLogStore.getState().addRealtimeEvent({ type: 'local.memory', data: memory }, 'client', 'local.memory');
    }
  };
  const schedule = (ms: number) => {
    timer = deps.clock.setTimeout(() => { void read(); schedule(EVERY_MS); }, ms);
  };
  const phase = () => {
    const running = deps.runner.state.getState().phase === 'running';
    if (running && !timer) schedule(FIRST_MS);
    if (!running && timer) { timer(); timer = null; generation += 1; }
  };
  const off = deps.runner.state.subscribe(phase);
  phase();
  return () => { off(); timer?.(); timer = null; };
}
