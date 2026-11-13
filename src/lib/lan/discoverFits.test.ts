import { describe, expect, it } from 'vitest';
import { foundServers, phoneLends } from './discover';

describe('a phone found by the search: whether each text model fits (fork)', () => {
  it('keeps what the search reckoned, which has no memory figures left to reckon from', () => {
    const [phone] = foundServers([{
      address: '192.168.1.23:8792', kind: 'phone', name: 'Pixel', models: 2, needsKey: false, self: false,
      text: [
        { id: 'hy-mt2-1.8b', kind: 'translate', name: 'Hunyuan MT 2 1.8B', loaded: false, fits: true },
        { id: 'index-translate-2b', kind: 'translate', name: 'Index-Translate 2B', loaded: false, fits: false },
      ],
    }]);
    expect(phoneLends(phone, 'translate').map((m) => [m.id, m.fits])).toEqual([['hy-mt2-1.8b', true], ['index-translate-2b', false]]);
  });

  it('says nothing of a model the search could not reckon', () => {
    const [phone] = foundServers([{ address: '192.168.1.23:8792', kind: 'phone', name: '', models: 1, needsKey: false, self: false, text: [{ id: 'hy-mt2-1.8b', kind: 'translate', name: '', loaded: false }] }]);
    expect('fits' in phoneLends(phone, 'translate')[0]).toBe(false);
  });
});
