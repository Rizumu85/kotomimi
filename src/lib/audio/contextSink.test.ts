import { describe, expect, it, vi } from 'vitest';
import { contextSink } from './contextSink';
import { KEEP_AWAKE_LEVEL } from './graph';

/** A context that records where it sits, what is connected to its destination, and its state. */
function fakeContexts(options: { refuse?: string } = {}) {
  const made: FakeContext[] = [];
  class FakeContext {
    state: 'running' | 'suspended' | 'closed' = 'running';
    sinkId = '';
    destination = {};
    connected: unknown[] = [];
    awake: number[] = [];
    createConstantSource = vi.fn(() => {
      const offset = { value: 1 };
      return { offset, connect: () => { this.awake.push(offset.value); }, start: () => {} };
    });
    setSinkId = vi.fn(async (id: string) => {
      if (id === options.refuse) throw new Error('no such device');
      this.sinkId = id;
    });
    createMediaStreamSource = vi.fn((stream: unknown) => ({
      connect: () => { this.connected.push(stream); },
      disconnect: () => { this.connected = this.connected.filter((one) => one !== stream); },
    }));
    suspend = vi.fn(async () => { this.state = 'suspended'; });
    resume = vi.fn(async () => { this.state = 'running'; });
    close = vi.fn(async () => { this.state = 'closed'; });
  }
  const create = () => {
    const ctx = new FakeContext();
    made.push(ctx);
    return ctx as unknown as AudioContext;
  };
  return { made, create };
}

const stream = (name: string) => ({ name }) as unknown as MediaStream;

describe('contextSink (fork)', () => {
  it('is paused until played, and plays the stream on the system output', async () => {
    const { made, create } = fakeContexts();
    const first = stream('first');
    const sink = contextSink(first, create);
    expect(sink.paused).toBe(true);
    expect(made).toHaveLength(0);
    await sink.play();
    expect(sink.paused).toBe(false);
    expect(made[0].connected).toEqual([first]);
    expect(made[0].sinkId).toBe('');
  });

  it('keeps every context it opens from going silent', async () => {
    const { made, create } = fakeContexts();
    const sink = contextSink(stream('first'), create);
    await sink.play();
    await sink.setSinkId!('cable-1');
    expect(made.map((ctx) => ctx.awake)).toEqual([[KEEP_AWAKE_LEVEL], [KEEP_AWAKE_LEVEL]]);
  });

  it('moves to a device on a fresh context and leaves the old one', async () => {
    const { made, create } = fakeContexts();
    const first = stream('first');
    const sink = contextSink(first, create);
    await sink.play();
    await sink.setSinkId!('cable-1');
    expect(made).toHaveLength(2);
    expect(made[1].sinkId).toBe('cable-1');
    expect(made[1].connected).toEqual([first]);
    expect(made[0].close).toHaveBeenCalledOnce();
    expect(made[1].suspend).not.toHaveBeenCalled();
  });

  it('holds no device and plays nothing while paused, on whatever device it is put', async () => {
    const { made, create } = fakeContexts();
    const sink = contextSink(stream('first'), create);
    await sink.setSinkId!('cable-1');
    expect(made[0].connected).toEqual([]);
    expect(made[0].state).toBe('suspended');
    await sink.play();
    expect(made[0].state).toBe('running');
    expect(made[0].connected).toHaveLength(1);
    sink.pause();
    expect(sink.paused).toBe(true);
    expect(made[0].connected).toEqual([]);
    expect(made[0].suspend).toHaveBeenCalledTimes(2);
  });

  it('stays where it was when a device refuses it', async () => {
    const { made, create } = fakeContexts({ refuse: 'gone' });
    const first = stream('first');
    const sink = contextSink(first, create);
    await sink.setSinkId!('cable-1');
    await sink.play();
    await expect(sink.setSinkId!('gone')).rejects.toThrow('no such device');
    expect(made[1].close).toHaveBeenCalledOnce();
    expect(made[0].close).not.toHaveBeenCalled();
    expect(made[0].connected).toEqual([first]);
  });

  it('plays another stream when given one, and nothing when given none', async () => {
    const { made, create } = fakeContexts();
    const sink = contextSink(stream('first'), create);
    await sink.play();
    const next = stream('next');
    sink.srcObject = next;
    expect(made[0].connected).toEqual([next]);
    sink.srcObject = null;
    expect(made[0].connected).toEqual([]);
    expect(sink.srcObject).toBeNull();
  });
});
