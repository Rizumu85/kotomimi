import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../../local-inference/workers/_shared/onnxruntime-all', () => ({
  env: { wasm: {} },
  Tensor: class { constructor(public type: string, public data: Float32Array, public dims: number[]) {} },
  InferenceSession: { create: async () => ({ run: runtime.run, release: vi.fn() }) },
}));

const result = (feeds: Record<string, unknown>) => ({
  enh: feeds.mix, conv_cache_out: feeds.conv_cache, tra_cache_out: feeds.tra_cache, inter_cache_out: feeds.inter_cache,
});

beforeEach(() => {
  vi.resetModules();
  runtime.run.mockReset().mockImplementation(async (feeds) => result(feeds));
});
afterEach(() => vi.unstubAllGlobals());

async function worker() {
  const scope = { postMessage: vi.fn(), onmessage: null as ((event: MessageEvent) => void) | null };
  vi.stubGlobal('self', scope);
  await import('./gtcrn-worker');
  const send = (data: unknown) => scope.onmessage!({ data } as MessageEvent);
  send({ type: 'init', ortWasmBaseUrl: '/wasm/', modelUrl: '/model.onnx' });
  await vi.waitFor(() => expect(scope.postMessage).toHaveBeenCalledWith({ type: 'ready' }));
  scope.postMessage.mockClear();
  return { send, scope };
}

describe('GTCRN worker generations', () => {
  it.each([false, true])('drops running and queued old audio on reset (old inference fails: %s)', async (fails) => {
    const { send, scope } = await worker();
    let resolve!: (value: unknown) => void;
    let reject!: (reason: Error) => void;
    runtime.run.mockImplementationOnce(() => new Promise((yes, no) => { resolve = yes; reject = no; }));
    send({ type: 'reset', generation: 1 });
    send({ type: 'process', generation: 1, audio: new Int16Array(1536).fill(100) });
    await vi.waitFor(() => expect(runtime.run).toHaveBeenCalledTimes(1));
    send({ type: 'process', generation: 1, audio: new Int16Array(1536).fill(200) });
    send({ type: 'reset', generation: 2 });
    send({ type: 'process', generation: 2, audio: new Int16Array(1536).fill(300) });
    if (fails) reject(new Error('old inference failed'));
    else resolve(result(runtime.run.mock.calls[0][0]));

    await vi.waitFor(() => expect(scope.postMessage).toHaveBeenCalledTimes(1));
    expect(scope.postMessage.mock.calls[0][0]).toMatchObject({ type: 'audio', generation: 2 });
    expect(runtime.run).toHaveBeenCalledTimes(2);
  });

  it('tags a current inference error so the recorder can fall back', async () => {
    const { send, scope } = await worker();
    runtime.run.mockRejectedValueOnce(new Error('inference failed'));
    send({ type: 'reset', generation: 4 });
    send({ type: 'process', generation: 4, audio: new Int16Array(1536) });
    await vi.waitFor(() => expect(scope.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', generation: 4 })));
  });
});
