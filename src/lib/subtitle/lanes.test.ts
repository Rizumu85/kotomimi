import { describe, expect, it } from 'vitest';
import type { LegName } from '../conversation/types';
import type { Entry, Row } from '../projection/types';
import type { LegFilters } from '../view/filter';
import { buildLanes, lanesHeight, linesFor, ROMAN_LINE, ROOMY, ROW_SCALE, SOURCE_SCALE, spacingAt, squeezeOf, TIGHT, withRoman } from './lanes';

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
      { leg: 'participant', shape: 'pair', pending: false, source: { text: '', pieces: [] }, answer: { text: '', pieces: [] } },
      { leg: 'speaker', shape: 'row', pending: false, source: { text: '', pieces: [] }, answer: { text: '', pieces: [] } },
    ]);
    expect(lanes([], ['participant']).map((lane) => lane.leg)).toEqual(['participant']);
  });

  it('draws the user\u2019s own lane as a row under the other side\u2019s pair, and as a pair where it is the only one', () => {
    expect(lanes([]).map((lane) => [lane.leg, lane.shape])).toEqual([['participant', 'pair'], ['speaker', 'row']]);
    expect(lanes([], ['speaker']).map((lane) => [lane.leg, lane.shape])).toEqual([['speaker', 'pair']]);
    expect(lanes([], ['participant']).map((lane) => [lane.leg, lane.shape])).toEqual([['participant', 'pair']]);
    // The other side hidden altogether: the user's own is the strip, and is a pair.
    expect(lanes([], LEGS, { participant: 'none', speaker: 'both' }).map((lane) => [lane.leg, lane.shape])).toEqual([['speaker', 'pair']]);
  });

  it('holds each side’s newest sentence and what answers it, whatever the other side said since', () => {
    // Seen 2026-10-06: the feedback on the user's sentence came a second late, under two sentences of the other side.
    const built = lanes([
      said('a', 'speaker', '昨日映画を見ます。', '昨日映画を見ました。'),
      said('b', 'participant', 'そうそうそう。', '对对对。'),
      said('c', 'participant', 'それが好きなんですよ。', '我就是喜欢这个。'),
    ]);
    expect(built[0]).toMatchObject({ leg: 'participant', source: { text: 'それが好きなんですよ。', language: 'ja' }, answer: { text: '我就是喜欢这个。', language: 'zh-CN' }, pending: false });
    expect(built[1]).toMatchObject({ leg: 'speaker', source: { text: '昨日映画を見ます。' }, answer: { text: '昨日映画を見ました。' }, pending: false });
  });

  it('writes what is being said after the sentence the answer belongs to, and begins again at the newest once that is answered', () => {
    // First the small line held the answered sentence alone until the next was answered: with a stretch's sentences
    // answered one by one nothing moved while someone spoke, and it read as a slow recognizer (the user, 2026-10-06).
    const talking = [said('a', 'participant', 'そうそうそう。', '对对对。'), said('b', 'participant', 'それが')];
    const lane = lanes(talking, ['participant'])[0];
    expect(lane).toMatchObject({ source: { text: 'そうそうそう。それが' }, answer: { text: '对对对。' }, pending: true });
    // Row by row still, for the readings above the words and the light that follows a voice.
    expect(lane.source?.pieces.map((piece) => piece.text)).toEqual(['そうそうそう。', 'それが']);
    // Its answer has begun: both lines are the newest's.
    const answered = [said('a', 'participant', 'そうそうそう。', '对对对。'), said('b', 'participant', 'それが好きなんですよ。', '我就是')];
    expect(lanes(answered, ['participant'])[0]).toMatchObject({ source: { text: 'それが好きなんですよ。' }, answer: { text: '我就是' }, pending: false });
    // Several said since the one answered: all of them, in order.
    const more = [...talking.slice(0, 1), said('b', 'participant', 'それが好きなんですよ。'), said('c', 'participant', 'でも')];
    expect(lanes(more, ['participant'])[0].source?.text).toBe('そうそうそう。それが好きなんですよ。でも');
    // A space between two sentences of a script written with them, none after one written without.
    const latin = [said('a', 'participant', 'I see.', '明白了。'), said('b', 'participant', 'Then we')];
    expect(lanes(latin, ['participant'])[0].source?.text).toBe('I see. Then we');
    // No more than a few: a side whose answers stopped coming does not grow a line without end.
    const many = Array.from({ length: 9 }, (_, i) => said(`m${i}`, 'participant', `${i}番。`, i === 0 ? '零。' : undefined));
    expect(lanes(many, ['participant'])[0]).toMatchObject({ source: { text: '4番。5番。6番。7番。8番。' }, answer: { text: '零。' } });
    // Nothing answered yet: the last few said, so that a first sentence closed before its answer came stays in sight.
    const first = [said('a', 'participant', 'そうそうそう。'), said('b', 'participant', 'それが')];
    expect(lanes(first, ['participant'])[0]).toMatchObject({ source: { text: 'そうそうそう。それが' }, answer: { text: '', pieces: [] }, pending: false });
    // Nothing answered yet at all: the sentence itself, so that the strip is not empty while the first answer is made.
    expect(lanes([said('a', 'participant', 'それが')], ['participant'])[0]).toMatchObject({ source: { text: 'それが' }, answer: { text: '', pieces: [] }, pending: false });
    // The answers are not shown: there is nothing to wait for, and the newest sentence is shown as it is said.
    expect(lanes(talking, ['participant'], { participant: 'source', speaker: 'both' })[0]).toMatchObject({ source: { text: 'それが' }, pending: false });
  });

  it('shows the user\u2019s own newest sentence at once in its row, its answer when it comes', () => {
    const entries = [said('p', 'participant', 'はい。', '好的。'), said('a', 'speaker', '昨日映画を見ます。', '昨日映画を見ました。'), said('b', 'speaker', '週末は')];
    const row = lanes(entries)[1];
    expect(row).toMatchObject({ leg: 'speaker', shape: 'row', source: { text: '週末は' }, answer: { text: '', pieces: [] }, pending: true });
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
    expect(built).toEqual([{ leg: 'participant', shape: 'pair', pending: false, answer: expect.objectContaining({ text: '对对。' }) }]);
    expect(lanes(entries, LEGS, { participant: 'source', speaker: 'both' })[0]).toEqual({ leg: 'participant', shape: 'pair', pending: false, source: expect.objectContaining({ text: 'そうそう。' }) });
  });

  it('says a notice that came after the newest sentence where the answer is', () => {
    const notice: Entry = { kind: 'notice', id: 'n', leg: 'participant', severity: 'error', message: 'The translation model did not answer.', at: 1 };
    const built = lanes([said('a', 'participant', 'そうそう。', '对对。'), notice], ['participant']);
    expect(built[0].answer).toMatchObject({ text: 'The translation model did not answer.', notice });
    expect(built[0].pending).toBe(false);
    // A sentence after it takes the lane back.
    expect(lanes([notice, said('b', 'participant', 'はい。', '好的。')], ['participant'])[0].answer).toMatchObject({ text: '好的。' });
  });
});

describe('the lines a window made higher affords', () => {
  const two = lanes([]);
  const one = lanes([], ['participant']);
  const row = 24 * ROW_SCALE * ROOMY.rowLine;
  const answer = 24 * ROOMY.answerLine;
  const source = 24 * SOURCE_SCALE * ROOMY.sourceLine;

  it('are, fitted, one for the sentence, two for its answer and one for the user\u2019s own row', () => {
    expect(linesFor(two, 24, 0)).toEqual({ source: 1, answer: 2, row: 1 });
    // Not quite a line more: none.
    expect(linesFor(two, 24, row - 1)).toEqual({ source: 1, answer: 2, row: 1 });
  });

  it('go to the sentence on screen: the row\u2019s second first, then the answer\u2019s, then the source\u2019s', () => {
    // Asked for by the user 2026-10-06: a higher window is room for a long sentence, not for the ones before it.
    expect(linesFor(two, 24, row)).toEqual({ source: 1, answer: 2, row: 2 });
    expect(linesFor(two, 24, row + answer)).toEqual({ source: 1, answer: 3, row: 2 });
    expect(linesFor(two, 24, row + answer + source)).toEqual({ source: 2, answer: 3, row: 2 });
    expect(linesFor(two, 24, row + answer + source + answer + 0.01)).toEqual({ source: 2, answer: 4, row: 2 });
  });

  it('are the pair\u2019s alone where there is no row, and the answer\u2019s alone where the source is not shown', () => {
    expect(linesFor(one, 24, answer + source)).toEqual({ source: 2, answer: 3, row: 1 });
    const answers = lanes([], ['participant'], { participant: 'translation', speaker: 'both' });
    expect(linesFor(answers, 24, answer * 2)).toEqual({ source: 1, answer: 4, row: 1 });
  });

  it('stop at what still reads as a caption, however high the window', () => {
    expect(linesFor(two, 24, 5000)).toEqual({ source: 3, answer: 6, row: 3 });
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
    const pair = ROOMY.padTop + ROOMY.padBottom + 24 * 0.62 * ROOMY.sourceLine + 24 * ROOMY.answerLine * 2 + ROOMY.inner;
    expect(lanesHeight(one, 24)).toBe(Math.ceil(pair));
    // The user's own under it adds one gap and one small line: far less than a second pair.
    expect(lanesHeight(two, 24)).toBe(Math.ceil(pair + ROOMY.gap + 24 * ROW_SCALE * ROOMY.rowLine));
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

describe('a strip whose small lines have a romanization under them', () => {
  const two = buildLanes([], ['speaker', 'participant'], { speaker: 'both', participant: 'both' }, (notice) => notice.message);

  it('is higher by a line of it under each small line: the sentence’s, and the row’s', () => {
    // Without the room the romanization took the sentence’s own line, and the sentence was cut off (seen 2026-10-06).
    const plain = lanesHeight(two, 24);
    // Each height is rounded up to a pixel: within one of the sum.
    expect(Math.abs(lanesHeight(two, 24, withRoman(ROOMY)) - (plain + 2 * 24 * SOURCE_SCALE * ROMAN_LINE))).toBeLessThan(1);
    expect(ROW_SCALE).toBe(SOURCE_SCALE);
    // Squeezed, it keeps that line: the spacing between roomy and tight carries it.
    expect(spacingAt(0.5, withRoman(ROOMY), withRoman(TIGHT)).roman).toBe(ROMAN_LINE);
    expect(spacingAt(0.5).roman).toBe(0);
  });

  it('gives a further small line in a higher window only where there is room for its romanization too', () => {
    const row = 24 * ROW_SCALE * ROOMY.rowLine;
    expect(linesFor(two, 24, row).row).toBe(2);
    expect(linesFor(two, 24, row, withRoman(ROOMY)).row).toBe(1);
    expect(linesFor(two, 24, row + 24 * ROW_SCALE * ROMAN_LINE, withRoman(ROOMY)).row).toBe(2);
  });
});
