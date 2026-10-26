// electron/vrchat.js
/**
 * Fork: VRChat on the same computer — what the app learns of it, and what it
 * tells it. All of it through what VRChat itself offers on this machine, with
 * no socket of the app's own listening:
 *
 * - **Its log** (`AppData\LocalLow\VRChat\VRChat\output_log_*.txt`, the newest
 *   while it runs) says where its OSCQuery service answers ("Advertising
 *   Service VRChat-Client-015F92 of type OSCQuery on 13945") and the port it
 *   takes OSC on ("… of type OSC on 9000"), when a world's video player
 *   begins a video ("[Video Playback] Attempting to resolve URL '…'"), and
 *   when the player enters another world ("[Behaviour] Entering Room: …").
 *   Nothing in it says who is speaking: VRChat tells no other program that
 *   (researched 2026-10-26).
 * - **Its OSCQuery service** (HTTP on 127.0.0.1) answers what an avatar
 *   parameter is now: `/avatar/parameters/MuteSelf` is whether the player is
 *   muted in VRChat. Asked a few times a second while the app wants to know.
 * - **OSC** (UDP to 127.0.0.1 on that port): `/chatbox/input` puts a line
 *   above the player's avatar, which the others in the world read.
 *
 * VRChat runs on Windows only; elsewhere none of this starts.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const dgram = require('dgram');

const LOG_DIR = path.join(os.homedir(), 'AppData', 'LocalLow', 'VRChat', 'VRChat');
/** How often the log is looked at. */
const TAIL_EVERY_MS = 1000;
/** How often the mute is asked, while it is wanted. */
const MUTE_EVERY_MS = 250;
/** The start of a log, where VRChat writes its ports: read when the file is first seen, the rest only from then on. */
const HEAD_BYTES = 512 * 1024;
/** VRChat's chatbox shows at most this many characters. */
const CHATBOX_MOST = 144;

const OSCQUERY_LINE = /Advertising Service VRChat-Client-\w+ of type OSCQuery on (\d+)/;
const OSC_LINE = /Advertising Service VRChat-Client-\w+ of type OSC on (\d+)/;
const VIDEO_LINE = /\[Video Playback\] Attempting to resolve URL '([^']*)'/;
const WORLD_LINE = /\[Behaviour\] (?:Entering Room|Joining or Creating Room|OnLeftRoom)/;

/** What one line of the log says, of what is followed here; null for every other line. */
function readLine(line) {
  let m = OSCQUERY_LINE.exec(line);
  if (m) return { kind: 'oscquery', port: Number(m[1]) };
  m = OSC_LINE.exec(line);
  if (m) return { kind: 'osc', port: Number(m[1]) };
  m = VIDEO_LINE.exec(line);
  if (m) return { kind: 'video', url: m[1] };
  if (WORLD_LINE.test(line)) return { kind: 'world' };
  return null;
}

/** OSC's strings: the bytes, a zero, padded to four. */
function oscString(text) {
  const bytes = Buffer.from(text, 'utf8');
  const out = Buffer.alloc(Math.ceil((bytes.length + 1) / 4) * 4);
  bytes.copy(out);
  return out;
}

/** `/chatbox/input` with the text, shown at once (`T`), without the chatbox's sound (`F`). */
function chatboxMessage(text) {
  return Buffer.concat([oscString('/chatbox/input'), oscString(',sTF'), oscString(text)]);
}

/** A line the chatbox takes: on one line, and within its length, cut at the last whole character. */
function forChatbox(text) {
  const chars = [...String(text).replace(/\s+/g, ' ').trim()];
  return chars.length <= CHATBOX_MOST ? chars.join('') : `${chars.slice(0, CHATBOX_MOST - 1).join('')}…`;
}

/** The newest log in the folder, or null. */
function newestLog(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }
  let best = null;
  for (const name of names) {
    if (!/^output_log_.*\.txt$/.test(name)) continue;
    const file = path.join(dir, name);
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    if (!best || stat.mtimeMs > best.mtimeMs) best = { file, mtimeMs: stat.mtimeMs, size: stat.size };
  }
  return best;
}

/** One answer of VRChat's OSCQuery service, as JSON; null on any failure — of the request or of the answer midway. */
function getJson(port, pathname, timeoutMs = 800) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    const req = http.get({ host: '127.0.0.1', port, path: pathname, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('error', () => done(null));
      res.on('aborted', () => done(null));
      res.on('end', () => {
        if (res.statusCode !== 200) return done(null);
        try { done(JSON.parse(body)); } catch { done(null); }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => done(null));
    req.on('close', () => done(null));
  });
}

/**
 * The app's side of VRChat. `push(channel, payload)` tells the window: `vrchat:state` (`{ found, connected, muted }`),
 * `vrchat:video` (`{ url }`) and `vrchat:world` (`{}`). `watch(true)` asks the mute a few times a second until
 * `watch(false)`; `chatbox(text)` sends a line above the avatar.
 */
function createVRChat({ push, dir = LOG_DIR, tailEveryMs = TAIL_EVERY_MS, muteEveryMs = MUTE_EVERY_MS, ask = getJson, udp = () => dgram.createSocket('udp4') }) {
  let file = null;
  let offset = 0;
  let rest = '';
  let oscQueryPort = null;
  let oscPort = 9000;
  let state = { found: false, connected: false, muted: null };
  let watching = false;
  let muteTimer = null;
  /** Bumped by every watch and every new log: a loop, or an answer, of an older one ends there. */
  let generation = 0;
  let socket = null;

  const setState = (next) => {
    const merged = { ...state, ...next };
    if (merged.found === state.found && merged.connected === state.connected && merged.muted === state.muted) return;
    state = merged;
    push('vrchat:state', state);
  };

  const take = (text, history) => {
    const lines = (rest + text).split(/\r?\n/);
    rest = lines.pop() ?? '';
    for (const line of lines) {
      const said = readLine(line);
      if (!said) continue;
      if (said.kind === 'oscquery') { oscQueryPort = said.port; setState({ found: true }); }
      else if (said.kind === 'osc') oscPort = said.port;
      // What happened before the app looked is not news.
      else if (!history && said.kind === 'video') push('vrchat:video', { url: said.url });
      else if (!history && said.kind === 'world') push('vrchat:world', {});
    }
  };

  const tail = () => {
    const newest = newestLog(dir);
    if (!newest) return;
    if (!file || newest.file !== file) {
      // A new log: VRChat started again. Its ports are near its start; the rest is history.
      file = newest.file;
      rest = '';
      oscQueryPort = null;
      oscPort = 9000;
      // An answer to the old VRChat's service is not this one's.
      generation += 1;
      setState({ found: false, connected: false, muted: null });
      try {
        const fd = fs.openSync(file, 'r');
        try {
          const head = Buffer.alloc(Math.min(HEAD_BYTES, newest.size));
          fs.readSync(fd, head, 0, head.length, 0);
          take(head.toString('utf8'), true);
          rest = '';
          // Lines after the head are history as well, but only the ports matter of them: the head holds those. The
          // line being written at the end is not history yet: read from its start, it is read whole once it is.
          const tailLength = Math.min(64 * 1024, newest.size);
          const tailBytes = Buffer.alloc(tailLength);
          fs.readSync(fd, tailBytes, 0, tailLength, newest.size - tailLength);
          const lastBreak = tailBytes.lastIndexOf(0x0a);
          offset = lastBreak < 0 ? newest.size : newest.size - tailLength + lastBreak + 1;
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        return;
      }
      if (watching) void loop(generation);
      return;
    }
    if (newest.size < offset) offset = 0;
    if (newest.size === offset) return;
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const chunk = Buffer.alloc(newest.size - offset);
        fs.readSync(fd, chunk, 0, chunk.length, offset);
        offset = newest.size;
        take(chunk.toString('utf8'), false);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      /* Being written: read again next time. */
    }
  };

  const askMute = async (mine) => {
    if (!oscQueryPort) { setState({ connected: false, muted: null }); return; }
    const node = await ask(oscQueryPort, '/avatar/parameters/MuteSelf');
    if (mine !== generation) return;
    const value = Array.isArray(node?.VALUE) ? node.VALUE[0] : undefined;
    if (typeof value === 'boolean') setState({ connected: true, muted: value });
    else setState({ connected: false, muted: null });
  };

  const loop = async (mine) => {
    if (!watching || mine !== generation) return;
    await askMute(mine);
    if (watching && mine === generation) muteTimer = setTimeout(() => loop(mine), muteEveryMs);
  };

  tail();
  const tailTimer = setInterval(tail, tailEveryMs);
  tailTimer.unref?.();

  return {
    get state() { return state; },
    watch(on) {
      if (on === watching) return;
      watching = on;
      generation += 1;
      clearTimeout(muteTimer);
      if (on) void loop(generation);
    },
    chatbox(text) {
      const line = forChatbox(text);
      if (!line) return;
      socket ??= udp();
      socket.send(chatboxMessage(line), oscPort, '127.0.0.1', () => {});
    },
    stop() {
      watching = false;
      generation += 1;
      clearTimeout(muteTimer);
      clearInterval(tailTimer);
      try { socket?.close(); } catch { /* closed */ }
      socket = null;
    },
  };
}

/** The handlers, registered once (main.js): the window it tells is whichever is the main one when there is news. */
function setupVRChat({ ipcMain, isTrustedSender, getMainWindow, platform = process.platform, dir }) {
  if (platform !== 'win32') {
    ipcMain.handle('vrchat:watch', () => ({ found: false, connected: false, muted: null }));
    ipcMain.handle('vrchat:chatbox', () => undefined);
    return { stop() {} };
  }
  const vrchat = createVRChat({
    ...(dir ? { dir } : {}),
    push: (channel, payload) => {
      const win = getMainWindow();
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
    },
  });
  ipcMain.handle('vrchat:watch', (event, payload) => {
    if (!isTrustedSender(event.sender)) return undefined;
    vrchat.watch(Boolean(payload && payload.on));
    return vrchat.state;
  });
  ipcMain.handle('vrchat:chatbox', (event, payload) => {
    if (!isTrustedSender(event.sender)) return;
    if (payload && typeof payload.text === 'string') vrchat.chatbox(payload.text);
  });
  return vrchat;
}

module.exports = { setupVRChat, createVRChat, readLine, chatboxMessage, forChatbox, CHATBOX_MOST };
