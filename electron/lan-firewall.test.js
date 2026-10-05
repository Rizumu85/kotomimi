// @vitest-environment node
// electron/lan-firewall.test.js
//
// Fork: the firewall question behind "share this computer's models". No rule
// is read or written here: PowerShell is a recorder, and what is held is
// what it is asked, how its report is read, and what the elevated script
// would do.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { firewallStatus, allowThroughFirewall, judge, portIn, elevatedScript, allowScript, encoded, validPort, STATUS_SCRIPT, RULE_GROUP } = require('./lan-firewall.js');

const decoded = (base64) => Buffer.from(base64, 'base64').toString('utf16le');

/** A PowerShell that answers each script in turn, and keeps what it was asked. */
function shell(...answers) {
  const calls = [];
  const run = (file, args, options, done) => {
    calls.push({ file, args, script: decoded(args[args.length - 1]), env: options.env });
    const next = answers.shift() ?? { out: '' };
    done(next.error ?? null, next.out ?? '');
  };
  return { run, calls };
}

const ALL = 0x7fffffff;
const allow = (p, l = '8790', x = false) => ({ a: 1, p, l, x });
/** A rule that names this program: Windows' own, for every port. */
const mine = (a, p) => ({ a, p, l: '*', x: true });
const block = (p) => mine(0, p);
/** The report of a computer on the given kinds of network, the firewall on for all of them. */
const report = (current, rules = []) => ({ current, on: { 1: true, 2: true, 4: true }, rules });
const answer = (current, rules) => ({ out: JSON.stringify(report(current, rules)) });

describe('the port, before it is written into a command', () => {
  it('is a whole number in range, or nothing', () => {
    expect(validPort(8790)).toBe(8790);
    expect(validPort('8790')).toBe(8790);
    for (const bad of [0, 70000, 87.5, '8790; Remove-Item x', null, undefined, NaN]) expect(validPort(bad)).toBeNull();
  });

  it('is found in a rule\'s ports: every port, a list, a range — and not in a name Windows gives a port', () => {
    expect(portIn('*', 8790)).toBe(true);
    expect(portIn('', 8790)).toBe(true);
    expect(portIn('80,8790', 8790)).toBe(true);
    expect(portIn('8000-9000', 8790)).toBe(true);
    expect(portIn('80,443', 8790)).toBe(false);
    expect(portIn('8791-9000', 8790)).toBe(false);
    expect(portIn('RPC', 8790)).toBe(false);
  });
});

describe('what the firewall\'s report means', () => {
  it('is blocked where no rule allows the port, on any kind of network the computer is on', () => {
    expect(judge(report(2), 8790)).toEqual({ state: 'blocked', public: false, refused: false });
    expect(judge(report(4), 8790)).toEqual({ state: 'blocked', public: true, refused: false });
    // Allowed on the private one, and still out on the public Wi-Fi beside it.
    expect(judge(report(6, [allow(3)]), 8790)).toEqual({ state: 'blocked', public: true, refused: false });
  });

  it('is allowed by a rule for the port or for the program, on every kind it is on', () => {
    expect(judge(report(2, [allow(3)]), 8790).state).toBe('allowed');
    expect(judge(report(6, [allow(3), allow(4)]), 8790).state).toBe('allowed');
    expect(judge(report(6, [mine(1, ALL)]), 8790).state).toBe('allowed');
    // A rule for another port, or for a kind of network it is not on, changes nothing.
    expect(judge(report(2, [allow(3, '9000')]), 8790).state).toBe('blocked');
    expect(judge(report(2, [allow(4)]), 8790).state).toBe('blocked');
  });

  it('does not count a rule that names no program and no port: Windows keeps those for packaged apps', () => {
    expect(judge(report(2, [allow(ALL, '')]), 8790).state).toBe('blocked');
    expect(judge(report(2, [allow(ALL, '*')]), 8790).state).toBe('blocked');
    expect(judge(report(2, [allow(3), { a: 0, p: ALL, l: '', x: false }]), 8790).state).toBe('allowed');
  });

  it('counts a block rule over any allow, and says when it names this program', () => {
    expect(judge(report(2, [allow(3), block(2)]), 8790)).toEqual({ state: 'blocked', public: false, refused: true });
    // A block on a kind of network it is not on is not in the way.
    expect(judge(report(2, [allow(3), block(4)]), 8790)).toEqual({ state: 'allowed', public: false, refused: false });
  });

  it('is allowed where the firewall is off, or where there is no network at all', () => {
    expect(judge({ current: 4, on: { 1: true, 2: true, 4: false }, rules: [] }, 8790).state).toBe('allowed');
    expect(judge(report(0), 8790).state).toBe('allowed');
  });

  it('is unknown for a report that is none', () => {
    for (const bad of [null, 'yes', {}, { current: 'x' }]) expect(judge(bad, 8790).state).toBe('unknown');
  });
});

describe('asking whether the port is let through', () => {
  it('asks the firewall once, the program\'s path by the environment, and reads the report', async () => {
    const ps = shell(answer(6, [allow(3)]));
    expect(await firewallStatus(8790, { platform: 'win32', exe: "C:\\Apps\\Koto 'mimi\\kotomimi.exe", run: ps.run })).toEqual({ state: 'blocked', public: true });
    expect(ps.calls).toHaveLength(1);
    expect(ps.calls[0].file).toBe('powershell.exe');
    expect(ps.calls[0].args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand']);
    expect(ps.calls[0].script).toBe(STATUS_SCRIPT);
    // None of the path is in the command; reading changes nothing.
    expect(ps.calls[0].script).not.toContain('mimi');
    expect(ps.calls[0].script).not.toMatch(/NetFirewallRule|RunAs/);
    expect(ps.calls[0].env.KOTOMIMI_EXE).toBe("C:\\Apps\\Koto 'mimi\\kotomimi.exe");
  });

  it('is unknown when PowerShell would not answer, or answered what is no report', async () => {
    expect(await firewallStatus(8790, { platform: 'win32', run: shell({ error: new Error('not found') }).run })).toEqual({ state: 'unknown', public: false });
    expect(await firewallStatus(8790, { platform: 'win32', run: shell({ out: 'Access denied' }).run })).toEqual({ state: 'unknown', public: false });
  });

  it('asks nothing on another system, or for what is no port', async () => {
    const ps = shell();
    expect((await firewallStatus(8790, { platform: 'darwin', run: ps.run })).state).toBe('unknown');
    expect((await firewallStatus('8790; calc', { platform: 'win32', run: ps.run })).state).toBe('unknown');
    expect((await allowThroughFirewall(8790, { platform: 'linux', run: ps.run })).state).toBe('unknown');
    expect(ps.calls).toEqual([]);
  });
});

describe('letting the port through', () => {
  it('replaces the fork\'s rules with one for the port on private and domain networks', () => {
    const script = elevatedScript(8790);
    expect(script).toContain(`Get-NetFirewallRule -Group '${RULE_GROUP}' -ErrorAction SilentlyContinue | Remove-NetFirewallRule`);
    expect(script).toContain('-Direction Inbound -Action Allow -Protocol TCP -LocalPort 8790 -Profile Private,Domain');
    expect(script).not.toContain('Public');
    expect(script).not.toContain('Disable-NetFirewallRule');
  });

  it('opens a public network only when asked, and then to that network\'s own devices', () => {
    const script = elevatedScript(8790, { publicToo: true });
    expect(script).toContain('-LocalPort 8790 -Profile Public -RemoteAddress LocalSubnet');
  });

  it('switches off a block rule that names this program, the path quoted whole', () => {
    const script = elevatedScript(8790, { unblock: "C:\\Apps\\Koto 'mimi\\kotomimi.exe" });
    expect(script).toContain("Get-NetFirewallApplicationFilter -Program 'C:\\Apps\\Koto ''mimi\\kotomimi.exe'");
    expect(script).toContain("$_.Action -eq 'Block'");
    expect(script).toContain('Disable-NetFirewallRule');
  });

  it('runs it elevated — Windows asks the user first — for exactly what was shut, then asks the firewall again', async () => {
    const ps = shell(answer(6, [allow(3)]), { out: '' }, answer(6, [allow(3), allow(4)]));
    expect(await allowThroughFirewall(8790, { platform: 'win32', exe: 'C:\\k.exe', run: ps.run })).toEqual({ state: 'allowed', public: false });
    expect(ps.calls.map((c) => c.script)).toEqual([STATUS_SCRIPT, allowScript(8790, { publicToo: true, unblock: null }), STATUS_SCRIPT]);
    const outer = ps.calls[1].script;
    expect(outer).toContain('-Verb RunAs');
    // What runs elevated travels encoded: no quoting of it can go wrong on the way.
    expect(outer).toContain(`'-EncodedCommand','${encoded(elevatedScript(8790, { publicToo: true }))}'`);
  });

  it('touches nothing when the port is already let through', async () => {
    const ps = shell(answer(2, [allow(3)]));
    expect(await allowThroughFirewall(8790, { platform: 'win32', run: ps.run })).toEqual({ state: 'allowed', public: false });
    expect(ps.calls).toHaveLength(1);
  });

  it('answers blocked when the user refused Windows\' question', async () => {
    const ps = shell(answer(2), { error: new Error('The operation was canceled by the user.') }, answer(2));
    expect(await allowThroughFirewall(8790, { platform: 'win32', run: ps.run })).toEqual({ state: 'blocked', public: false });
  });
});

// Security review (REVIEW-lan-security.md): pins a defect and FAILS until it is fixed.
describe('security review: the rule the elevated script adds (fails until fixed)', () => {
  it('F6: lets the port through for this program alone, not for whatever listens on it', () => {
    const script = elevatedScript(8790, { publicToo: false });
    for (const line of script.split('\n').filter((l) => l.startsWith('New-NetFirewallRule'))) expect(line).toMatch(/-Program '/);
  });
});
