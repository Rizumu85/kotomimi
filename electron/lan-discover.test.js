// @vitest-environment node
// electron/lan-discover.test.js
//
// Fork: finding the servers of the local network. The network searched here
// is the loopback: real servers on free ports, asked as any address is.
import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { discoverServers, targets, neighbours, readAnswer, probe, productOf, nameOf, shown, NAME_HEADER, INCLUDES_HEADER } = require('./lan-discover.js');

let running = [];
afterEach(async () => {
  await Promise.all(running.map((server) => new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()); })));
  running = [];
});

/** A server on a free loopback port that answers every request the same way — or, given `paths`, some paths their own way and the rest 404. */
function serve(status, body, headers = {}, paths = null) {
  return new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      const own = paths ? paths[request.url] : body;
      response.writeHead(paths && own === undefined ? 404 : status, { 'Content-Type': 'application/json', ...headers });
      response.end(typeof own === 'string' ? own : JSON.stringify(own ?? {}));
    });
    running.push(server);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

const kotomimiList = { object: 'list', data: [{ id: 'kotomimi', object: 'model', owned_by: 'kotomimi' }, { id: 'whisper-tiny', object: 'model', owned_by: 'kotomimi' }, { id: 'bing-translator', object: 'model', owned_by: 'kotomimi' }] };
const localaiList = { object: 'list', data: [{ id: 'gpt-realtime', object: 'model' }, { id: 'hy-mt2-1.8b', object: 'model' }] };
const wifi = (address, netmask = '255.255.255.0') => ({ family: 'IPv4', internal: false, address, netmask });

describe('the addresses that are asked', () => {
  it('are a home network\'s own, without the network\'s and the broadcast address', () => {
    const hosts = neighbours('192.168.4.29', '255.255.255.0');
    expect(hosts).toHaveLength(254);
    expect(hosts[0]).toBe('192.168.4.1');
    expect(hosts[253]).toBe('192.168.4.254');
  });

  it('are only the 256 around this computer on a wider network, and all of a smaller one', () => {
    const wide = neighbours('10.3.7.20', '255.0.0.0');
    expect(wide).toHaveLength(254);
    expect(wide[0]).toBe('10.3.7.1');
    expect(neighbours('192.168.1.130', '255.255.255.192')).toEqual(Array.from({ length: 62 }, (_, i) => `192.168.1.${129 + i}`));
  });

  it('leave out a VPN\'s network, the loopback and IPv6, and ask this computer itself as the loopback', () => {
    const list = targets({
      Tailscale: [wifi('100.95.1.2', '255.255.255.255')],
      Loopback: [{ family: 'IPv4', internal: true, address: '127.0.0.1', netmask: '255.0.0.0' }],
      'Wi-Fi': [{ family: 'IPv6', internal: false, address: 'fe80::1' }, wifi('192.168.4.29')],
    }, { ports: [8790, 8080], ownPorts: [8790] });
    expect(list.some((t) => t.host.startsWith('100.'))).toBe(false);
    // 253 neighbours on each port; this computer on the one port it does not serve itself.
    expect(list.filter((t) => t.port === 8790)).toHaveLength(253);
    expect(list.filter((t) => t.self)).toEqual([{ host: '127.0.0.1', port: 8080, self: true }]);
    expect(list.some((t) => t.host === '192.168.4.29')).toBe(false);
  });
});

describe('what an answer says of a server', () => {
  it('knows a Kotomimi by the owner of its models, its name by the header, and counts what it shares', () => {
    expect(readAnswer(200, { [NAME_HEADER]: encodeURIComponent('里兹的电脑') }, JSON.stringify(kotomimiList))).toEqual({ kind: 'kotomimi', name: '里兹的电脑', models: 2, needsKey: false, includes: false });
    // One that shares its computer's model server too says so.
    expect(readAnswer(200, { [NAME_HEADER]: 'MAC', [INCLUDES_HEADER]: 'model-server' }, JSON.stringify(kotomimiList)).includes).toBe(true);
  });

  it('takes any other model list for a server', () => {
    expect(readAnswer(200, {}, JSON.stringify(localaiList))).toEqual({ kind: 'server', name: '', models: 2, needsKey: false, includes: false });
  });

  it('lists a server that asks for a key as wanting one', () => {
    expect(readAnswer(401, { [NAME_HEADER]: 'DESK' }, '{"error":{}}')).toEqual({ kind: 'kotomimi', name: 'DESK', models: 0, needsKey: true, includes: false });
    expect(readAnswer(403, {}, '')).toEqual({ kind: 'server', name: '', models: 0, needsKey: true, includes: false });
  });

  it('knows a phone that lends its recognition engine, by what it says of itself, and the model it lends', () => {
    const list = JSON.stringify({ object: 'list', data: [{ id: 'qwen3-asr-0.6b-q8', object: 'model', owned_by: 'kotomimi-phone' }] });
    expect(readAnswer(200, { [NAME_HEADER]: encodeURIComponent('朋友的手机'), 'x-kotomimi-node': 'engine' }, list)).toEqual({ kind: 'phone', name: '朋友的手机', models: 1, needsKey: false, includes: false, model: 'qwen3-asr-0.6b-q8' });
    // A phone that lends nothing is nothing to choose.
    expect(readAnswer(200, { 'x-kotomimi-node': 'engine' }, '{"object":"list","data":[]}')).toBeNull();
    // The same list from anything that does not say it is a phone is a model server.
    expect(readAnswer(200, {}, list)).toMatchObject({ kind: 'server', models: 1 });
  });

  it('is nothing for a router\'s page, a 404, or JSON that is no list', () => {
    expect(readAnswer(200, {}, '<html>router</html>')).toBeNull();
    expect(readAnswer(404, {}, '{}')).toBeNull();
    expect(readAnswer(200, {}, '{"data":"no"}')).toBeNull();
    expect(readAnswer(200, { [NAME_HEADER]: '%E0%A4%A' }, JSON.stringify(localaiList))).toMatchObject({ name: '' });
  });
});

describe('asking an address', () => {
  it('finds a server that answers, and nothing where none listens', async () => {
    const port = await serve(200, kotomimiList, { 'X-Kotomimi-Name': 'DESK' });
    expect(await probe({ host: '127.0.0.1', port, self: true })).toEqual({ address: `127.0.0.1:${port}`, host: '127.0.0.1', port, self: true, kind: 'kotomimi', name: 'DESK', models: 2, needsKey: false, includes: false });
    const closed = await serve(200, {});
    await new Promise((done) => running.pop().close(done));
    expect(await probe({ host: '127.0.0.1', port: closed, self: true })).toBeNull();
  });

  it('gives up on one that never answers', async () => {
    const silent = http.createServer(() => {});
    running.push(silent);
    const port = await new Promise((resolve) => silent.listen(0, '127.0.0.1', () => resolve(silent.address().port)));
    const started = Date.now();
    expect(await probe({ host: '127.0.0.1', port, self: true }, 120)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe('a computer\'s name', () => {
  it('is the network\'s for it, without the home suffix, and blank when it has none or is slow to say', async () => {
    expect(await nameOf('192.168.1.5', async () => ['rizum-mac.local'])).toBe('rizum-mac');
    expect(await nameOf('192.168.1.5', async () => { throw new Error('ENOTFOUND'); })).toBe('');
    expect(await nameOf('192.168.1.5', () => new Promise(() => {}), 30)).toBe('');
  });
});

describe('the search', () => {
  it('lists a server beside the app on this computer, says when it is a LocalAI, and never a Kotomimi of this computer', async () => {
    const localai = await serve(200, null, {}, { '/v1/models': localaiList, '/version': { version: 'v3.9.0 (abc)' } });
    const other = await serve(200, null, {}, { '/v1/models': localaiList });
    const kotomimi = await serve(200, kotomimiList, { 'X-Kotomimi-Name': 'DESK' });
    const own = await serve(200, kotomimiList, { 'X-Kotomimi-Name': 'ME' });
    const found = await discoverServers({ interfaces: {}, ports: [localai, other, kotomimi, own], ownPorts: [own], timeoutMs: 400 });
    expect(found).toEqual([localai, other].sort((a, b) => a - b).map((port) => (
      { address: `127.0.0.1:${port}`, kind: 'server', name: '', product: port === localai ? 'LocalAI' : '', models: 2, needsKey: false, self: true }
    )));
  });

  it('tells a LocalAI by its version, and takes nothing else for one', async () => {
    const localai = await serve(200, null, {}, { '/version': { version: ' ()' } });
    const other = await serve(200, null, {}, { '/version': { name: 'x' } });
    expect(await productOf({ host: '127.0.0.1', port: localai }, 400)).toBe('LocalAI');
    expect(await productOf({ host: '127.0.0.1', port: other }, 400)).toBe('');
    expect(await productOf({ host: '127.0.0.1', port: await serve(200, null, {}, {}) }, 400)).toBe('');
  });

  it('finds nothing on a computer with no network and no server', async () => {
    const closed = await serve(200, {});
    await new Promise((done) => running.pop().close(done));
    expect(await discoverServers({ interfaces: {}, ports: [closed], timeoutMs: 200 })).toEqual([]);
  });
});

describe('what is listed', () => {
  const at = (host, port, kind, more = {}) => ({ address: `${host}:${port}`, host, port, self: false, kind, name: '', models: 3, needsKey: false, includes: false, ...more });

  it('is one row for a computer whose Kotomimi shares its model server too', () => {
    const mac = at('192.168.4.105', 8790, 'kotomimi', { includes: true });
    const itsLocalAI = at('192.168.4.105', 8080, 'server');
    const another = at('192.168.4.50', 8080, 'server');
    expect(shown([itsLocalAI, mac, another])).toEqual([mac, another]);
  });

  it('keeps a model server listed beside a Kotomimi that does not share it', () => {
    const pc = at('192.168.4.20', 8790, 'kotomimi');
    const itsLocalAI = at('192.168.4.20', 8080, 'server');
    expect(shown([pc, itsLocalAI])).toEqual([pc, itsLocalAI]);
  });

  it('keeps this computer\'s own model server: it is how this computer uses it', () => {
    const second = at('127.0.0.1', 8791, 'kotomimi', { self: true, includes: true });
    const mine = at('127.0.0.1', 8080, 'server', { self: true });
    expect(shown([second, mine])).toEqual([mine]);
  });
});
