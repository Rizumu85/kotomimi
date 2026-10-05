// Fork: what a native model's card says of its engine.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { NativeEngineStatus } from '../../lib/native/nativeEngine';
import { useNativeCoachStore, useNativeEngineStore } from '../../stores/nativeEngineStore';
import { NativeEngineCard } from './NativeEngineCard';
import { NATIVE_COACHES } from './nativeCoaches';
import { NATIVE_MODELS } from './localaiNative';

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
});
