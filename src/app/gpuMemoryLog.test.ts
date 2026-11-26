import { afterEach, describe, expect, it, vi } from 'vitest';
import { driveGpuMemoryLog } from './gpuMemoryLog';
import useLogStore from '../stores/logStore';
import type { Clock } from '../lib/contract/clock';

/** A clock whose timers run only when told how much time has passed. */
function fakeClock() {
  let now = 0;
  const timers: { at: number; fn: () => void }[] = [];
  const clock = {
    now: () => now,
    setTimeout(fn: () => void, ms: number) { const timer = { at: now + ms, fn }; timers.push(timer); return () => { timers.splice(timers.indexOf(timer), 1); }; },
  } as unknown as Clock;
  const pass = async (ms: number) => {
    now += ms;
    for (;;) {
      const due = timers.filter((timer) => timer.at <= now).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      due.fn();
      await Promise.resolve();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { clock, pass, pending: () => timers.length };
}

function runner(phase: string) {
  const listeners = new Set<() => void>();
  let current = phase;
  return {
    state: { getState: () => ({ phase: current }) as never, subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); } },
    set(next: string) { current = next; for (const fn of listeners) fn(); },
  };
}

afterEach(() => { useLogStore.getState().clearLogs(); useLogStore.setState({ enabled: false }); });

describe('the graphics card in the diagnostic log', () => {
  it('reads a quarter of a minute into a run, then every minute, and stops with it', async () => {
    useLogStore.setState({ enabled: true });
    const { clock, pass, pending } = fakeClock();
    const run = runner('running');
    const invoke = vi.fn(async () => ({ card: { dedicatedMB: 9000, sharedMB: 1700 }, parts: {} }));
    const off = driveGpuMemoryLog({ runner: run, clock, invoke });
    await pass(14_000);
    expect(invoke).not.toHaveBeenCalled();
    await pass(1_000);
    expect(invoke).toHaveBeenCalledTimes(1);
    await pass(60_000);
    expect(invoke).toHaveBeenCalledTimes(2);
    const { logs, pendingLogs } = useLogStore.getState();
    expect([...logs, ...pendingLogs].filter((log) => log.eventType === 'local.memory')).toHaveLength(2);
    run.set('idle');
    expect(pending()).toBe(0);
    off();
  });

  it('starts nothing while the log does not record', async () => {
    const { clock, pass } = fakeClock();
    const invoke = vi.fn(async () => ({}));
    const off = driveGpuMemoryLog({ runner: runner('running'), clock, invoke });
    await pass(80_000);
    expect(invoke).not.toHaveBeenCalled();
    off();
  });
});
