// Fork: memory available to native models. Read once per main process, including an unknown answer.
const os = require('os');
const { promisify } = require('util');
const execFile = promisify(require('child_process').execFile);

const DISPLAY_CLASS = String.raw`HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}`;
const MB = 1024 ** 2;
const isAdapterKey = (key) => key.toLowerCase().startsWith(`${DISPLAY_CLASS.toLowerCase()}\\`) && /^\d{4}$/.test(key.slice(DISPLAY_CLASS.length + 1));

function windowsMemory(stdout) {
  const adapters = [];
  let adapter = null;
  for (const line of stdout.split(/\r?\n/)) {
    const key = line.trim();
    if (/^HKEY_/i.test(key)) {
      adapter = isAdapterKey(key) ? {} : null;
      if (adapter) adapters.push(adapter);
    } else if (adapter) {
      const value = line.match(/^\s+(\S+)\s+REG_\w+\s+(.*?)\s*$/);
      if (value) adapter[value[1].toLowerCase()] = value[2];
    }
  }
  const sizes = adapters.flatMap((adapter) => {
    if (/^(root|swd)\\/i.test(adapter.matchingdeviceid ?? '') || /software|basic render|remote display|indirect display/i.test(adapter.driverdesc ?? '')) return [];
    // The DWORD can be truncated above 4 GB: use it only if the QWORD is absent.
    const raw = adapter['hardwareinformation.qwmemorysize'] ?? adapter['hardwareinformation.memorysize'];
    const bytes = raw && /^(?:0x[\da-f]+|\d+)$/i.test(raw) ? Number(raw) : NaN;
    return Number.isFinite(bytes) && bytes >= 0 ? [bytes / MB] : [];
  });
  return sizes.length ? Math.max(...sizes) : null;
}

function createModelMemoryReader(deps = {}) {
  const { platform = process.platform, totalmem = os.totalmem, execFile: execute = execFile } = deps;
  let cached;
  async function read() {
    try {
      if (platform === 'darwin') {
        const bytes = totalmem();
        return Number.isFinite(bytes) && bytes > 0 ? bytes / 2 / MB : null;
      }
      if (platform !== 'win32') return null;
      const query = (key) => execute('reg.exe', ['query', key, '/reg:64'], {
        encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 2 * MB,
      });
      const { stdout } = await query(DISPLAY_CLASS);
      // Only the adapter values: recursing through drivers' settings can take seconds or hit protected keys.
      const keys = stdout.split(/\r?\n/).map((line) => line.trim()).filter(isAdapterKey);
      const answers = await Promise.allSettled(keys.map(query));
      return windowsMemory(answers.flatMap((answer) => answer.status === 'fulfilled' ? [answer.value.stdout] : []).join('\n'));
    } catch {
      // This is advice, not a requirement to run a model: unreadable hardware stays unknown.
      return null;
    }
  }
  return () => cached ??= read();
}

module.exports = { createModelMemoryReader };
