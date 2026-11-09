import { describe, expect, it } from 'vitest';
import { mergeKnownDevices, type KnownDevice } from './knownDevices';
import type { FoundServer } from './discover';

const phone = (overrides: Partial<FoundServer> = {}): FoundServer => ({
  address: '192.168.4.33:8792', kind: 'phone', name: 'Living iPad', product: '', models: 1, needsKey: false, self: false,
  model: 'apple-speech', tablet: true, hears: ['apple-speech', 'whisper'], ...overrides,
});

const known = (value: FoundServer, reachable = true): KnownDevice => ({ ...value, reachable, lastSeenAt: reachable ? 10 : 10 });

describe('known LAN devices', () => {
  it('keeps an unanswered device selectable with its self-reported tablet form and capabilities', () => {
    const result = mergeKnownDevices([known(phone())], [], 20);
    expect(result).toEqual([{ ...phone(), reachable: false, lastSeenAt: 10 }]);
  });

  it('keeps devices with different addresses separate even when their names match', () => {
    const result = mergeKnownDevices([known(phone())], [phone({ address: '192.168.4.99:8792', model: 'new-model' })], 30);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ address: '192.168.4.33:8792', reachable: false });
    expect(result[1]).toMatchObject({ address: '192.168.4.99:8792', model: 'new-model', tablet: true, reachable: true, lastSeenAt: 30 });
  });

  it('replaces capabilities on a repeated address while retaining the kind from discovery', () => {
    const result = mergeKnownDevices([known(phone())], [phone({ name: 'Living iPad', tablet: true, hears: ['apple-speech'] })], 40);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: 'phone', tablet: true, hears: ['apple-speech'], reachable: true });
  });
});

