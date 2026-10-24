import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/persistSetting', () => ({ persistSetting: vi.fn(async () => true) }));
vi.mock('../../services/ServiceFactory', () => ({ ServiceFactory: { getSettingsService: () => ({ getSetting: async () => ({}) }) } }));

import { clearPhoneKeys, phoneKey, phoneKeyOf, phoneKeysNow, setPhoneKey } from './phoneKeys';

describe('phone access keys', () => {
  afterEach(() => clearPhoneKeys());

  it('are kept by address and found from a base URL as from the address', async () => {
    await setPhoneKey('192.168.1.23:8792', 'K7P2QX');
    expect(phoneKey('http://192.168.1.23:8792/v1')).toBe('K7P2QX');
    expect(phoneKey('192.168.1.23:8792')).toBe('K7P2QX');
    expect(phoneKey('192.168.1.24:8792')).toBe('');
    expect(phoneKeysNow()).toEqual({ '192.168.1.23:8792': 'K7P2QX' });
  });

  it('are forgotten when blank, and only what a header can carry is a key', async () => {
    await setPhoneKey('192.168.1.23:8792', 'K7P2QX');
    await setPhoneKey('192.168.1.23:8792', '  ');
    expect(phoneKey('192.168.1.23:8792')).toBe('');
    expect(phoneKeyOf(' K7 P2 ')).toBe('');
    expect(phoneKeyOf('钥匙')).toBe('');
    expect(phoneKeyOf(' K7P2QX ')).toBe('K7P2QX');
  });
});
