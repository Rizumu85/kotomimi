// Fork: what a native model's card says of its engine.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { NativeEngineStatus } from '../../lib/native/nativeEngine';
import { useNativeCoachStore, useNativeEngineStore } from '../../stores/nativeEngineStore';
import { NativeEngineCard, nativeNoteKey } from './NativeEngineCard';
import { NATIVE_COACHES } from './nativeCoaches';
import { NATIVE_MODELS } from './localaiNative';
import { NATIVE_TRANSLATORS } from './nativeTranslators';
import en from '../../locales/en/translation.json';
import zhCN from '../../locales/zh_CN/translation.json';
import zhTW from '../../locales/zh_TW/translation.json';

// The catalog's keys stand for its strings.
vi.mock('react-i18next', async (importOriginal) => ({ ...(await importOriginal<typeof import('react-i18next')>()), useTranslation: () => ({ t: (key: string) => key }) }));

const GEMMA = NATIVE_COACHES[0];
const here = (run: NativeEngineStatus['run'], up: string[] = []): NativeEngineStatus => ({
  supported: true,
  engine: 'ready',
  engineBytes: 1,
  models: { [GEMMA.id]: { state: 'downloaded', received: 1, total: 1 }, 'qwen3-asr-1.7b-q8': { state: 'downloaded', received: 1, total: 1 }, 'qwen3-asr-0.6b-q8': { state: 'downloaded', received: 1, total: 1 } },
  run,
  up,
});
const before = { coach: useNativeCoachStore.getState().status, hearing: useNativeEngineStore.getState().status };

afterEach(() => {
  cleanup();
  useNativeCoachStore.setState({ status: before.coach });
  useNativeEngineStore.setState({ status: before.hearing });
});

describe('what a native model’s card says of it', () => {
  type Words = Record<string, string>;
  const words = (catalog: unknown): Words => (catalog as { providers: { localai: Words } }).providers.localai;

  it('is a sentence the catalogs have, for every model of every engine', () => {
    for (const model of [...NATIVE_MODELS, ...NATIVE_TRANSLATORS, ...NATIVE_COACHES]) {
      const key = nativeNoteKey(model.id);
      expect(key, model.id).toBeTruthy();
      for (const catalog of [en, zhCN, zhTW]) expect(words(catalog)[key!], `${model.id} ${key}`).toBeTruthy();
    }
    expect(nativeNoteKey('some-other-model')).toBeUndefined();
  });

  it('says of SenseVoice-Small what it costs and what it hears, in the three languages the fork writes, and briefly', () => {
    expect(nativeNoteKey('sensevoice-small-q8')).toBe('noteNativeSenseVoice');
    for (const [catalog, languages] of [[en, ['Chinese', 'Cantonese', 'English', 'Japanese', 'Korean']], [zhCN, ['中文', '粤语', '英语', '日语', '韩语']], [zhTW, ['中文', '粵語', '英語', '日語', '韓語']]] as const) {
      const note = words(catalog).noteNativeSenseVoice;
      // What it takes of the graphics card, how right it is — said against the small Qwen3-ASR, which it is level
      // with (20.3 % against 20.7 %: no number of its own would say that) — and its five languages.
      expect(note).toContain('0.4 GB');
      expect(note).toContain('Qwen3-ASR');
      for (const language of languages) expect(note).toContain(language);
      // No longer than the notes of the cards beside it.
      expect(note.length).toBeLessThanOrEqual(words(catalog).noteNativeQwenSmall.length);
    }
    // The card that was "the lightest" before it no longer says so: this one is.
    expect(words(en).noteNativeNemotron).not.toMatch(/lightest/i);
    expect(words(zhCN).noteNativeNemotron).not.toContain('最省');
    expect(words(zhTW).noteNativeNemotron).not.toContain('最省');
  });
});

describe('a native model’s card', () => {
  it('says nothing of an engine that is not in use, even on the model that is chosen: downloaded is not "starting"', () => {
    useNativeCoachStore.setState({ status: here({ state: 'stopped', model: null, port: 0, tail: '' }), asked: true });
    render(<NativeEngineCard kind="coach" model={GEMMA} selected onSelect={() => {}} />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByText('providers.localai.nativeCoachWarmingShort')).toBeNull();
  });

  it('says it is starting only while it is being started, and ready once it is', () => {
    useNativeCoachStore.setState({ status: here({ state: 'starting', model: GEMMA.id, port: 4100, tail: '' }), asked: true });
    const view = render(<NativeEngineCard kind="coach" model={GEMMA} selected onSelect={() => {}} />);
    expect(screen.getByRole('status').textContent).toBe('providers.localai.nativeCoachWarmingShort');
    useNativeCoachStore.setState({ status: here({ state: 'warming', model: GEMMA.id, port: 4100, tail: '' }) });
    view.rerender(<NativeEngineCard kind="coach" model={GEMMA} selected onSelect={() => {}} />);
    expect(screen.getByRole('status').textContent).toBe('providers.localai.nativeCoachWarmingShort');
    useNativeCoachStore.setState({ status: here({ state: 'ready', model: GEMMA.id, port: 4100, tail: '' }, [GEMMA.id]) });
    view.rerender(<NativeEngineCard kind="coach" model={GEMMA} selected onSelect={() => {}} />);
    expect(screen.getByRole('status').textContent).toBe('providers.localai.nativeCoachReady');
  });

  it('leaves the other downloaded models of an engine silent while one of them runs', () => {
    const large = NATIVE_MODELS.find((m) => m.id === 'qwen3-asr-1.7b-q8')!;
    const small = NATIVE_MODELS.find((m) => m.id === 'qwen3-asr-0.6b-q8')!;
    useNativeEngineStore.setState({ status: here({ state: 'ready', model: large.id, port: 4100, tail: '' }, [large.id]), asked: true });
    render(<><NativeEngineCard kind="asr" model={large} selected onSelect={() => {}} /><NativeEngineCard kind="asr" model={small} selected onSelect={() => {}} /></>);
    expect(screen.getAllByRole('status').map((s) => s.textContent)).toEqual(['providers.localai.nativeReady']);
  });

  // Review of 6c76dd6 (REVIEW-engine-lifecycle.md, F5): an engine is held only while something uses it. "Try again"
  // loads it with nothing using it, and nothing lets it go: it holds its video memory until a run starts and ends.
  it('lets an engine that "Try again" brought up go again a minute later, when no run or device uses it', async () => {
    const ready = here({ state: 'ready', model: GEMMA.id, port: 4100, tail: '' }, [GEMMA.id]);
    useNativeCoachStore.setState({ status: here({ state: 'failed', model: GEMMA.id, port: 0, tail: 'out of memory' }), asked: true });
    const start = vi.spyOn(useNativeCoachStore.getState(), 'start').mockImplementation(async () => { useNativeCoachStore.setState({ status: ready }); return ready; });
    const stop = vi.spyOn(useNativeCoachStore.getState(), 'stop').mockResolvedValue(undefined);
    vi.useFakeTimers();
    try {
      render(<NativeEngineCard kind="coach" model={GEMMA} selected onSelect={() => {}} />);
      fireEvent.click(screen.getByRole('button', { name: 'providers.localai.nativeRetry' }));
      await vi.advanceTimersByTimeAsync(61_000);
      // A retry that only clears the failure, loading nothing, needs no stop; one that loads the engine does.
      if (start.mock.calls.length > 0) expect(stop).toHaveBeenCalled();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      start.mockRestore();
      stop.mockRestore();
    }
  });
});
