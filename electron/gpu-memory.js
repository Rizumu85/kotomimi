// Fork: what the app's engines hold on the graphics card, for the diagnostic log — dedicated memory and the shared
// memory Windows moves it to when the card is full (where everything runs many times slower), per engine, for VRChat
// beside it, and for the whole card. Read from Windows' own per-process counters, as Task Manager shows them, in one
// PowerShell call. Windows only: elsewhere there is nothing to read this way.
const { execFile } = require('child_process');

const MB = 1024 ** 2;

/** Dedicated and shared MB of each group of processes, VRChat's, and the card's: or null where none can be read. */
function readGpuMemory(groups, { platform = process.platform, run = execFile } = {}) {
  if (platform !== 'win32') return Promise.resolve(null);
  const pids = Object.values(groups).flat().filter((pid) => Number.isInteger(pid) && pid > 0);
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$own = @(${pids.join(',')})`,
    "$vr = @(Get-Process -Name VRChat | ForEach-Object { $_.Id })",
    "$all = $own + $vr",
    "$c = (Get-Counter -Counter '\\GPU Process Memory(*)\\Dedicated Usage','\\GPU Process Memory(*)\\Shared Usage','\\GPU Adapter Memory(*)\\Dedicated Usage','\\GPU Adapter Memory(*)\\Shared Usage').CounterSamples",
    "$out = @{ vr = $vr; procs = @{}; card = @{ d = 0; s = 0 } }",
    "foreach ($x in $c) {",
    "  $shared = $x.Path -like '*shared usage'",
    "  if ($x.Path -like '*gpu adapter memory*') { if ($shared) { $out.card.s += $x.CookedValue } else { $out.card.d += $x.CookedValue }; continue }",
    "  if ($x.InstanceName -match '^pid_(\\d+)_') { $p = [int]$Matches[1]; if ($all -contains $p) {",
    "    $k = [string]$p; if (-not $out.procs[$k]) { $out.procs[$k] = @{ d = 0; s = 0 } }",
    "    if ($shared) { $out.procs[$k].s += $x.CookedValue } else { $out.procs[$k].d += $x.CookedValue } } }",
    "}",
    '$out | ConvertTo-Json -Depth 4 -Compress',
  ].join('\n');
  return new Promise((resolve) => {
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15_000 }, (error, stdout) => {
      let read;
      try { read = error ? null : JSON.parse(String(stdout)); } catch { read = null; }
      if (!read) { resolve(null); return; }
      const sizes = (pidList) => pidList.reduce((sum, pid) => {
        const one = read.procs?.[String(pid)];
        return one ? { dedicatedMB: sum.dedicatedMB + one.d / MB, sharedMB: sum.sharedMB + one.s / MB } : sum;
      }, { dedicatedMB: 0, sharedMB: 0 });
      const round = ({ dedicatedMB, sharedMB }) => ({ dedicatedMB: Math.round(dedicatedMB), sharedMB: Math.round(sharedMB) });
      const parts = Object.fromEntries(Object.entries(groups).filter(([, list]) => list.length).map(([name, list]) => [name, round(sizes(list))]));
      const vr = [].concat(read.vr ?? []);
      if (vr.length) parts.vrchat = round(sizes(vr));
      resolve({ card: round({ dedicatedMB: read.card.d / MB, sharedMB: read.card.s / MB }), parts });
    });
  });
}

module.exports = { readGpuMemory };
