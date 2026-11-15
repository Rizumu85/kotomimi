import { describe, expect, it } from 'vitest';
import { nativeStreamEvent } from './nativeEngine';

describe('a stream event from the main process', () => {
  it('keeps the places of the dictionary’s words in a last reading, and only those that fit its text (fork)', () => {
    const event = nativeStreamEvent({
      id: 3, type: 'done', text: 'Rizum来了', language: 'zh',
      hinted: [{ start: 0, end: 5, plain: '里祖姆' }, { start: 4, end: 40, plain: 'x' }, { start: 2, end: 2, plain: 'x' }, { start: 0, end: 5 }, null, 'no'],
    });
    expect(event).toEqual({ id: 3, type: 'done', text: 'Rizum来了', language: 'zh', hinted: [{ start: 0, end: 5, plain: '里祖姆' }] });
    expect(nativeStreamEvent({ id: 3, type: 'done', text: '来了', hinted: 'no' })).toEqual({ id: 3, type: 'done', text: '来了' });
  });
});
