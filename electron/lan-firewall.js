// Fork: Windows' firewall and the port this computer shares its models on.
//
// A listening port is of no use to another device while the firewall drops
// what arrives at it, and on Windows it does, for any app it has not been
// told about. Windows may ask the first time an app listens — but only once,
// the answer is tied to the app's path (which an update changes), and a
// dialog dismissed is a refusal. A network Windows calls Public, which is
// what it calls a home Wi-Fi until told otherwise, is closed even to an app
// that was allowed on private ones. So the settings ask instead: is the port
// let through on the networks this computer is on now — and if not, a button
// that lets it through.
//
// Reading the rules needs no rights. Changing them does: the change is made
// by an elevated PowerShell, which makes Windows ask the user for consent,
// and a refusal there is the user's answer. What is added is a rule for the
// port, so it survives the app's updates: open to any address on private
// and domain networks, and on a public network — only when this computer is
// on one — to that network's own devices alone.
//
// Other systems are not handled here: macOS asks by itself, each time it
// needs to, and Linux desktops rarely filter a home network.
const { execFile } = require('child_process');

/** The group the fork's rules are filed under: what a later "Allow" replaces. */
const RULE_GROUP = 'Kotomimi';
const RULE_NAME = 'Kotomimi sharing';
const PUBLIC_RULE_NAME = 'Kotomimi sharing (public network, its own devices only)';

/** Windows' network kinds, as the bits its firewall counts them in. */
const DOMAIN = 1;
const PRIVATE = 2;
const PUBLIC = 4;
const KINDS = [DOMAIN, PRIVATE, PUBLIC];

const UNKNOWN = Object.freeze({ state: 'unknown', public: false });

/** A port as the rule takes it, or null for anything that is not one: it is written into a command. */
function validPort(port) {
  const n = Number(port);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

/** A string as a PowerShell single-quoted literal. */
const quoted = (text) => `'${String(text).replace(/'/g, "''")}'`;

/** A script as `-EncodedCommand` takes it: nothing in it is parsed by a shell on the way. */
const encoded = (script) => Buffer.from(script, 'utf16le').toString('base64');

/**
 * The PowerShell that reports, as JSON, what the firewall holds for this
 * program: which kinds of network the computer is on (`current`), whether the
 * firewall is on for each (`on`), and the enabled inbound TCP rules that could
 * decide a connection to it — those that name this program (`x`), and those
 * that name no program but a port. A rule with neither is left out with the
 * rules for a service: Windows keeps hundreds of them for packaged apps, whose
 * names this interface does not show, and none is about this program. The program's path is handed
 * in through the environment. Read through the firewall's COM interface, which
 * answers in about a second; the NetSecurity cmdlets take minutes over the
 * same rules.
 */
const STATUS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$fw = New-Object -ComObject HNetCfg.FwPolicy2',
  '$exe = $env:KOTOMIMI_EXE',
  "$on = @{ '1' = [bool]$fw.FirewallEnabled(1); '2' = [bool]$fw.FirewallEnabled(2); '4' = [bool]$fw.FirewallEnabled(4) }",
  '$rules = @($fw.Rules | Where-Object { $_.Enabled -and $_.Direction -eq 1 -and -not $_.ServiceName -and -not $_.LocalAppPackageId -and $(if ($_.ApplicationName) { ($_.Protocol -eq 6 -or $_.Protocol -eq 256) -and [Environment]::ExpandEnvironmentVariables($_.ApplicationName) -ieq $exe } else { $_.Protocol -eq 6 -and $_.LocalPorts -and $_.LocalPorts -ne "*" }) } | ForEach-Object { @{ a = [int]$_.Action; p = [int]$_.Profiles; l = [string]$_.LocalPorts; x = [bool]$_.ApplicationName } })',
  'ConvertTo-Json -InputObject @{ current = [int]$fw.CurrentProfileTypes; on = $on; rules = $rules } -Depth 4 -Compress',
].join('\n');

/** Whether a rule's ports (`*`, `80,443`, `5000-5010`, or none given) take in this one. */
function portIn(spec, port) {
  const text = String(spec ?? '').trim();
  if (text === '' || text === '*') return true;
  return portNamed(text, port);
}

/** Whether a rule's ports name this one outright, in a list or a range. */
function portNamed(spec, port) {
  return String(spec ?? '').split(',').some((part) => {
    const [from, to] = part.trim().split('-').map(Number);
    if (!Number.isInteger(from)) return false;
    return to === undefined ? from === port : Number.isInteger(to) && port >= from && port <= to;
  });
}

/**
 * What the report means for another device's connection to `port`.
 * A network kind lets it in when the firewall is off there, or when a rule
 * allows it and none blocks it: a block rule wins over any allow. `blocked`
 * when any kind the computer is on now keeps it out; `public` says a public
 * network is among those, and `refused` that a block rule naming this program
 * is — what Windows leaves behind when its own question was dismissed.
 */
function judge(report, port) {
  if (!report || typeof report !== 'object' || !Number.isInteger(report.current)) return { ...UNKNOWN, refused: false };
  // A rule that names this program counts for the ports it takes in; one that names none, only for a port it names.
  const rules = (Array.isArray(report.rules) ? report.rules : []).filter((r) => r && (r.x ? portIn(r.l, port) : portNamed(r.l, port)));
  const shut = KINDS.filter((kind) => {
    if (!(report.current & kind) || report.on?.[String(kind)] === false) return false;
    const here = rules.filter((r) => r.p & kind);
    return here.some((r) => r.a === 0) || !here.some((r) => r.a === 1);
  });
  return {
    state: shut.length > 0 ? 'blocked' : 'allowed',
    public: shut.includes(PUBLIC),
    refused: rules.some((r) => r.a === 0 && r.x && shut.some((kind) => r.p & kind)),
  };
}

/**
 * What the elevated PowerShell runs: the fork's earlier rules gone, the port
 * allowed on private and domain networks, on a public one only when asked and
 * only to that network's own devices — and, when Windows holds a block rule
 * for this program from a question once dismissed, that rule switched off,
 * since a block wins over any allow.
 */
function elevatedScript(port, { publicToo = false, unblock = null } = {}) {
  const rule = (name, rest) => `New-NetFirewallRule -DisplayName ${quoted(name)} -Group ${quoted(RULE_GROUP)} -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${port} ${rest} | Out-Null`;
  return [
    "$ErrorActionPreference = 'Stop'",
    `Get-NetFirewallRule -Group ${quoted(RULE_GROUP)} -ErrorAction SilentlyContinue | Remove-NetFirewallRule`,
    rule(RULE_NAME, '-Profile Private,Domain'),
    ...(publicToo ? [rule(PUBLIC_RULE_NAME, '-Profile Public -RemoteAddress LocalSubnet')] : []),
    ...(unblock ? [`Get-NetFirewallApplicationFilter -Program ${quoted(unblock)} -ErrorAction SilentlyContinue | Get-NetFirewallRule | Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' -and $_.Enabled -eq 'True' } | Disable-NetFirewallRule`] : []),
  ].join('\n');
}

/** The PowerShell that starts the elevated one and waits for it: Windows asks the user before it runs. */
function allowScript(port, options) {
  return `Start-Process -FilePath powershell.exe -Verb RunAs -WindowStyle Hidden -Wait -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded(elevatedScript(port, options))}'`;
}

function powershell(script, env, run = execFile) {
  return new Promise((resolve) => {
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(script)], { env: { ...process.env, ...env }, windowsHide: true, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      resolve({ ok: !error, out: String(stdout ?? '').trim() });
    });
  });
}

async function verdict(port, exe, run) {
  const answer = await powershell(STATUS_SCRIPT, { KOTOMIMI_EXE: exe }, run);
  if (!answer.ok) return { ...UNKNOWN, refused: false };
  try {
    return judge(JSON.parse(answer.out.slice(answer.out.indexOf('{'))), port);
  } catch {
    return { ...UNKNOWN, refused: false };
  }
}

/**
 * Whether another device's connection to `port` gets through, on the
 * networks this computer is on now: `{ state, public }`, the state `allowed`,
 * `blocked`, or `unknown` where it cannot be asked (not Windows, or
 * PowerShell would not answer).
 */
async function firewallStatus(port, { platform = process.platform, exe = process.execPath, run } = {}) {
  const valid = validPort(port);
  if (platform !== 'win32' || valid === null) return { ...UNKNOWN };
  const { state, public: onPublic } = await verdict(valid, exe, run);
  return { state, public: onPublic };
}

/** Lets the port through, with the user's consent. Answers the status afterwards: still `blocked` when the user said no. */
async function allowThroughFirewall(port, { platform = process.platform, exe = process.execPath, run } = {}) {
  const valid = validPort(port);
  if (platform !== 'win32' || valid === null) return { ...UNKNOWN };
  const before = await verdict(valid, exe, run);
  if (before.state !== 'blocked') return { state: before.state, public: before.public };
  await powershell(allowScript(valid, { publicToo: before.public, unblock: before.refused ? exe : null }), {}, run);
  return firewallStatus(valid, { platform, exe, run });
}

module.exports = { firewallStatus, allowThroughFirewall, judge, portIn, elevatedScript, allowScript, encoded, validPort, STATUS_SCRIPT, RULE_GROUP, RULE_NAME, PUBLIC_RULE_NAME };
