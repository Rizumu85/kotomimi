import { describe, expect, it } from 'vitest';

const { readGpuMemory } = require('./gpu-memory.js');

const MB = 1024 ** 2;
/** What the PowerShell answers: per-process counters by pid, VRChat's pids, and the card's totals, in bytes. */
const answer = (read) => (file, args, options, done) => done(null, JSON.stringify(read));

describe('what the engines hold on the graphics card', () => {
  it('sums each engine\'s processes, VRChat\'s and the card\'s, dedicated and shared, in MB', async () => {
    const run = answer({
      vr: 300,
      procs: { 101: { d: 1500 * MB, s: 20 * MB }, 102: { d: 100 * MB, s: 0 }, 201: { d: 2700 * MB, s: 1600 * MB }, 300: { d: 3800 * MB, s: 70 * MB } },
      card: { d: 9000 * MB, s: 1700 * MB },
    });
    const read = await readGpuMemory({ recognizer: [101, 102], voice: [201], translator: [] }, { platform: 'win32', run });
    expect(read).toEqual({
      card: { dedicatedMB: 9000, sharedMB: 1700 },
      parts: {
        recognizer: { dedicatedMB: 1600, sharedMB: 20 },
        voice: { dedicatedMB: 2700, sharedMB: 1600 },
        vrchat: { dedicatedMB: 3800, sharedMB: 70 },
      },
    });
  });

  it('is nothing where it cannot be read: another system, a failed call, an answer that is no JSON', async () => {
    expect(await readGpuMemory({ voice: [1] }, { platform: 'darwin' })).toBeNull();
    expect(await readGpuMemory({ voice: [1] }, { platform: 'win32', run: (f, a, o, done) => done(new Error('no')) })).toBeNull();
    expect(await readGpuMemory({ voice: [1] }, { platform: 'win32', run: (f, a, o, done) => done(null, 'not json') })).toBeNull();
  });
});
