// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createModelMemoryReader } = require('./model-memory.js');
const ROOT = String.raw`HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}`;
const adapter = (id, values) => `${ROOT}\\${id}\n${values}\n`;

describe('memory for native model recommendations', () => {
  it('reads the largest dedicated card, using QWORD above 4 GB rather than the truncated DWORD or the sum', async () => {
    const execFile = vi.fn().mockResolvedValue({ stdout:
      adapter('0000', '    HardwareInformation.qwMemorySize    REG_QWORD    0x600000000\n    HardwareInformation.MemorySize    REG_DWORD    0xffffffff') +
      adapter('0001', '    HardwareInformation.qwMemorySize    REG_QWORD    0x400000000') +
      adapter('0001\\Settings', '    HardwareInformation.qwMemorySize    REG_QWORD    0x800000000') });
    const read = createModelMemoryReader({ platform: 'win32', execFile });
    expect(await Promise.all([read(), read()])).toEqual([24576, 24576]);
    expect(await read()).toBe(24576);
    expect(execFile).toHaveBeenCalledTimes(3);
    expect(execFile).toHaveBeenNthCalledWith(1, 'reg.exe', ['query', ROOT, '/reg:64'], expect.objectContaining({ windowsHide: true, timeout: 10000 }));
    expect(execFile).toHaveBeenCalledWith('reg.exe', ['query', `${ROOT}\\0000`, '/reg:64'], expect.any(Object));
    expect(execFile).toHaveBeenCalledWith('reg.exe', ['query', `${ROOT}\\0001`, '/reg:64'], expect.any(Object));
  });

  it('uses DWORD only when QWORD is absent, and skips software adapters', async () => {
    const execFile = vi.fn().mockResolvedValue({ stdout:
      adapter('0000', '    HardwareInformation.MemorySize    REG_DWORD    0x80000000') +
      adapter('0001', '    MatchingDeviceId    REG_SZ    Root\\IndirectDisplay\n    HardwareInformation.qwMemorySize    REG_QWORD    0x800000000') +
      adapter('0002', '    DriverDesc    REG_SZ    Microsoft Basic Render Driver\n    HardwareInformation.qwMemorySize    REG_QWORD    0x800000000') +
      adapter('0003', '    HardwareInformation.qwMemorySize    REG_QWORD    invalid\n    HardwareInformation.MemorySize    REG_DWORD    0xffffffff') });
    expect(await createModelMemoryReader({ platform: 'win32', execFile })()).toBe(2048);
  });

  it('keeps a known zero as zero, without falling back to DWORD', async () => {
    const execFile = vi.fn().mockResolvedValue({ stdout: adapter('0000', '    HardwareInformation.qwMemorySize    REG_QWORD    0x0\n    HardwareInformation.MemorySize    REG_DWORD    0xffffffff') });
    expect(await createModelMemoryReader({ platform: 'win32', execFile })()).toBe(0);
  });

  it('counts half of Mac memory, once, without querying Windows', async () => {
    const totalmem = vi.fn(() => 32 * 1024 ** 3), execFile = vi.fn();
    const read = createModelMemoryReader({ platform: 'darwin', totalmem, execFile });
    expect(await read()).toBe(16384);
    expect(await read()).toBe(16384);
    expect(totalmem).toHaveBeenCalledTimes(1);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('caches an unreadable registry as unknown and never rejects', async () => {
    const execFile = vi.fn().mockRejectedValue(new Error('access denied'));
    const read = createModelMemoryReader({ platform: 'win32', execFile });
    expect(await read()).toBeNull();
    expect(await read()).toBeNull();
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it('keeps a readable adapter when another adapter denies access, without querying protected subkeys', async () => {
    const execFile = vi.fn(async (_bin, args) => {
      if (args[1] === ROOT) return { stdout: `${ROOT}\\0000\n${ROOT}\\0001\n${ROOT}\\Properties` };
      if (args[1] === `${ROOT}\\0001`) return { stdout: adapter('0001', '    HardwareInformation.qwMemorySize    REG_QWORD    0x400000000') };
      throw new Error('access denied');
    });
    expect(await createModelMemoryReader({ platform: 'win32', execFile })()).toBe(16384);
    expect(execFile).toHaveBeenCalledTimes(3);
  });

  it.each(['', adapter('0000', '    HardwareInformation.qwMemorySize    REG_QWORD    invalid')])('leaves missing or malformed memory unknown', async (stdout) => {
    expect(await createModelMemoryReader({ platform: 'win32', execFile: async () => ({ stdout }) })()).toBeNull();
  });

  it('leaves other platforms and a failing Mac memory read unknown', async () => {
    const execFile = vi.fn(), totalmem = vi.fn(() => { throw new Error('unavailable'); });
    expect(await createModelMemoryReader({ platform: 'linux', execFile, totalmem })()).toBeNull();
    expect(totalmem).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
    expect(await createModelMemoryReader({ platform: 'darwin', totalmem })()).toBeNull();
  });
});
