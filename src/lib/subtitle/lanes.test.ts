import { describe, expect, it } from 'vitest';
import type { LegName } from '../conversation/types';
import type { Entry, Row } from '../projection/types';
import type { LegFilters } from '../view/filter';
import { buildLanes, lanesHeight, ROOMY, spacingAt, squeezeOf, TIGHT } from './lanes';

const row = (segmentId: string, text: string, side: 'source' | 'translation' = 'source', language?: string): Row =>
  ({ key: `${segmentId}:0`, segmentId, side, start: 0, end: text.length, text, final: true, ...(language ? { language } : {}) });
const said = (id: string, leg: LegName, source: string, answer = ''): Entry => ({
  kind: 'exchange', id, leg, languages: leg === 'participant' ? { source: 'ja', target: 'zh-CN' } : { source: 'zh-CN', target: 'ja' }, pairing: 'stated',
  source: source ? [row(`s-${id}`, source)] : [], translation: answer ? [row(`t-${id}`, answer, 'translation')] : [], t: 0,
});
const BOTH: LegFilters = { speaker: 'both', participant: 'both' };
const LEGS: LegName[] = ['speaker', 'participant'];
const words = (notice: { message: string }) => notice.message;
const lanes = (entries: Entry[], legs = LEGS, filters = BOTH) => buildLanes(entries, legs, filters, words);

describe('the subtitle view’s lanes', () => {
  it('has a lane for each side heard, the other side first, there from the start', () => {
    expect(lanes([])).toEqual([
      { leg: 'participant', source: { text: '', pieces: [] }, answer: { text: '', pieces: [], stale: false } },
      { leg: 'speaker', source: { text: '', pieces: [] }, answer: { text: '', pieces: [], stale: false } },
    ]);
    expect(lanes([], ['participant']).map((lane) => lane.leg)).toEqual(['participant']);
  });

  it('holds each side’s newest sentence and what answers it, whatever the other side said since', () => {
    // Seen 2026-10-06: the feedback on the user's sentence came a second late, under two sentences of the other side.
    const built = lanes([
      said('a', 'speaker', '昨日映画を見ます。', '昨日映画を見ました。'),
      said('b', 'participant', 'そうそうそう。', '对对对。'),
      said('c', 'participant', 'それが好きなんですよ。', '我就是喜欢这个。'),
    ]);
    expect(built[0]).toMatchObject({ leg: 'participant', source: { text: 'それが好きなんですよ。', language: 'ja' }, answer: { text: '我就是喜欢这个。', stale: false, language: 'zh-CN' } });
    expect(built[1]).toMatchObject({ leg: 'speaker', source: { text: '昨日映画を見ます。' }, answer: { text: '昨日映画を見ました。', stale: false } });
  });

  it('keeps the last answer, marked stale, while the newest sentence has none yet', () => {
    const built = lanes([said('a', 'participant', 'そうそうそう。', '对对对。'), said('b', 'participant', 'それが')], ['participant']);
    expect(built[0]).toMatchObject({ source: { text: 'それが' }, answer: { text: '对对对。', stale: true } });
    // Nothing answered yet at all: empty, and not stale.
    expect(lanes([said('a', 'participant', 'それが')], ['participant'])[0].answer).toEqual({ text: '', pieces: [], stale: false });
  });

  it('carries each text row by row, with where each row begins in its segment: what karaoke lights it by', () => {
    const entry = said('a', 'speaker', '', '');
    if (entry.kind !== 'exchange') throw new Error('unreachable');
    entry.translation = [
      { key: 't:0', segmentId: 't', side: 'translation', start: 0, end: 9, text: ' Welcome.', final: true },
      { key: 't:1', segmentId: 't', side: 'translation', start: 9, end: 17, text: ' I will ', final: true },
    ];
    const answer = lanes([entry], ['speaker'])[0].answer!;
    expect(answer.text).toBe('Welcome. I will');
    // The whole's outer whitespace is gone, and the first row's start has moved past what was cut from it.
    expect(answer.pieces).toEqual([
      { key: 't:0', segmentId: 't', start: 1, text: 'Welcome.' },
      { key: 't:1', segmentId: 't', start: 9, text: ' I will' },
    ]);
    expect(answer.pieces.map((piece) => piece.text).join('')).toBe(answer.text);
  });

  it('takes a row’s own language where the provider detected one', () => {
    const entry = said('a', 'participant', '', '');
    if (entry.kind !== 'exchange') throw new Error('unreachable');
    entry.source = [row('s', '안녕하세요.', 'source', 'ko')];
    expect(lanes([entry], ['participant'])[0].source).toMatchObject({ text: '안녕하세요.', language: 'ko' });
  });

  it('shows only the sides the subtitle is set to show, and no lane for a side wholly hidden', () => {
    const entries = [said('a', 'participant', 'そうそう。', '对对。'), said('b', 'speaker', '你好。', 'こんにちは。')];
    const built = lanes(entries, LEGS, { participant: 'translation', speaker: 'none' });
    expect(built).toEqual([{ leg: 'participant', answer: expect.objectContaining({ text: '对对。' }) }]);
    expect(lanes(entries, LEGS, { participant: 'source', speaker: 'both' })[0]).toEqual({ leg: 'participant', source: expect.objectContaining({ text: 'そうそう。' }) });
  });

  it('says a notice that came after the newest sentence where the answer is', () => {
    const notice: Entry = { kind: 'notice', id: 'n', leg: 'participant', severity: 'error', message: 'The translation model did not answer.', at: 1 };
    const built = lanes([said('a', 'participant', 'そうそう。', '对对。'), notice], ['participant']);
    expect(built[0].answer).toMatchObject({ text: 'The translation model did not answer.', stale: false, notice });
    // A sentence after it takes the lane back.
    expect(lanes([notice, said('b', 'participant', 'はい。', '好的。')], ['participant'])[0].answer).toMatchObject({ text: '好的。' });
  });
});

describe('the height a strip of lanes is laid out for', () => {
  const two = lanes([]);
  const one = lanes([], ['participant']);

  it('follows the size chosen, so that a larger size is a taller strip of the same lines', () => {
    expect(lanesHeight(two, 32)).toBeGreaterThan(lanesHeight(two, 24));
    expect(lanesHeight(two, 24)).toBeGreaterThan(lanesHeight(one, 24));
    expect(lanesHeight([], 24)).toBe(0);
    // One lane at 24: the source's line, the answer's two, and the air around them.
    expect(lanesHeight(one, 24)).toBe(Math.ceil(ROOMY.padTop + ROOMY.padBottom + 24 * 0.62 * ROOMY.sourceLine + 24 * ROOMY.answerLine * 2 + ROOMY.inner));
  });

  it('can be squeezed down to one line a text and less air, and no further', () => {
    const roomy = lanesHeight(two, 24);
    const tight = lanesHeight(two, 24, TIGHT);
    expect(tight).toBeLessThan(roomy * 0.7);
    expect(squeezeOf(roomy, roomy, tight)).toBe(0);
    expect(squeezeOf(roomy + 100, roomy, tight)).toBe(0);
    expect(squeezeOf(tight, roomy, tight)).toBe(1);
    expect(squeezeOf(tight - 50, roomy, tight)).toBe(1);
    expect(squeezeOf((roomy + tight) / 2, roomy, tight)).toBeCloseTo(0.5);
    expect(spacingAt(0)).toEqual(ROOMY);
    expect(spacingAt(1)).toEqual(TIGHT);
    expect(spacingAt(0.5).gap).toBeCloseTo((ROOMY.gap + TIGHT.gap) / 2);
    // The height a spacing takes is the one it was squeezed to.
    expect(lanesHeight(two, 24, spacingAt(0.5))).toBeGreaterThan(tight);
    expect(lanesHeight(two, 24, spacingAt(0.5))).toBeLessThan(roomy);
  });
});
