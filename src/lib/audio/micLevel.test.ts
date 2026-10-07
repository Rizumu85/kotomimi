import { afterEach, describe, expect, it, vi } from 'vitest';
import { MIC_LEVEL_STALE_MS, micLevel } from './micLevel';

afterEach(() => micLevel.reset());

describe('micLevel', () => {
  it('reads what was last set, while it is fresh', () => {
    micLevel.set(63, 1000);
    expect(micLevel.read(1000)).toBe(63);
    expect(micLevel.live(1000 + MIC_LEVEL_STALE_MS)).toBe(true);
    expect(micLevel.read(1000 + MIC_LEVEL_STALE_MS)).toBe(63);
  });

  it('reads flat, and not live, once nothing has reported for a while', () => {
    micLevel.set(63, 1000);
    expect(micLevel.live(1000 + MIC_LEVEL_STALE_MS + 1)).toBe(false);
    expect(micLevel.read(1000 + MIC_LEVEL_STALE_MS + 1)).toBe(0);
  });

  it('starts flat', () => {
    expect(micLevel.live()).toBe(false);
    expect(micLevel.read()).toBe(0);
  });

  it('tells its listeners of every report, until they leave', () => {
    const listener = vi.fn();
    const off = micLevel.subscribe(listener);
    micLevel.set(10);
    micLevel.set(20);
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    micLevel.set(30);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
