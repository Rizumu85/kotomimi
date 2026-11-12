import { describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { NO_NATIVE_ENGINE } from '../lib/native/nativeEngine';
import { LOCALAI_DEFAULTS } from '../providers/openai/localai';
import { nativePlans } from '../providers/openai/nativePlans';
import type { NativeEngineStoreState } from './nativeEngineStore';
import { createNativePlanStore, type NativePlanContext } from './nativePlanStore';

function engine(downloaded: string[] = []) {
  const store = create<NativeEngineStoreState>()(subscribeWithSelector<NativeEngineStoreState>(() => ({
    status: { ...NO_NATIVE_ENGINE, supported: true, engine: 'ready', models: Object.fromEntries(downloaded.map((id) => [id, { state: 'downloaded', received: 100, total: 100 }])) },
    asked: true, download: vi.fn(async () => {}), cancel: vi.fn(async () => {}), remove: vi.fn(async () => {}),
    stop: vi.fn(async () => {}), start: vi.fn(async () => NO_NATIVE_ENGINE), refresh: vi.fn(async () => NO_NATIVE_ENGINE), hydrate: vi.fn(async () => {}),
  })));
  const progress = (id: string, state: 'downloaded' | 'downloading' | 'failed', received = 50) => store.setState((s) => ({ status: { ...s.status, models: { ...s.status.models, [id]: { state, received, total: 100 } } } }));
  return { store, progress };
}
function setup(downloaded: string[] = []) {
  const recognition = engine(downloaded);
  const translation = engine(downloaded);
  let ctx: NativePlanContext = { settings: { ...LOCALAI_DEFAULTS, asrVia: 'device', translateAt: 'device', asrNativeByLanguage: {} }, pair: { source: 'zh', target: 'ja' } };
  const listeners = new Set<() => void>();
  const edit = (patch: Partial<typeof ctx.settings>) => { ctx = { ...ctx, settings: { ...ctx.settings, ...patch } }; for (const fn of listeners) fn(); };
  const store = createNativePlanStore({ read: () => ctx, write: edit, subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, recognition: recognition.store, translation: translation.store });
  const plan = (id: 'light' | 'balanced' | 'accurate') => nativePlans({ settings: ctx.settings, pair: ctx.pair, memoryMB: 8192, lending: false, downloaded, platform: 'win32' }).plans.find((p) => p.id === id)!;
  return { recognition, translation, store, edit, plan, read: () => ctx.settings, listeners };
}
const x = 'x-asr-zh-en';
const small = 'qwen3-asr-0.6b-q8';
const big = 'qwen3-asr-1.7b-q8';
const index = 'index-translate-2b';

describe('pending native plan application', () => {
  it('applies downloaded stages immediately and releases subscriptions when done', () => {
    const t = setup([x, small, index]);
    t.store.getState().apply(t.plan('balanced'));
    expect(t.read().asrNativeByLanguage).toEqual({ zh: x, ja: small });
    expect(t.read().translateNativeModel).toBe(index);
    expect(t.store.getState().pending).toBeNull();
    expect(t.listeners.size).toBe(0);
  });
  it('waits for actual downloaded status, exposes progress, and switches stages independently', async () => {
    const t = setup([x]);
    const before = t.read().translateNativeModel;
    t.store.getState().apply(t.plan('balanced'));
    await Promise.resolve();
    expect(t.recognition.store.getState().download).toHaveBeenCalledWith(small);
    expect(t.translation.store.getState().download).toHaveBeenCalledWith(index);
    expect(t.read().asrNativeByLanguage.zh).toBe(x);
    expect(t.read().asrNativeByLanguage.ja).toBe(big);
    expect(t.read().translateNativeModel).toBe(before);
    t.recognition.progress(small, 'downloading', 37);
    expect(t.store.getState().pending?.stages.find((s) => s.stage === 'participant')?.progress[0]).toMatchObject({ id: small, received: 37, total: 100, state: 'downloading' });
    t.recognition.progress(small, 'downloaded');
    expect(t.read().asrNativeByLanguage.ja).toBe(small);
    expect(t.store.getState().pending?.stages.map((s) => s.stage)).toEqual(['translation']);
    t.translation.progress(index, 'downloaded');
    expect(t.store.getState().pending).toBeNull();
  });
  it('cancels only the manually changed stage and never switches it after completion', () => {
    const t = setup();
    t.store.getState().apply(t.plan('balanced'));
    t.edit({ asrNativeByLanguage: { ja: 'sensevoice-small-q8' } });
    expect(t.store.getState().pending?.stages.map((s) => s.stage)).toEqual(['speaker', 'translation']);
    t.recognition.progress(small, 'downloaded');
    expect(t.read().asrNativeByLanguage.ja).toBe('sensevoice-small-q8');
    t.recognition.progress(x, 'downloaded');
    expect(t.read().asrNativeByLanguage.zh).toBe(x);
    t.store.getState().cancel();
  });
  it('cancels pending switches without cancelling shared downloads, and ignores late completion', () => {
    const t = setup();
    t.store.getState().apply(t.plan('balanced'));
    t.store.getState().cancel('translation');
    expect(t.store.getState().pending?.stages).toHaveLength(2);
    t.store.getState().cancel();
    t.recognition.progress(x, 'downloaded');
    expect(t.read().asrNativeByLanguage).toEqual({});
    expect(t.recognition.store.getState().cancel).not.toHaveBeenCalled();
    expect(t.listeners.size).toBe(0);
  });
  it('does not leave an impossible pending switch after the peer engine is changed by hand', () => {
    const t = setup([small]);
    t.store.getState().apply(t.plan('balanced'));
    t.edit({ asrNativeByLanguage: { zh: 'r2t2-q8' } });
    expect(t.store.getState().pending?.stages.map((s) => s.stage)).toEqual(['translation']);
    expect(t.read().asrNativeByLanguage).toEqual({ zh: 'r2t2-q8' });
    t.store.getState().cancel();
  });
  it('replaces an earlier pending plan and deduplicates shared model downloads', () => {
    const t = setup();
    t.store.getState().apply(t.plan('balanced'));
    t.store.getState().apply(t.plan('accurate'));
    expect(t.recognition.store.getState().download).toHaveBeenCalledWith(big);
    expect(vi.mocked(t.recognition.store.getState().download).mock.calls.filter(([id]) => id === big)).toHaveLength(1);
    t.recognition.progress(x, 'downloaded');
    expect(t.read().asrNativeByLanguage).toEqual({});
    t.recognition.progress(big, 'downloaded');
    expect(t.read().asrNativeByLanguage).toEqual({ zh: big, ja: big });
    t.store.getState().cancel();
  });
  it('keeps failures pending and never applies an absent or failed model', () => {
    const t = setup();
    t.store.getState().apply(t.plan('balanced'));
    t.recognition.progress(x, 'failed');
    expect(t.store.getState().pending?.stages[0].progress[0].state).toBe('failed');
    expect(t.read().asrNativeByLanguage).toEqual({});
    t.store.getState().cancel();
  });
  it('keeps the shared recognition placement until all requested sides can run here', () => {
    const t = setup([x]);
    t.edit({ asrVia: 'api' });
    t.store.getState().apply(t.plan('balanced'));
    expect(t.read().asrVia).toBe('api');
    t.recognition.progress(small, 'downloaded');
    expect(t.read().asrVia).toBe('device');
    expect(t.read().asrNativeByLanguage).toEqual({ zh: x, ja: small });
    t.store.getState().cancel();
  });
  it('does not let a shared-engine partial switch produce two different audio.cpp models', () => {
    const t = setup([small]);
    t.store.getState().apply(t.plan('balanced'));
    expect(t.read().asrNativeByLanguage).toEqual({});
    t.recognition.progress(x, 'downloaded');
    expect(t.read().asrNativeByLanguage).toEqual({ zh: x, ja: small });
    t.store.getState().cancel();
  });
  it('applies a language fix through the same coordinator and follows a shared engine on both sides', () => {
    const t = setup([small]);
    t.store.getState().applyRecognition('participant', t.plan('balanced').participant);
    expect(t.read().asrNativeByLanguage).toEqual({ zh: small, ja: small });
    expect(t.store.getState().pending).toBeNull();
  });
  it('waits for every Apple language asset', () => {
    const t = setup(['apple-speech:zh']);
    t.store.getState().applyRecognition('speaker', { model: 'apple-speech:zh', languages: ['zh', 'ja'], models: ['apple-speech:zh', 'apple-speech:ja'] });
    expect(t.store.getState().pending?.stages[0].waiting).toEqual(['apple-speech:ja']);
    expect(t.read().asrNativeByLanguage).toEqual({});
    t.recognition.progress('apple-speech:ja', 'downloaded');
    expect(t.read().asrNativeByLanguage.zh).toBe('apple-speech:zh');
  });
});
