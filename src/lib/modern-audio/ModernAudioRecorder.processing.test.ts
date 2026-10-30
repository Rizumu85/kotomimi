import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModernAudioRecorder } from './ModernAudioRecorder';
import type { NoiseSuppressionState } from './noiseSuppression';

const rnnoise = vi.hoisted(() => ({ load: vi.fn(), created: vi.fn() }));
vi.mock('@sapphi-red/web-noise-suppressor', () => ({
  loadRnnoise: rnnoise.load,
  RnnoiseWorkletNode: class {
    connect = vi.fn();
    disconnect = vi.fn();
    destroy = vi.fn();
    constructor() { rnnoise.created(this); }
  },
}));

const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
class CaptureNode {
  connect = vi.fn();
  disconnect = vi.fn();
  port = { onmessage: null as ((event: MessageEvent) => void) | null, postMessage: vi.fn(), close: vi.fn() };
  constructor(_context: unknown, readonly name: string) { worklets.push(this); }
}
class Denoiser {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  terminate = vi.fn();
  postMessage = vi.fn((message: { type: string; generation?: number }) => {
    if (message.type === 'init' && workerAutoReady) queueMicrotask(() => {
      if (workerFailure) this.onerror?.();
      else this.send({ type: 'ready' });
    });
  });
  constructor() { workers.push(this); }
  send(data: unknown) { this.onmessage?.({ data } as MessageEvent); }
  generation() {
    const resets = this.postMessage.mock.calls.filter(([m]) => m.type === 'reset');
    return resets[resets.length - 1][0].generation;
  }
}

let worklets: CaptureNode[];
let workers: Denoiser[];
let processors: Array<ReturnType<typeof node> & { onaudioprocess: ((event: unknown) => void) | null }>;
let workerFailure: boolean;
let workerAutoReady: boolean;
let failCaptureModule: boolean;

beforeEach(() => {
  vi.useFakeTimers();
  worklets = [];
  workers = [];
  processors = [];
  workerFailure = false;
  workerAutoReady = true;
  failCaptureModule = false;
  rnnoise.load.mockReset().mockResolvedValue(new ArrayBuffer(8));
  rnnoise.created.mockReset();
  vi.stubGlobal('Worker', Denoiser);
  vi.stubGlobal('AudioWorkletNode', CaptureNode);
  vi.stubGlobal('AudioContext', class {
    state = 'running';
    sampleRate = 48000;
    destination = node();
    audioWorklet = { addModule: vi.fn(async () => { if (failCaptureModule) throw new Error('worklet blocked'); }) };
    createMediaStreamSource = () => node();
    createGain = () => ({ ...node(), gain: { value: 0 } });
    createScriptProcessor = () => {
      const processor = { ...node(), onaudioprocess: null };
      processors.push(processor);
      return processor;
    };
    close = vi.fn(async () => { this.state = 'closed'; });
  });
  vi.stubGlobal('MediaRecorder', class {
    static isTypeSupported = () => true;
    state = 'inactive';
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; }
  });
  const track = { stop: vi.fn(), getSettings: () => ({}) };
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track], getAudioTracks: () => [track] })) },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function recording(mode: 'off' | 'standard' | 'enhanced' = 'off') {
  const recorder = new ModernAudioRecorder({ sampleRate: 24000, enableWarmup: false });
  const states: Array<NoiseSuppressionState | null> = [];
  recorder.onNoiseSuppressionChange = (state) => states.push(state);
  await recorder.setNoiseSuppressionMode(mode);
  await recorder.begin('mic');
  const heard = vi.fn();
  const start = recorder.record(heard);
  await vi.advanceTimersByTimeAsync(100);
  await start;
  return { recorder, heard, states, latest: () => states[states.length - 1] };
}

const capture = (pcm = new Int16Array([100, 100, 200, 200])) => {
  const nodes = worklets.filter((worklet) => worklet.name === 'audio-recorder-processor');
  nodes[nodes.length - 1].port.onmessage?.({ data: { type: 'audioData', pcmData: pcm } } as MessageEvent);
};

describe('ModernAudioRecorder processing boundary', () => {
  it.each(['worklet', 'unsupported', 'module failure'])('keeps duration at 24 kHz through %s capture', async (backend) => {
    if (backend === 'unsupported') vi.stubGlobal('AudioWorkletNode', undefined);
    if (backend === 'module failure') failCaptureModule = true;
    const { recorder, heard } = await recording();
    if (backend === 'worklet') capture(new Int16Array(4800).fill(1000));
    else processors[0].onaudioprocess!({ inputBuffer: { getChannelData: () => new Float32Array(4800).fill(0.25) } });
    expect(heard).toHaveBeenCalledTimes(1);
    expect(heard.mock.calls[0][0].mono.length).toBe(2400);
    await recorder.quit();
  });

  it('reports unavailable suppression when capture uses ScriptProcessor', async () => {
    vi.stubGlobal('AudioWorkletNode', undefined);
    const { recorder, latest } = await recording('standard');
    expect(latest()).toMatchObject({ requested: 'standard', effective: 'off' });
    await recorder.quit();
  });

  it('falls back to raw capture when RNNoise fails, and keeps the requested mode', async () => {
    rnnoise.load.mockRejectedValue(new Error('WASM unavailable'));
    const { recorder, heard, latest } = await recording('standard');
    expect(latest()).toEqual({ requested: 'standard', effective: 'off', reason: 'WASM unavailable' });
    capture();
    expect([...heard.mock.calls[0][0].mono]).toEqual([100, 200]);
    await recorder.quit();
  });

  it.each([false, true])('settles the full enhanced fallback chain (RNNoise fails: %s)', async (rnnoiseFails) => {
    workerFailure = true;
    if (rnnoiseFails) rnnoise.load.mockRejectedValue(new Error('WASM unavailable'));
    const { recorder, latest } = await recording('enhanced');
    expect(latest()).toMatchObject({ requested: 'enhanced', effective: rnnoiseFails ? 'off' : 'standard' });
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    await recorder.quit();
  });

  it.each([false, true])('ignores stale RNNoise loading after switching off (load fails: %s)', async (fails) => {
    const { recorder, latest } = await recording();
    let resolve!: (value: ArrayBuffer) => void;
    let reject!: (error: Error) => void;
    rnnoise.load.mockReturnValue(new Promise<ArrayBuffer>((yes, no) => { resolve = yes; reject = no; }));
    const pending = recorder.setNoiseSuppressionMode('standard');
    await recorder.setNoiseSuppressionMode('off');
    if (fails) reject(new Error('late failure'));
    else resolve(new ArrayBuffer(8));
    await pending;
    expect(rnnoise.created).not.toHaveBeenCalled();
    expect(worklets.every((worklet) => worklet.name === 'audio-recorder-processor')).toBe(true);
    expect(latest()).toEqual({ requested: 'off', effective: 'off' });
    await recorder.quit();
  });

  it('drops stale enhanced output across off and enhanced re-entry', async () => {
    const { recorder, heard } = await recording('enhanced');
    const worker = workers[0];
    const oldGeneration = worker.generation();
    capture();
    expect(heard).not.toHaveBeenCalled();
    await recorder.setNoiseSuppressionMode('off');
    worker.send({ type: 'audio', generation: oldGeneration, audio: new Int16Array([1, 1]) });
    expect(heard).not.toHaveBeenCalled();
    capture();
    expect(heard).toHaveBeenCalledTimes(1);
    await recorder.setNoiseSuppressionMode('enhanced');
    worker.send({ type: 'audio', generation: oldGeneration, audio: new Int16Array([1, 1]) });
    expect(heard).toHaveBeenCalledTimes(1);
    worker.send({ type: 'audio', generation: worker.generation(), audio: new Int16Array([20, 20]) });
    expect(heard).toHaveBeenCalledTimes(2);
    expect([...heard.mock.calls[1][0].mono]).toEqual([20]);
    expect(workers).toHaveLength(1);
    await recorder.quit();
  });

  it.each(['pause', 'device'])('drops stale enhanced output across a %s restart', async (kind) => {
    const { recorder, heard } = await recording('enhanced');
    const worker = workers[0];
    const oldGeneration = worker.generation();
    if (kind === 'pause') await recorder.pause();
    else { await recorder.end(); await recorder.begin('other-mic'); }
    await recorder.record(heard);
    worker.send({ type: 'audio', generation: oldGeneration, audio: new Int16Array([1, 1]) });
    expect(heard).not.toHaveBeenCalled();
    worker.send({ type: 'audio', generation: worker.generation(), audio: new Int16Array([20, 20]) });
    expect(heard).toHaveBeenCalledTimes(1);
    await recorder.quit();
  });

  it.each(['message', 'crash'])('reports a runtime enhanced %s and continues through standard', async (kind) => {
    const { recorder, heard, latest } = await recording('enhanced');
    const worker = workers[0];
    if (kind === 'message') worker.send({ type: 'error', generation: worker.generation(), message: 'inference failed' });
    else worker.onerror?.();
    await vi.waitFor(() => expect(latest()).toMatchObject({ requested: 'enhanced', effective: 'standard' }));
    capture();
    expect(heard).toHaveBeenCalledTimes(1);
    expect(worker.terminate).toHaveBeenCalledOnce();
    await recorder.quit();
  });

  it('waits for one initialization when enhanced is selected again before its worker is ready', async () => {
    const { recorder, latest } = await recording();
    workerAutoReady = false;
    const first = recorder.setNoiseSuppressionMode('enhanced');
    await recorder.setNoiseSuppressionMode('off');
    const second = recorder.setNoiseSuppressionMode('enhanced');
    expect(workers).toHaveLength(1);
    workers[0].send({ type: 'ready' });
    await Promise.all([first, second]);
    expect(latest()).toEqual({ requested: 'enhanced', effective: 'enhanced' });
    await recorder.quit();
  });

  it('retires a worker that crashes while enhanced is switched off', async () => {
    const { recorder, latest } = await recording('enhanced');
    await recorder.setNoiseSuppressionMode('off');
    workers[0].onerror?.();
    expect(latest()).toEqual({ requested: 'off', effective: 'off' });
    await recorder.setNoiseSuppressionMode('enhanced');
    expect(latest()).toMatchObject({ requested: 'enhanced', effective: 'standard' });
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    await recorder.quit();
  });

  it('cancels an initializing worker when a running recorder is disposed', async () => {
    const { recorder, states } = await recording();
    workerAutoReady = false;
    const pending = recorder.setNoiseSuppressionMode('enhanced');
    await recorder.quit();
    await pending;
    expect(states[states.length - 1]).toBeNull();
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10000);
    expect(states[states.length - 1]).toBeNull();
  });
});
