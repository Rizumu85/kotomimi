import { beforeAll, describe, expect, it } from 'vitest';

/** The worklet's own globals, enough to run its processor here. */
type Message = { type: string; pcmData: Int16Array; left: Int16Array | null; right: Int16Array | null };
let Processor: new () => { port: { onmessage: (e: { data: unknown }) => void; sent: Message[] }; process(inputs: Float32Array[][]): boolean };

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.sampleRate = 24000;
  g.currentTime = 0;
  g.AudioWorkletProcessor = class {
    port = { sent: [] as Message[], onmessage: (_: unknown) => {}, postMessage(data: Message) { this.sent.push(data); } };
  };
  g.registerProcessor = (_name: string, cls: typeof Processor) => { Processor = cls; };
  await import('./audio-recorder-worklet-processor.js');
});

const block = (value: number) => new Float32Array(128).fill(value);
function started(stereo: boolean) {
  const p = new Processor();
  p.port.onmessage({ data: { type: 'config', config: { skipStartupFrames: 0, ...(stereo ? { stereo: true } : {}) } } });
  return p;
}

describe('the recorder worklet — both channels (Kotomimi)', () => {
  it('hears the average of two channels, and sends each with it, sample for sample', () => {
    const p = started(true);
    for (let i = 0; i < 32; i++) p.process([[block(0.5), block(-0.25)]]);
    const [m] = p.port.sent;
    expect(m.pcmData).toHaveLength(4096);
    expect(m.pcmData[0]).toBe(Math.trunc(0.125 * 32767));
    expect(m.left?.[4095]).toBe(Math.trunc(0.5 * 32767));
    expect(m.right?.[4095]).toBe(-0.25 * 32768);
  });

  it('hears the first channel alone, and sends no channels, without stereo', () => {
    const p = started(false);
    for (let i = 0; i < 32; i++) p.process([[block(0.5), block(-0.25)]]);
    expect(p.port.sent[0].pcmData[0]).toBe(Math.trunc(0.5 * 32767));
    expect(p.port.sent[0].left).toBeNull();
  });

  it('sends no channels for a chunk with a stretch of one channel, and keeps them in step after it and after a stop', () => {
    const p = started(true);
    p.process([[block(0.1)]]);
    for (let i = 0; i < 31; i++) p.process([[block(0.5), block(-0.25)]]);
    for (let i = 0; i < 32; i++) p.process([[block(0.5), block(-0.25)]]);
    expect(p.port.sent.map((m) => m.left !== null)).toEqual([false, true]);
    // Stopped halfway through a chunk: what is held goes; the next chunk starts with its channels in step.
    for (let i = 0; i < 3; i++) p.process([[block(0.5), block(-0.25)]]);
    p.port.onmessage({ data: { type: 'stop' } });
    p.port.onmessage({ data: { type: 'start' } });
    for (let i = 0; i < 32; i++) p.process([[block(0.3), block(0.3)]]);
    const last = p.port.sent[p.port.sent.length - 1];
    expect(last.left?.[0]).toBe(last.pcmData[0]);
    expect(last.right?.[4095]).toBe(last.pcmData[4095]);
  });
});
