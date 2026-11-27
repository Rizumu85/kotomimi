import { describe, expect, it } from 'vitest';
import type { LegName } from '../conversation/types';
import type { Entry, Row } from '../projection/types';
import type { LegFilters } from '../view/filter';
import { buildLanes, furtherIn, lanesHeight, linesFor, READ_LINE, ROMAN_LINE, ROOMY, rowLegOf, ROW_SCALE, SOURCE_SCALE, spacingAt, squeezeOf, TIGHT, withAnswerAids, withFeedbackRoom, withRoman, withSmallReads } from './lanes';

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

describe('a sentence heard in none of the speaker’s languages (fork)', () => {
  it('runs on in the small line after the last answered one, as anything heard since does, and is waited on for nothing', () => {
    const answered = said('a', 'participant', 'こんにちは', '你好');
    const heard = said('b', 'participant', 'Kir Kirhum.');
    const misheard: Entry = heard.kind === 'exchange' ? { ...heard, source: heard.source.map((r) => ({ ...r, language: 'en', misheard: true as const })) } : heard;
    expect(lanes([answered, heard], ['participant'])[0]).toMatchObject({ source: { text: 'こんにちはKir Kirhum.' }, answer: { text: '你好' }, pending: true });
    expect(lanes([answered, misheard], ['participant'])[0]).toMatchObject({ source: { text: 'こんにちはKir Kirhum.' }, answer: { text: '你好' }, pending: false });
  });
});

describe('independent feedback beside translated subtitle lanes', () => {
  it("shows what is said at an answer's size in a run in one language", () => {
    const [lane] = lanes([{ ...said('a', 'participant', 'こんにちは'), languages: { source: 'ja', target: 'ja' } } as Entry], ['participant']);
    expect(lane.source).toBeUndefined();
    expect(lane.answer?.text).toBe('こんにちは');
    expect(lane.pending).toBe(false);
  });

  it('shows it whichever sides are shown, and leaves the user\u2019s own row a row', () => {
    const entry = { ...said('a', 'participant', 'こんにちは'), languages: { source: 'ja', target: 'ja' } } as Entry;
    expect(lanes([entry], ['participant'], { ...BOTH, participant: 'translation' })[0]).toMatchObject({ answer: { text: 'こんにちは' }, said: true });
    const row = lanes([said('p', 'participant', 'はい。', '好的。'), { ...entry, leg: 'speaker' } as Entry])[1];
    expect(row).toMatchObject({ shape: 'row', source: { text: 'こんにちは' } });
    expect(row.said).toBeUndefined();
  });

  it('takes a sentence in the language of the answers for its own answer, keeping the frame (fork)', () => {
    // Seen 2026-10-31: left to be detected, a side's Chinese stayed in the small line under the Korean before it, for good.
    const sentence = (id: string, text: string, language: string, final = true): Entry => ({ ...said(id, 'participant', ''), languages: { source: 'auto', target: 'zh-CN' }, source: [{ ...row(`s-${id}`, text, 'source', language), final }] } as Entry);
    const answered = { ...sentence('a', '네.', 'ko'), translation: [row('t-a', '好的。', 'translation')] } as Entry;
    const own = lanes([answered, sentence('b', '都睁开睡了。', 'zh')], ['participant'])[0];
    expect(own).toMatchObject({ answer: { text: '都睁开睡了。', language: 'zh' }, source: { text: '' }, said: true, pending: false });
    // While it is being heard it may yet be something else.
    expect(lanes([answered, sentence('b', '都睁开', 'zh', false)], ['participant'])[0]).toMatchObject({ answer: { text: '好的。' }, source: { text: '네. 都睁开' } });
    // What is said after it runs on over it, until that is answered.
    expect(lanes([answered, sentence('b', '都睁开睡了。', 'zh'), sentence('c', '오늘', 'ko', false)], ['participant'])[0]).toMatchObject({ answer: { text: '都睁开睡了。' }, source: { text: '오늘' }, pending: true });
  });

  const exchange = (id: string, text: string, translation: string, feedback?: string): Extract<Entry, { kind: 'exchange' }> => ({
    kind: 'exchange', id, leg: 'speaker', languages: { source: 'fr', target: 'en' }, pairing: 'stated', t: 0,
    source: [row(`s-${id}`, text, 'source', 'en')],
    translation: translation ? [{ ...row(`t-${id}`, translation, 'translation', 'fr'), purpose: 'translation' }] : [],
    ...(feedback ? { feedback: [{ ...row(`f-${id}`, feedback, 'translation', 'fr'), purpose: 'feedback', ...(translation ? { accompaniesTranslation: true as const } : {}) }] } : {}),
  });

  it('keeps feedback and its original sentence separate from the translated answer', () => {
    const entry = exchange('first', 'I goes.', 'Je vais.', 'I go.\nPresent tense.');
    const lane = lanes([entry], ['speaker'])[0];
    expect(lane.answer).toMatchObject({ text: 'Je vais.', purpose: 'translation' });
    expect(lane.feedback).toMatchObject({ text: 'I go.\nPresent tense.', origin: 'first', said: { text: 'I goes.', language: 'en' } });
    const without = lanes([{ ...entry, feedback: undefined }], ['speaker'])[0];
    expect(lane.answer).toEqual(without.answer);
    expect(lane.pending).toBe(without.pending);
    expect(lanesHeight([lane], 24)).toBeGreaterThan(lanesHeight([without], 24));
  });

  it('keeps late feedback in its own line, with its own sentence, and leaves the newer sentence\u2019s row as it is (fork)', () => {
    // It was not shown at all once the user had gone on (the user, 2026-11-18: keep it until the next comes).
    const first = exchange('first', 'I goes.', 'Je vais.');
    const second = exchange('second', 'We arrive tomorrow.', 'Nous arrivons demain.');
    const before = lanes([first, second]);
    const after = lanes([{ ...first, feedback: exchange('first', 'I goes.', '', 'I go.').feedback }, second]);
    expect({ ...after[1], feedback: undefined }).toEqual({ ...before[1], feedback: undefined });
    expect(after[1].source?.text).toBe('We arrive tomorrow.');
    expect(after[1].feedback).toMatchObject({ origin: 'first', text: 'I go.', said: { text: 'I goes.' } });
  });

  it('shows the feedback its clock holds, the shown sentence\u2019s own without one, and none from a sentence still waiting its turn (fork)', () => {
    const first = exchange('first', 'I goes.', 'Je vais.', 'I go.');
    const second = exchange('second', 'We arrive tomorrow.', 'Nous arrivons demain.', '✓');
    const row = (fed?: string, held: Record<string, string> = {}) => buildLanes([first, second], LEGS, BOTH, words, held, 0, fed)[1];
    expect(row().feedback?.origin).toBe('second');
    // The correction is not read yet: the tick for the next sentence waits.
    expect(row('first').feedback?.origin).toBe('first');
    expect(row('gone').feedback?.origin).toBe('second');
    // The row is still on the first sentence: the second's feedback is not shown before it.
    expect(row('second', { speaker: 'first' }).feedback?.origin).toBe('first');
  });

  it('binds feedback to the held translated exchange while the source line runs into newer speech', () => {
    const first = exchange('first', 'I goes.', 'Je vais.', 'I go.');
    const second = exchange('second', 'We arrive tomorrow.', 'Nous arrivons demain.', '✓');
    const [lane] = buildLanes([first, second], ['speaker'], BOTH, words, { speaker: 'first' });
    expect(lane.answer?.text).toBe('Je vais.');
    expect(lane.source?.text).toBe('I goes. We arrive tomorrow.');
    expect(lane.feedback).toMatchObject({ origin: 'first', text: 'I go.', said: { text: 'I goes.' } });
  });

  it('shows feedback without a translation and keeps it out of source-only and hidden lanes', () => {
    const entry = exchange('first', 'I goes.', '', 'I go.');
    expect(lanes([entry], ['speaker'])[0]).toMatchObject({ feedback: { text: 'I go.' }, answer: { text: '' } });
    expect(lanes([entry], ['speaker'], { ...BOTH, speaker: 'source' })[0].feedback).toBeUndefined();
    expect(lanes([entry], ['speaker'], { ...BOTH, speaker: 'none' })).toEqual([]);
  });

  it('advances from a native translation to standalone practice feedback, then back to a translation', () => {
    const first = exchange('native', 'Nous arrivons.', 'We arrive.');
    const practice = exchange('practice', 'I goes.', '', 'I go.');
    const nextNative = exchange('next-native', 'Nous partons.', 'We leave.');
    const [practiced] = buildLanes([first, practice], ['speaker'], BOTH, words);
    expect(practiced).toMatchObject({ source: { text: 'I goes.' }, answer: { text: '' }, feedback: { origin: 'practice', said: { text: 'I goes.' } }, pending: false });
    const [held] = buildLanes([first, practice, nextNative], ['speaker'], BOTH, words, { speaker: 'practice' });
    expect(held.feedback?.origin).toBe('practice');
    expect(held.answer?.text).toBe('');
    const [translated] = buildLanes([first, practice, nextNative], ['speaker'], BOTH, words);
    expect(translated).toMatchObject({ source: { text: 'Nous partons.' }, answer: { text: 'We leave.' }, pending: false });
    // Fork: the feedback stays in its line, with the sentence it is on, until the next comes.
    expect(translated.feedback).toMatchObject({ origin: 'practice', said: { text: 'I goes.' } });
  });

  it('does not advance a translated pair when combined feedback arrives before its translation', () => {
    const first = exchange('first', 'Nous arrivons.', 'We arrive.');
    const waiting = exchange('waiting', 'I goes.', '');
    const feedback = exchange('waiting', 'I goes.', '', 'I go.').feedback!.map((part) => ({ ...part, accompaniesTranslation: true as const }));
    const before = lanes([first, waiting], ['speaker'])[0];
    expect(lanes([first, { ...waiting, feedback }], ['speaker'])[0]).toEqual(before);
    const translated = exchange('waiting', 'I goes.', 'Je vais.');
    expect(lanes([first, { ...translated, feedback }], ['speaker'])[0]).toMatchObject({ answer: { text: 'Je vais.' }, feedback: { origin: 'waiting', said: { text: 'I goes.' } }, pending: false });
  });
});

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

  it('keeps each sentence’s language in a line that runs on, and puts a space after Hangul (fork)', () => {
    const entry = (id: string, text: string, language?: string): Entry => ({ ...said(id, 'participant', text), source: [row(`s-${id}`, text, 'source', language)], languages: { source: 'auto', target: 'zh-CN' } } as Entry);
    const lane = lanes([{ ...said('a', 'participant', '', '好的。'), source: [row('s-a', '네 좋아요', 'source', 'ko')], languages: { source: 'auto', target: 'zh-CN' } } as Entry, entry('b', '정말요', 'ko'), entry('c', '今天不行'), entry('d', 'こんにちは', 'ja')], ['participant'])[0];
    expect(lane.source?.text).toBe('네 좋아요 정말요 今天不行こんにちは');
    expect(lane.source?.pieces.map((piece) => piece.language)).toEqual(['ko', 'ko', 'auto', 'ja']);
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
    // A warning is not: the last sentence's translation stays (fork).
    const warning: Entry = { kind: 'notice', id: 'w', leg: 'participant', severity: 'warning', code: 'app_capture_lost_using_system_audio', message: 'The app capture stopped.', at: 1 };
    expect(lanes([said('a', 'participant', 'そうそう。', '对对。'), warning], ['participant'])[0].answer).toMatchObject({ text: '对对。' });
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

  it('gives the answer its readings and its romanization, on each of its lines (fork)', () => {
    const plain = lanesHeight(two, 24);
    expect(Math.abs(lanesHeight(two, 24, withAnswerAids(ROOMY, false, true)) - (plain + 2 * 24 * ROMAN_LINE))).toBeLessThan(1);
    expect(Math.abs(lanesHeight(two, 24, withAnswerAids(ROOMY, true, false)) - (plain + 2 * 24 * (READ_LINE - ROOMY.answerLine)))).toBeLessThan(1);
    // Squeezed to one line it is still the line and its romanization, whose room is not air to be given up.
    expect(spacingAt(1, withAnswerAids(ROOMY, false, true), withAnswerAids(TIGHT, false, true)).answerRoman).toBe(ROMAN_LINE);
    const answer = 24 * (ROOMY.answerLine + ROMAN_LINE);
    expect(linesFor(two, 24, answer, withAnswerAids(ROOMY, false, true)).answer).toBe(2);
    expect(linesFor(two, 24, answer + 24 * ROW_SCALE * ROOMY.rowLine, withAnswerAids(ROOMY, false, true)).answer).toBe(3);
  });

  it('keeps room under the row apart from the pair’s: a row with no romanization has none (fork)', () => {
    const plain = lanesHeight(two, 24);
    expect(Math.abs(lanesHeight(two, 24, withRoman(ROOMY, true, false)) - (plain + 24 * SOURCE_SCALE * ROMAN_LINE))).toBeLessThan(1);
    expect(spacingAt(0.5, withRoman(ROOMY, true, false), withRoman(TIGHT, true, false)).rowRoman).toBe(0);
    const row = 24 * ROW_SCALE * ROOMY.rowLine;
    expect(linesFor(two, 24, row, withRoman(ROOMY, true, false)).row).toBe(2);
  });
});

describe('a pair that holds the answer it shows', () => {
  const entries = [said('a', 'participant', 'そうそうそう。', '对对对。'), said('b', 'participant', 'それが好きなんですよ。', '我就是喜欢这个。'), said('c', 'participant', 'でも')];
  const build = (held: Partial<Record<LegName, string>>) => buildLanes(entries, ['participant'], BOTH, words, held)[0];

  it('shows the held sentence\u2019s answer, and goes on writing what is said after it', () => {
    expect(build({ participant: 'a' })).toMatchObject({ source: { text: 'そうそうそう。それが好きなんですよ。でも' }, answer: { text: '对对对。' }, pending: true });
    // Its turn over: the newest answered.
    expect(build({ participant: 'b' })).toMatchObject({ source: { text: 'それが好きなんですよ。でも' }, answer: { text: '我就是喜欢这个。' } });
    expect(build({})).toMatchObject({ answer: { text: '我就是喜欢这个。' } });
  });

  it('holds nothing that is not an answered sentence of the side; the user\u2019s own row shows the sentence its clock holds', () => {
    expect(build({ participant: 'gone' })).toMatchObject({ answer: { text: '我就是喜欢这个。' } });
    expect(build({ participant: 'c' })).toMatchObject({ answer: { text: '我就是喜欢这个。' } });
    const both = [...entries, said('m1', 'speaker', '一。', 'いち。'), said('m2', 'speaker', '二。', 'に。')];
    const row = (held: Record<string, string>) => buildLanes(both, LEGS, BOTH, words, held).find((lane) => lane.leg === 'speaker');
    expect(row({})).toMatchObject({ shape: 'row', source: { text: '二。' }, answer: { text: 'に。' } });
    // Fork: a row's sentences are taken in turn, by a clock of their own (`rowTurn`).
    expect(row({ speaker: 'm1' })).toMatchObject({ shape: 'row', source: { text: '一。' }, answer: { text: 'いち。' }, behind: true });
  });
});

describe('a sentence of the user’s translated into each of their languages (fork)', () => {
  // The user speaks Chinese; the other side Japanese, with English lit beside it.
  const spoke = (id: string, source: string, sourceLanguage: string | undefined, answers: Array<[text: string, language?: string]>): Entry => ({
    kind: 'exchange', id, leg: 'speaker', languages: { source: 'zh-CN', target: 'ja' }, pairing: 'stated',
    source: [row(`s-${id}`, source, 'source', sourceLanguage)],
    translation: answers.map(([text, language], i) => row(`t${i}-${id}`, text, 'translation', language)), t: 0,
  });
  const built = (entries: Entry[], also = 1, legs = LEGS) => buildLanes(entries, legs, BOTH, words, {}, also);
  const mine = (entries: Entry[], also = 1, legs = LEGS) => built(entries, also, legs).find((lane) => lane.leg === 'speaker')!;
  const texts = (lane: { answer?: { text: string }; more?: Array<{ text: string }> }) => [lane.answer?.text, ...(lane.more ?? []).map((text) => text.text)];

  it('has a line for each beyond the first from the start, the user’s own lane alone', () => {
    const [theirs, own] = built([]);
    expect(theirs.more).toBeUndefined();
    expect(own.more).toEqual([{ text: '', pieces: [] }]);
    expect(built([], 0)[1].more).toBeUndefined();
  });

  it('shows their main language first and their second after it', () => {
    const lane = mine([spoke('a', '今天天气真好', undefined, [['今日はいい天気ですね'], ['The weather is nice today', 'en']])]);
    expect(texts(lane)).toEqual(['今日はいい天気ですね', 'The weather is nice today']);
    expect(lane.answer!.language).toBe('ja');
    expect(lane.more![0].language).toBe('en');
  });

  it('gives each language its place whichever answer came first: said in their second, their main is not moved by the user’s own', () => {
    const first = mine([spoke('a', 'Nice weather', 'en', [['いい天気ですね', 'ja']])]);
    expect(texts(first)).toEqual(['', 'いい天気ですね']);
    const both = mine([spoke('a', 'Nice weather', 'en', [['いい天気ですね', 'ja'], ['天气真好', 'zh-CN']])]);
    expect(texts(both)).toEqual(['天气真好', 'いい天気ですね']);
    // Said in their main one: the user's own, then their second.
    expect(texts(mine([spoke('a', 'いい天気', 'ja', [['Nice weather', 'en'], ['天气真好', 'zh-CN']])]))).toEqual(['天气真好', 'Nice weather']);
  });

  it('keeps an answer of several rows together, and shows no more than it has lines for', () => {
    const entry = spoke('a', '你好', undefined, [['こんにちは']]);
    if (entry.kind === 'exchange') entry.translation = [row('t0-a', 'こん', 'translation'), { ...row('t0-a', 'にちは', 'translation'), key: 't0-a:1', start: 2 }, row('t1-a', 'Hello', 'translation', 'en'), row('t2-a', 'Bonjour', 'translation', 'fr')];
    expect(texts(mine([entry]))).toEqual(['こんにちは', 'Hello']);
    // Not told of a second language: the first by the run's order, as before.
    expect(texts(mine([entry], 0))).toEqual(['こんにちは']);
  });

  it('is laid out a small line higher as a row, a large line higher as a pair, squeezed or not (to the pixel a height is rounded up by)', () => {
    for (const spacing of [ROOMY, TIGHT]) {
      expect(lanesHeight(built([]), 24, spacing) - lanesHeight(built([], 0), 24, spacing)).toBeCloseTo(24 * ROW_SCALE * spacing.rowLine + spacing.inner, -0.5);
      expect(lanesHeight(built([], 1, ['speaker']), 24, spacing) - lanesHeight(built([], 0, ['speaker']), 24, spacing)).toBeCloseTo(24 * spacing.answerLine, -0.5);
    }
  });

  it('has its line in a pair\u2019s answer from the start, and is a box of its own under a row, whose lines are counted as before', () => {
    expect(linesFor(built([]), 24, 0)).toEqual({ source: 1, answer: 2, row: 1 });
    // A further line of the row is one for each of its boxes.
    const line = 24 * ROW_SCALE * ROOMY.rowLine;
    expect(linesFor(built([]), 24, line * 2 - 1).row).toBe(1);
    expect(linesFor(built([]), 24, line * 2).row).toBe(2);
    expect(linesFor(built([]), 24, 5000)).toEqual({ source: 3, answer: 6, row: 3 });
    expect(linesFor(built([], 1, ['speaker']), 24, 0)).toEqual({ source: 1, answer: 3, row: 1 });
    expect(linesFor(built([], 1, ['speaker']), 24, 5000)).toEqual({ source: 3, answer: 7, row: 1 });
  });

  it('is counted from what the user’s latest sentences have, for a strip not told the run’s languages', () => {
    expect(furtherIn([])).toBe(0);
    expect(furtherIn([said('a', 'speaker', '你好', 'こんにちは'), said('b', 'participant', 'はい', '好')])).toBe(0);
    expect(furtherIn([spoke('a', '你好', undefined, [['こんにちは'], ['Hello', 'en']]), said('b', 'speaker', '嗯')])).toBe(1);
  });
});

describe('a small line with readings above it and a romanization under it (fork)', () => {
  it('keeps its roomy line however the strip is squeezed, and only the lines asked for', () => {
    const tight = withRoman(TIGHT, true, true);
    expect(withSmallReads(tight, true, true)).toMatchObject({ sourceLine: ROOMY.sourceLine, rowLine: ROOMY.rowLine, roman: ROMAN_LINE, rowRoman: ROMAN_LINE });
    expect(withSmallReads(tight, false, true)).toMatchObject({ sourceLine: TIGHT.sourceLine, rowLine: ROOMY.rowLine });
    expect(withSmallReads(tight, false, false)).toEqual(tight);
    // A roomy strip is as it was, and one squeezed half-way has nothing lower than roomy to give back.
    expect(withSmallReads(ROOMY, true, true)).toEqual(ROOMY);
    const half = spacingAt(0.5, withSmallReads(ROOMY, true, true), withSmallReads(TIGHT, true, true));
    expect(half.sourceLine).toBe(ROOMY.sourceLine);
    expect(half.gap).toBeLessThan(ROOMY.gap);
  });
});

describe("the user's own row shows the sentence its clock holds (fork)", () => {
  const theirs = said('p', 'participant', 'はい。', '好的。');
  const first = said('a', 'speaker', '我想去咖啡店。', 'カフェに行きたいです。');
  const next = said('b', 'speaker', '听说蛋糕');
  const row = (entries: Entry[], held: Record<string, string> = {}) => buildLanes(entries, LEGS, BOTH, words, held)[1];

  it('is the newest where nothing is held, as it was', () => {
    expect(row([theirs, first, next])).toMatchObject({ shape: 'row', source: { text: '听说蛋糕' }, answer: { text: '' }, pending: true });
    expect(row([theirs, first, next]).behind).toBeUndefined();
  });

  it('keeps the sentence held with its answer, and says that more was said since', () => {
    expect(row([theirs, first, next], { speaker: 'a' })).toMatchObject({ source: { text: '我想去咖啡店。' }, answer: { text: 'カフェに行きたいです。' }, pending: false, behind: true });
    // Held and still waiting for its answer.
    const waiting = said('a', 'speaker', '我想去咖啡店。');
    expect(row([theirs, waiting, next], { speaker: 'a' })).toMatchObject({ source: { text: '我想去咖啡店。' }, answer: { text: '' }, pending: true, behind: true });
  });

  it('is the newest once that is what is held, or what is held is gone', () => {
    expect(row([theirs, first, next], { speaker: 'b' }).source?.text).toBe('听说蛋糕');
    expect(row([theirs, first, next], { speaker: 'gone' }).source?.text).toBe('听说蛋糕');
    expect(row([theirs, first, next], { speaker: 'b' }).behind).toBeUndefined();
  });

  it('holds nothing where what answers the user is not shown, or their lane is a pair', () => {
    expect(rowLegOf(LEGS, BOTH)).toBe('speaker');
    expect(rowLegOf(LEGS, { ...BOTH, speaker: 'source' })).toBeUndefined();
    expect(rowLegOf(LEGS, { ...BOTH, participant: 'none' })).toBeUndefined();
    expect(rowLegOf(['speaker'], BOTH)).toBeUndefined();
    const source = buildLanes([theirs, first, next], LEGS, { ...BOTH, speaker: 'source' }, words, { speaker: 'a' })[1];
    expect(source.source?.text).toBe('听说蛋糕');
    // Alone, the user's lane is a pair, and `held` is the answered sentence it shows, as before.
    expect(buildLanes([first, next], ['speaker'], BOTH, words, { speaker: 'a' })[0]).toMatchObject({ shape: 'pair', answer: { text: 'カフェに行きたいです。' }, source: { text: '我想去咖啡店。听说蛋糕' } });
  });
});

describe('the line for grammar feedback, kept (fork)', () => {
  const theirs = said('p', 'participant', 'はい。', '好的。');
  const mine = said('a', 'speaker', '我想去咖啡店。', 'カフェに行きたいです。');

  it('is in the user’s own lane from the start under grammar feedback, so that the strip is one height with it and without', () => {
    const empty = withFeedbackRoom(lanes([]), true);
    const spoken = withFeedbackRoom(lanes([theirs, mine]), true);
    expect(empty.map((lane) => !!lane.feedback)).toEqual([false, true]);
    expect(spoken[1].feedback).toMatchObject({ text: '', said: { text: '' } });
    expect(lanesHeight(empty, 24)).toBe(lanesHeight(spoken, 24));
    expect(lanesHeight(empty, 24)).toBeGreaterThan(lanesHeight(lanes([]), 24));
  });

  it('is not added without grammar feedback, where answers are not shown, or over feedback that is there', () => {
    expect(withFeedbackRoom(lanes([theirs, mine]), false)).toEqual(lanes([theirs, mine]));
    expect(withFeedbackRoom(lanes([theirs, mine], LEGS, { ...BOTH, speaker: 'source' }), true)[1].feedback).toBeUndefined();
    const fed = { ...mine, feedback: [{ ...row('f-a', 'I go.', 'translation'), purpose: 'feedback' as const, accompaniesTranslation: true as const }] } as Entry;
    expect(withFeedbackRoom(lanes([theirs, fed]), true)[1].feedback?.text).toBe('I go.');
  });
});

describe('the lines grammar feedback has (fork)', () => {
  it('is two roomy and one squeezed tight, so that a correction and its reason both show where there is room', () => {
    const fed = withFeedbackRoom(lanes([said('p', 'participant', 'はい。', '好的。'), said('a', 'speaker', '我想去咖啡店。', 'カフェに行きたいです。')]), true);
    const bare = lanes([said('p', 'participant', 'はい。', '好的。'), said('a', 'speaker', '我想去咖啡店。', 'カフェに行きたいです。')]);
    const line = (spacing: typeof ROOMY) => 24 * ROW_SCALE * spacing.rowLine;
    // Heights are whole pixels, rounded up.
    expect(Math.abs(lanesHeight(fed, 24) - lanesHeight(bare, 24) - (2 * line(ROOMY) + ROOMY.inner))).toBeLessThanOrEqual(1);
    expect(Math.abs(lanesHeight(fed, 24, TIGHT) - lanesHeight(bare, 24, TIGHT) - (line(TIGHT) + TIGHT.inner))).toBeLessThanOrEqual(1);
    expect(spacingAt(0.5).feedbackLines).toBe(1.5);
  });
});
