import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entry } from '../lib/projection/types';
import type { RunState } from '../lib/session/types';
import type { LanguagePair } from '../lib/provider/types';
import type { VrState, VrWords } from '../vr/types';
import { useVrStore } from '../stores/vrStore';
import { quickLanguages, startVrOverlay, vrLines, type VrOverlayDeps, type VrSettingsPort } from './vrOverlay';

vi.mock('../services/persistSetting', () => ({ persistSetting: async () => {} }));

const row = (text: string, final = true) => ({ key: `${text}:0`, segmentId: text, side: 'source' as const, start: 0, end: text.length, text, final });
const exchange = (id: string, source: string, translation: string, { leg = 'participant', final = true } = {}): Entry => ({
  kind: 'exchange', id, leg: leg as 'speaker' | 'participant', languages: { source: 'ja', target: 'zh' }, pairing: 'stated',
  source: source ? [row(source, final)] : [], translation: translation ? [{ ...row(translation, final), side: 'translation' }] : [], t: 0,
});
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('vrLines', () => {
  it('keeps the last six exchanges with words, oldest first, and leaves notices and a video out', () => {
    const entries: Entry[] = [
      ...Array.from({ length: 8 }, (_, i) => exchange(`e${i}`, `s${i}`, `t${i}`)),
      { ...exchange('v', 'video', 'words'), lane: 'video' },
      exchange('empty', '', ''),
    ];
    const lines = vrLines(entries);
    expect(lines.map((l) => l.id)).toEqual(['e2', 'e3', 'e4', 'e5', 'e6', 'e7']);
    expect(lines[5]).toEqual({ id: 'e7', leg: 'participant', source: 's7', translation: 't7', final: true });
  });

  it('says a line still being written is not final', () => {
    expect(vrLines([exchange('a', 'こん', '', { final: false })])[0].final).toBe(false);
  });
});

describe('quickLanguages', () => {
  it('takes the pinned languages the provider offers, the current one among them', () => {
    expect(quickLanguages('ko', ['ja', 'en', 'ko', 'fr'], ['fr', 'ja', 'de', 'en'])).toEqual(['fr', 'ja', 'ko']);
  });
  it('fills in common languages when fewer than two are pinned', () => {
    expect(quickLanguages('ja', ['ja', 'en', 'ko', 'zh'], [])).toEqual(['ja', 'en', 'ko']);
    expect(quickLanguages('fr', ['ja', 'en', 'ko', 'fr'], [])).toEqual(['ja', 'en', 'fr']);
  });
});

function setup(over: Partial<VrOverlayDeps> = {}) {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const sent: VrState[] = [];
  const invoked: Array<[string, unknown]> = [];
  const ipc = {
    invoke: async (channel: string, data?: unknown) => {
      invoked.push([channel, data]);
      if (channel === 'vr:state') sent.push(data as VrState);
      return channel === 'vr:set' ? { vr: (data as { on: boolean }).on ? 'waiting' : 'off' } : undefined;
    },
    receive: (channel: string, fn: (...args: unknown[]) => void) => { handlers.set(channel, fn); },
  };
  let run: RunState = { phase: 'idle' };
  const runListeners = new Set<() => void>();
  const setRun = (next: RunState) => { run = next; for (const l of runListeners) l(); };
  const order: string[] = [];
  const runner = {
    state: { getState: () => run, subscribe: (l: () => void) => { runListeners.add(l); return () => runListeners.delete(l); } },
    stop: vi.fn(async () => { order.push('stop'); setRun({ phase: 'idle', lastEnd: { reason: 'user' } }); }),
  };
  const start = vi.fn(async () => { order.push('start'); setRun({ phase: 'running', since: 0, legs: {} }); });
  let entries: Entry[] = [];
  const viewListeners = new Set<() => void>();
  let pair: LanguagePair = { source: 'zh-CN', target: 'ja' };
  let hearer = 'qwen';
  const settingListeners = new Set<() => void>();
  const changed = () => { for (const l of settingListeners) l(); };
  const settings: VrSettingsPort = {
    pair: () => pair,
    setPair: (p) => { order.push(`pair ${p.source}>${p.target}`); pair = p; changed(); },
    theirOptions: () => ['ja', 'en', 'ko'],
    myOptions: () => ['zh-CN', 'ja', 'en'],
    pins: () => [],
    hearers: () => ({ value: hearer, options: [{ id: 'qwen', label: 'Qwen3-ASR' }, { id: 'sense', label: 'SenseVoice' }] }),
    setHearer: (id) => { order.push(`hear ${id}`); hearer = id; changed(); },
    translators: () => null,
    setTranslator: () => {},
    flush: async () => { order.push('flush'); },
    subscribe: (l) => { settingListeners.add(l); return () => settingListeners.delete(l); },
  };
  let clock = 1000;
  const ticks: Array<() => void> = [];
  const heard = { speaker: false, participant: false };
  const deps: VrOverlayDeps = {
    ipc,
    runner,
    start,
    view: { get: () => ({ entries }), subscribe: (l) => { viewListeners.add(l); return () => viewListeners.delete(l); } },
    levels: async () => ({
      speaker: { push() {}, heard: () => heard.speaker, reset() {} },
      participant: { push() {}, heard: () => heard.participant, reset() {} },
    }),
    legs: () => ['speaker', 'participant'],
    settings,
    muted: () => false,
    subscribeMuted: () => () => {},
    words: () => ({ me: 'Me' } as VrWords),
    uiLanguage: () => 'en',
    now: () => clock,
    setInterval: (fn) => { ticks.push(fn); return ticks.length; },
    clearInterval: () => { ticks.length = 0; },
    ...over,
  };
  const controller = startVrOverlay(deps);
  return {
    controller, handlers, sent, invoked, order, runner, start, setRun, heard, ticks,
    setEntries: (next: Entry[]) => { entries = next; for (const l of viewListeners) l(); },
    advance: (ms: number) => { clock += ms; },
    // After the answer to the first `vr:set`, as the main process sends them.
    connect: async () => { await flush(); handlers.get('vr:status')!({ vr: 'connected' }); },
    command: (c: unknown) => handlers.get('vr:command')!(c),
  };
}

describe('startVrOverlay', () => {
  beforeEach(() => {
    useVrStore.setState({ on: false, hand: 'left', link: 'off', wristShown: false });
  });

  it('asks for the helper as the setting says, and tells it the wrist', async () => {
    const t = setup();
    await flush();
    expect(t.invoked).toContainEqual(['vr:set', { on: false }]);
    expect(t.invoked).toContainEqual(['vr:tune', { lines: ['wrist.hand left'] }]);
    useVrStore.getState().setOn(true);
    useVrStore.getState().setHand('right');
    await flush();
    expect(t.invoked).toContainEqual(['vr:set', { on: true }]);
    expect(t.invoked).toContainEqual(['vr:tune', { lines: ['wrist.hand right'] }]);
    t.controller.stop();
  });

  it('sends the state only while SteamVR shows it, and only when it changed', async () => {
    const t = setup();
    t.setEntries([exchange('a', 'こんばんは', '晚上好')]);
    await flush();
    expect(t.sent).toHaveLength(0);
    await t.connect();
    await flush();
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0].lines.map((l) => l.translation)).toEqual(['晚上好']);
    expect(t.sent[0].theirs).toEqual({ value: 'ja', options: expect.arrayContaining([{ value: 'en', label: 'English' }]), quick: ['ja', 'en', 'ko'] });
    t.setEntries([exchange('a', 'こんばんは', '晚上好')]);
    await flush();
    expect(t.sent).toHaveLength(1);
    t.controller.stop();
  });

  it('changes the language at once while idle', async () => {
    const t = setup();
    await t.connect();
    t.command({ type: 'theirs', value: 'en' });
    await flush();
    expect(t.order).toEqual(['pair zh-CN>en']);
    expect(t.sent.at(-1)!.theirs.value).toBe('en');
    t.controller.stop();
  });

  it('stops a running run, takes the change, and starts it again, the strip saying so meanwhile', async () => {
    const t = setup();
    t.setRun({ phase: 'running', since: 0, legs: {} });
    await t.connect();
    t.command({ type: 'hear', id: 'sense' });
    await flush();
    await flush();
    expect(t.order).toEqual(['stop', 'hear sense', 'flush', 'start']);
    expect(t.sent.some((s) => s.switching?.label === 'SenseVoice')).toBe(true);
    expect(t.sent.at(-1)!.switching).toBeNull();
    expect(t.sent.at(-1)!.hear.value).toBe('sense');
    t.controller.stop();
  });

  it('does not start the run again when the user stopped it while a change restarted it', async () => {
    let release = () => {};
    const t = setup();
    t.runner.stop.mockImplementationOnce(() => new Promise<void>((resolve) => { release = () => { t.order.push('stop'); t.setRun({ phase: 'idle', lastEnd: { reason: 'user' } }); resolve(); }; }));
    t.setRun({ phase: 'running', since: 0, legs: {} });
    await t.connect();
    t.command({ type: 'hear', id: 'sense' });
    t.command({ type: 'run', on: false });
    release();
    await flush();
    await flush();
    expect(t.start).not.toHaveBeenCalled();
    expect(t.sent.at(-1)!.switching).toBeNull();
    t.controller.stop();
  });

  it('swaps the pair when the user picks the other side’s language as their own', async () => {
    const t = setup();
    await t.connect();
    t.command({ type: 'mine', value: 'ja' });
    await flush();
    expect(t.order).toEqual(['pair ja>zh-CN']);
    t.controller.stop();
  });

  it('measures a recognizer from the end of the other side’s sound to their sentence’s last word', async () => {
    const t = setup();
    await t.connect();
    t.setRun({ phase: 'running', since: 0, legs: {} });
    await flush();
    expect(t.ticks).toHaveLength(1);
    t.heard.participant = true;
    t.ticks[0]();
    t.heard.participant = false;
    t.ticks[0]();
    t.advance(900);
    t.setEntries([exchange('a', 'こんばんは', '')]);
    t.advance(300);
    t.setEntries([exchange('a', 'こんばんは', '晚上好')]);
    await flush();
    const hear = t.sent.at(-1)!.hear.options.find((m) => m.id === 'qwen');
    expect(hear?.ms).toBe(900);
    t.controller.stop();
  });
});
