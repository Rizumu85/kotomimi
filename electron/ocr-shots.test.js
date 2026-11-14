// @vitest-environment node
// electron/ocr-shots.test.js
//
// Fork: the collector of VRChat pictures, over a stand-in helper, folder and clock.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createOcrShots, setupOcrShots, shotName } = require('./ocr-shots.js');

const DIR = path.resolve('shots');

function rig({ existing = {}, limitBytes } = {}) {
  const sizes = new Map(Object.entries(existing).map(([name, size]) => [path.join(DIR, name), size]));
  const files = {
    made: [],
    mkdirSync: (dir) => files.made.push(dir),
    readdirSync: () => [...sizes.keys()].map((file) => path.basename(file)),
    statSync: (file) => {
      if (!sizes.has(file)) throw new Error('ENOENT');
      return { size: sizes.get(file) };
    },
  };
  let tick = null;
  const clock = { at: new Date(2026, 10, 13, 20, 15, 32).getTime(), setInterval: (fn) => { tick = fn; return 1; }, clearInterval: () => { tick = null; }, now: () => clock.at };
  const calls = [];
  /** What the helper answers next: its stdout line, or an error; `size` is what it wrote. */
  const answers = [];
  const run = (helper, args, options, done) => {
    calls.push({ helper, args, options });
    const answer = answers.shift() ?? { said: { state: 'none' } };
    if (answer.size) sizes.set(args[0], answer.size);
    if (answer.hold) { answer.hold.done = () => done(null, `${JSON.stringify(answer.said)}\n`); return; }
    done(answer.error ?? null, answer.error ? '' : `${JSON.stringify(answer.said)}\n`);
  };
  const shots = createOcrShots({ dir: DIR, helper: 'shot.exe', run, files, clock, ...(limitBytes ? { limitBytes } : {}) });
  return { shots, files, clock, calls, answers, pass: () => tick?.(), running: () => tick !== null };
}

describe('the collector of VRChat pictures', () => {
  it('names a picture by its local time', () => {
    expect(shotName(new Date(2026, 10, 3, 9, 5, 7).getTime())).toBe('20261103-090507.jpg');
  });

  it('takes a picture each time its interval passes, only while a session runs', () => {
    const r = rig();
    r.pass();
    expect(r.calls).toEqual([]);
    r.shots.start();
    expect(r.files.made).toEqual([DIR]);
    r.pass();
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatchObject({ helper: 'shot.exe', args: [path.join(DIR, '20261113-201532.jpg')], options: { windowsHide: true } });
    r.shots.stop();
    expect(r.running()).toBe(false);
  });

  it('hands the helper the last picture’s signature, so a view that has not changed is not written twice', () => {
    const r = rig();
    r.shots.start();
    r.answers.push({ said: { state: 'saved', width: 1920, height: 1080, signature: 'ab12' }, size: 300_000 }, { said: { state: 'same', signature: 'ab13' } });
    r.pass();
    r.pass();
    r.pass();
    expect(r.calls[1].args.slice(1)).toEqual(['--last', 'ab12']);
    expect(r.calls[2].args.slice(1)).toEqual(['--last', 'ab13']);
  });

  it('does not start a second helper while one is at work', () => {
    const r = rig();
    const hold = {};
    r.shots.start();
    r.answers.push({ said: { state: 'none' }, hold });
    r.pass();
    r.pass();
    expect(r.calls).toHaveLength(1);
    hold.done();
    r.pass();
    expect(r.calls).toHaveLength(2);
  });

  it('stops taking pictures when the folder is full, counting what was there before', () => {
    const r = rig({ existing: { 'old.jpg': 700 }, limitBytes: 1000 });
    r.shots.start();
    r.answers.push({ said: { state: 'saved', signature: 'aa' }, size: 400 });
    r.pass();
    r.pass();
    expect(r.calls).toHaveLength(1);
  });

  it('goes on after a helper that failed or said nothing it understands', () => {
    const r = rig();
    r.shots.start();
    r.answers.push({ error: new Error('spawn ENOENT') });
    r.pass();
    r.pass();
    expect(r.calls).toHaveLength(2);
    expect(r.calls[1].args).toHaveLength(1);
  });

  it('is not made at all unless the environment names a folder, on Windows', () => {
    const app = { isPackaged: false, getAppPath: () => path.resolve('.') };
    expect(setupOcrShots({ app, env: {}, platform: 'win32' })).toBeNull();
    expect(setupOcrShots({ app, env: { KOTOMIMI_OCR_SHOTS: 'relative' }, platform: 'win32' })).toBeNull();
    expect(setupOcrShots({ app, env: { KOTOMIMI_OCR_SHOTS: DIR }, platform: 'darwin' })).toBeNull();
    expect(setupOcrShots({ app, env: { KOTOMIMI_OCR_SHOTS: DIR }, platform: 'win32' })).not.toBeNull();
  });
});
