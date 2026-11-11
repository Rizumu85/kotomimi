import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useLanStore } from '../../stores/lanStore';
import { useNativeRecommendationInputs } from './useNativeRecommendationInputs';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useLanStore.setState({ enabled: false });
});

describe('native recommendation inputs', () => {
  it('starts waiting, reads memory over IPC, and follows the lending switch without reading memory again', async () => {
    let answer!: (value: unknown) => void;
    const invoke = vi.fn(() => new Promise((resolve) => { answer = resolve; }));
    vi.stubGlobal('electron', { invoke });
    const { result } = renderHook(useNativeRecommendationInputs);
    expect(result.current).toEqual({ memoryMB: undefined, lending: false });
    await act(async () => { answer(24576); });
    expect(result.current).toEqual({ memoryMB: 24576, lending: false });
    act(() => { useLanStore.setState({ enabled: true }); });
    expect(result.current).toEqual({ memoryMB: 24576, lending: true });
    expect(invoke).toHaveBeenCalledExactlyOnceWith('model-memory:get');
  });

  it.each([null, undefined, -1, Infinity, NaN, '8192', { memoryMB: 8192 }])('leaves an unknown or malformed answer unknown (%j)', async (value) => {
    const invoke = vi.fn().mockResolvedValue(value);
    vi.stubGlobal('electron', { invoke });
    const { result } = renderHook(useNativeRecommendationInputs);
    expect(result.current.memoryMB).toBeUndefined();
    await act(async () => {});
    expect(result.current.memoryMB).toBeNull();
  });

  it('accepts a known zero', async () => {
    vi.stubGlobal('electron', { invoke: vi.fn().mockResolvedValue(0) });
    const { result } = renderHook(useNativeRecommendationInputs);
    await waitFor(() => { expect(result.current.memoryMB).toBe(0); });
  });

  it('still reports lending if the preload cannot answer', async () => {
    vi.stubGlobal('electron', { invoke: vi.fn().mockRejectedValue(new Error('unknown channel')) });
    useLanStore.setState({ enabled: true });
    const { result } = renderHook(useNativeRecommendationInputs);
    await act(async () => {});
    expect(result.current).toEqual({ memoryMB: null, lending: true });
  });

  it('works in a browser without Electron', async () => {
    vi.stubGlobal('electron', undefined);
    const { result } = renderHook(useNativeRecommendationInputs);
    await act(async () => {});
    expect(result.current).toEqual({ memoryMB: null, lending: false });
  });
});
